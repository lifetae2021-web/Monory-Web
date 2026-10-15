// 예약 요금 계산·검증·확정 (서버가 기준)
//
// 흐름: 고객 브라우저 → prepareBooking(예약 내용) → 서버가 요금을 직접 계산하고 booking_intents 에 저장
//       → 브라우저는 "서버가 알려준 금액"으로만 결제 → confirmBooking(또는 포트원 웹훅) → 서버가 포트원에서
//       결제 금액을 직접 확인한 뒤, 저장해 둔 예약 내용으로만 reservations 를 만든다.
// 브라우저가 보낸 금액·할인은 어디에서도 믿지 않는다. 요금표를 바꾸려면 이 파일의 상수만 고치면 된다.

const admin = require("firebase-admin");
const slots = require("./slots");

// ── 요금표 (index.html 의 화면 표시용 요금표와 같은 값이어야 한다) ──
const PACKAGE_PRICES = {
    day:      { weekday: 70000,  weekend: 100000 },
    night:    { weekday: 100000, weekend: 150000 },
    allnight: { weekday: 150000, weekend: 220000 },
};
const PKG_LABELS = {
    day: "데이 패키지 (10:00~17:00)",
    night: "나이트 패키지 (18:00~24:00)",
    allnight: "올나잇 패키지 (18:00~익일 09:00)",
};
const EXTRA_PERSON_PRICE = 10000;
const BASE_PERSON_COUNT = 8;
const MAX_GUESTS = 20;
const REVIEW_PROMISE_DISCOUNT = 10000;
// 추가 옵션: 파티션 사용(1회 고정), 청소 대행(인원 구간별). 쿠폰 할인은 옵션 금액에는 적용하지 않는다
const PARTITION_PRICE = 20000;
const CLEANING_PRICE_TIERS = [{ upTo: 10, price: 50000 }, { upTo: 20, price: 100000 }];
const cleaningPrice = (guests) => (CLEANING_PRICE_TIERS.find((t) => guests <= t.upTo) || CLEANING_PRICE_TIERS[CLEANING_PRICE_TIERS.length - 1]).price;
const HOURLY = { FIRST: 10, GRID_LAST: 33, MIN: 3, MAX: 24, LAST_END: 57 };
const CLEANING_BUFFER = 1;
const MAX_ADVANCE_DAYS = 90;
const POINT_MIN_USE = 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

class BookingError extends Error {}
const fail = (msg) => { throw new BookingError(msg); };

// 금·토·일은 주말 요금 (달력 날짜 기준이라 시간대와 무관)
function isWeekendDate(y, m, d) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return dow === 0 || dow === 5 || dow === 6;
}

function hourlyRate(hour, weekend) {
    if (weekend) return 30000;
    if (hour >= 18) return 25000;
    return 15000;
}

function todayKst(nowMs) {
    const k = new Date(nowMs + KST_OFFSET_MS);
    return { y: k.getUTCFullYear(), m: k.getUTCMonth() + 1, d: k.getUTCDate() };
}
const dayNumber = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / 86400000);

function str(v, max, label, { required = false } = {}) {
    const s = typeof v === "string" ? v.trim() : "";
    if (required && !s) fail(`${label}을(를) 입력해 주세요.`);
    if (s.length > max) fail(`${label}이(가) 너무 깁니다.`);
    return s;
}

// 고객이 보낸 예약 내용을 검증하고 정리한다. 요금·할인은 여기서 정하지 않는다.
function normalizeInput(input, nowMs) {
    const i = input || {};
    const bookingType = i.bookingType === "corporate" ? "corporate" : "personal";
    const guestName = str(i.guestName, 30, "예약자 성함", { required: true });
    const phoneDigits = str(i.phone, 20, "연락처", { required: true }).replace(/[^0-9]/g, "");
    if (!/^010\d{7,8}$/.test(phoneDigits)) fail("올바른 연락처를 입력해 주세요. ('-' 없이 숫자만)");
    // 저장은 보기 쉬운 010-XXXX-XXXX 형태로 통일한다
    const phone = phoneDigits.length === 11 ? `${phoneDigits.slice(0, 3)}-${phoneDigits.slice(3, 7)}-${phoneDigits.slice(7)}` : `${phoneDigits.slice(0, 3)}-${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6)}`;
    const companyName = bookingType === "corporate" ? str(i.companyName, 60, "회사명", { required: true }) : null;
    const requests = str(i.requests, 1000, "요청사항");
    const usagePurpose = str(i.usagePurpose, 200, "사용 용도", { required: true });
    const visitSource = Array.isArray(i.visitSource) ? i.visitSource.filter((v) => typeof v === "string").map((v) => v.trim().slice(0, 30)).filter(Boolean).slice(0, 10) : [];
    if (!visitSource.length) fail("방문 경로를 한 가지 이상 선택해 주세요.");

    // 청소 대행과 보증금은 별도이므로 환급 계좌는 항상 받는다
    const refundBank = str(i.refundBank, 30, "환급 은행", { required: true });
    const refundAccount = str(i.refundAccount, 20, "환급 계좌번호", { required: true });
    const refundHolder = str(i.refundHolder, 30, "환급 예금주", { required: true });
    if (refundAccount.length < 8) fail("환급 계좌번호를 정확히 입력해 주세요.");
    const refund = { bank: refundBank, account: refundAccount, holder: refundHolder };

    const guestCount = Number(i.guestCount);
    if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > MAX_GUESTS) fail(`인원은 1~${MAX_GUESTS}명까지 가능합니다.`);

    const dm = String(i.date || "").match(/(\d{2})\.(\d{2})\.(\d{2})/);
    if (!dm) fail("예약 날짜가 올바르지 않습니다.");
    const y = 2000 + Number(dm[1]), m = Number(dm[2]), d = Number(dm[3]);
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) fail("예약 날짜가 올바르지 않습니다.");
    const diff = dayNumber(y, m, d) - dayNumber(...Object.values(todayKst(nowMs)));
    if (diff < 0 || diff > MAX_ADVANCE_DAYS) fail("예약할 수 없는 날짜입니다.");
    const yy = String(y).slice(2), mm = String(m).padStart(2, "0"), dd = String(d).padStart(2, "0");
    const date = `${yy}.${mm}.${dd} (${WEEKDAY_KO[probe.getUTCDay()]})`;
    const weekend = isWeekendDate(y, m, d);

    let reservationMode, packageKey, packageName, startTime = null, endTime = null, totalHours = null, range;
    if (i.reservationMode === "hourly") {
        reservationMode = "hourly";
        startTime = Number(i.startTime); endTime = Number(i.endTime);
        if (!Number.isInteger(startTime) || !Number.isInteger(endTime)) fail("이용 시간이 올바르지 않습니다.");
        totalHours = endTime - startTime;
        if (startTime < HOURLY.FIRST || startTime > HOURLY.GRID_LAST || totalHours < HOURLY.MIN || totalHours > HOURLY.MAX || endTime > HOURLY.LAST_END) fail("이용 시간이 올바르지 않습니다.");
        packageKey = "hourly";
        packageName = `시간제 (${startTime}시~${endTime}시)`;
        range = [startTime, endTime];
    } else {
        reservationMode = "package";
        if (!PACKAGE_PRICES[i.packageKey]) fail("패키지를 선택해 주세요.");
        packageKey = i.packageKey;
        packageName = PKG_LABELS[packageKey];
        range = slots.PKG_HOURS[packageKey];
    }

    return {
        bookingType, guestName, phone, companyName, requests, usagePurpose, visitSource,
        refund,
        guestCount, date, dateParts: { y, m, d }, weekend,
        reservationMode, packageKey, packageName, startTime, endTime, totalHours, range,
        reviewPromise: i.reviewPromise === true,
        optPartition: i.optPartition === true,
        optCleaning: i.optCleaning === true,
        saveProfile: i.saveProfile === true,
        couponId: typeof i.couponId === "string" && i.couponId && i.couponId !== "none" ? i.couponId : null,
        pointRequest: Math.max(0, Math.floor(Number(i.pointUsed) || 0)),
    };
}

// 이용 요금(할인 전) = 패키지/시간제 요금 + 추가 인원 요금
function basePrice(b) {
    let base;
    if (b.reservationMode === "hourly") {
        base = 0;
        for (let h = b.startTime; h < b.endTime; h++) base += hourlyRate(h % 24, b.weekend);
    } else {
        base = b.weekend ? PACKAGE_PRICES[b.packageKey].weekend : PACKAGE_PRICES[b.packageKey].weekday;
    }
    const extra = b.guestCount > BASE_PERSON_COUNT ? (b.guestCount - BASE_PERSON_COUNT) * EXTRA_PERSON_PRICE : 0;
    const optPartition = b.optPartition ? PARTITION_PRICE : 0;
    const optCleaning = b.optCleaning ? cleaningPrice(b.guestCount) : 0;
    return { base, extra, total: base + extra, optPartition, optCleaning, options: optPartition + optCleaning };
}

function couponExpiry(c) {
    for (const k of ["expireAt", "expiryDate"]) {
        const v = c[k];
        if (v && typeof v.toDate === "function") return v.toDate();
        if (v) { const d = new Date(v); if (!isNaN(d)) return d; }
    }
    return null;
}

// 서버에 저장된 쿠폰으로 할인액 계산 (본인 쿠폰함의 사용 가능한 쿠폰만)
function couponDiscount(c, baseTotal, nowMs) {
    if (!c || c.status !== "active" || c.isUsed === true) fail("사용할 수 없는 쿠폰입니다.");
    const exp = couponExpiry(c);
    const unlimited = c.isUnlimited === true || c.couponId === "WELCOME_10K" || (exp && exp.getFullYear() >= 2099);
    if (!unlimited && !(exp && exp.getTime() > nowMs)) fail("유효기간이 지난 쿠폰입니다.");
    const rate = Number(c.discountRate) || (c.discountType === "percent" ? Number(c.discountValue) || 0 : 0);
    const amount = Number(c.discountAmount) || (c.discountType === "fixed" ? Number(c.discountValue) || 0 : 0);
    const discount = rate > 0 ? Math.floor(baseTotal * (rate / 100)) : amount;
    return { discount: Math.max(0, Math.min(discount, baseTotal)), rate, amount };
}

// 요금 전체 계산. coupon 은 DB 에서 읽은 쿠폰 데이터(없으면 null)
function quote(b, coupon, nowMs) {
    const p = basePrice(b);
    let couponOff = 0, usedCoupon = null;
    if (b.couponId) {
        const c = couponDiscount(coupon, p.total, nowMs);
        couponOff = c.discount;
        usedCoupon = { id: b.couponId, name: coupon.name || coupon.title || "쿠폰", discount: c.amount, rate: c.rate };
    }
    const reviewOff = b.reviewPromise ? REVIEW_PROMISE_DISCOUNT : 0;
    const total = Math.max(0, p.total - couponOff - reviewOff) + p.options;
    let pointUse = Math.min(b.pointRequest, total);
    if (pointUse < POINT_MIN_USE) pointUse = 0;
    return { base: p.base, extra: p.extra, optPartition: p.optPartition, optCleaning: p.optCleaning, couponOff, reviewOff, total, pointUse, amount: total - pointUse, usedCoupon };
}

// 정리 시간(앞뒤 1시간)까지 포함해 기존 예약과 겹치는지. slotDocs: booked_slots 문서 데이터 배열
function hasConflict(slotDocs, parts, range) {
    const [start, end] = range;
    const base = dayNumber(parts.y, parts.m, parts.d);
    return slotDocs.some((s) => {
        if (s.y == null || s.start == null || s.end == null) return false;
        const off = dayNumber(s.y, s.m, s.d) - base;
        const bs = s.start + off * 24, be = s.end + off * 24;
        return start < be + CLEANING_BUFFER && bs - CLEANING_BUFFER < end;
    });
}

async function loadSlots(db) {
    const snap = await db.collection("booked_slots").get();
    return snap.docs.map((d) => d.data());
}

const newMerchantUid = (nowMs) => "MNRY-" + nowMs;

// ── 결제 직전: 요금 계산 + 예약 내용 저장 (포인트 선차감은 호출부에서) ──
async function createIntent(db, { uid, input, nowMs = Date.now(), memberName = null }) {
    const b = normalizeInput(input, nowMs);
    const slotDocs = await loadSlots(db);
    if (hasConflict(slotDocs, b.dateParts, b.range)) fail("선택하신 시간에 이미 예약이 있습니다. 다른 날짜/시간을 선택해 주세요.");

    let coupon = null;
    if (b.couponId) {
        const cs = await db.collection("members").doc(String(uid)).collection("coupons").doc(b.couponId).get();
        if (!cs.exists) fail("사용할 수 없는 쿠폰입니다.");
        coupon = cs.data();
    }
    const q = quote(b, coupon, nowMs);
    const merchantUid = newMerchantUid(nowMs);
    const intent = {
        uid: String(uid), status: "open", merchantUid, amount: q.amount, pointUsed: q.pointUse,
        usedCoupon: q.usedCoupon, refund: b.refund, saveProfile: b.saveProfile,
        reservation: {
            kakaoUid: Number(uid), kakaoName: memberName || b.guestName,
            bookingType: b.bookingType, companyName: b.companyName, guestName: b.guestName, phone: b.phone,
            requests: b.requests, date: b.date, guestCount: b.guestCount,
            packageKey: b.packageKey, packageName: b.packageName,
            usagePurpose: b.usagePurpose, visitSource: b.visitSource, reviewPromise: b.reviewPromise,
            reservationMode: b.reservationMode, startTime: b.startTime, endTime: b.endTime, totalHours: b.totalHours,
            isWeekend: b.weekend,
            optPartition: b.optPartition, optCleaning: b.optCleaning, optionsAmount: q.optPartition + q.optCleaning,
        },
        range: b.range, dateParts: b.dateParts,
        createdAt: admin.firestore.Timestamp.fromMillis(nowMs),
    };
    await db.collection("booking_intents").doc(merchantUid).create(intent);
    return { merchantUid, amount: q.amount, pointUsed: q.pointUse, quote: q, intent };
}

// ── 결제 후: 저장해 둔 예약 내용으로 예약 문서 만들기 ──
// payment: 포트원에서 서버가 직접 조회한 결제(무료 예약이면 null). 결과로 "무슨 일이 있었는지"만 돌려준다.
//   created / exists / no-intent / not-owner / payment-invalid / amount-mismatch / conflict
async function finalizeIntent(db, { merchantUid, uid = null, impUid = null, payment = null, nowMs = Date.now() }) {
    const intentRef = db.collection("booking_intents").doc(String(merchantUid));
    const snap = await intentRef.get();
    if (!snap.exists) return { result: "no-intent" };
    const it = snap.data();
    if (uid != null && String(it.uid) !== String(uid)) return { result: "not-owner" };

    const free = it.amount === 0;
    let resId;
    if (free) {
        resId = "FREE-" + merchantUid;
    } else {
        if (!payment || payment.status !== "paid" || payment.merchant_uid !== merchantUid) return { result: "payment-invalid" };
        if (Number(payment.amount) !== it.amount) return { result: "amount-mismatch", paid: Number(payment.amount), expected: it.amount, impUid: payment.imp_uid };
        resId = payment.imp_uid;
    }
    const resRef = db.collection("reservations").doc(resId);
    if ((await resRef.get()).exists) return { result: "exists", id: resId };

    // 사용하기로 한 포인트가 아직 차감된 상태인지 확인 (그 사이 복구됐다면 이 결제는 예약으로 인정하지 않는다)
    if (it.pointUsed > 0) {
        const hold = await db.collection("point_holds").doc(merchantUid).get();
        if (!hold.exists || hold.data().status === "released") return { result: "hold-lost", id: resId };
    }

    // 결제하는 사이 다른 예약이 들어왔는지 한 번 더 확인
    if (hasConflict(await loadSlots(db), it.dateParts, it.range)) return { result: "conflict", id: resId, impUid: free ? null : resId };

    try {
        await resRef.create({
            ...it.reservation,
            approvalStatus: "pending",
            pointUsed: it.pointUsed || 0,
            usedCoupon: it.usedCoupon || null,
            totalAmount: it.amount,
            impUid: resId,
            merchantUid,
            status: "paid",
            source: "server",
            createdAt: admin.firestore.Timestamp.fromMillis(nowMs),
        });
    } catch (e) {
        if (e.code === 6 || /already exists/i.test(e.message)) return { result: "exists", id: resId };
        throw e;
    }

    const warn = (what) => (e) => console.warn(`예약 후처리 실패(${what}):`, merchantUid, e.message);
    if (it.usedCoupon && it.usedCoupon.id) {
        await db.collection("members").doc(String(it.uid)).collection("coupons").doc(it.usedCoupon.id)
            .update({ status: "used", isUsed: true, usedAt: admin.firestore.Timestamp.fromMillis(nowMs) }).catch(warn("쿠폰"));
    }
    if (it.pointUsed > 0) {
        await db.collection("point_holds").doc(merchantUid).update({ status: "confirmed" }).catch(warn("포인트"));
    }
    if (it.refund && it.refund.account) {
        await db.collection("reservation_private").doc(resId).set({
            reservationId: resId, kakaoUid: Number(it.uid),
            bank: it.refund.bank, account: it.refund.account, holder: it.refund.holder,
            createdAt: admin.firestore.Timestamp.fromMillis(nowMs),
        }).catch(warn("환급계좌"));
    }
    // 고객이 "다음 예약에 쓰도록 저장"을 선택했으면 이름·연락처·방문 경로·환급 계좌를 본인 전용 문서에 저장한다.
    // 선택하지 않았다면 이전에 저장해 둔 정보는 삭제한다(저장 해제). 이 문서는 본인과 서버만 접근한다.
    const profileRef = db.collection("members").doc(String(it.uid)).collection("booking_profile").doc("default");
    if (it.saveProfile) {
        await profileRef.set({
            name: it.reservation.guestName, phone: it.reservation.phone, visitSource: it.reservation.visitSource || [],
            bank: it.refund ? it.refund.bank : "", account: it.refund ? it.refund.account : "", holder: it.refund ? it.refund.holder : "",
            updatedAt: admin.firestore.Timestamp.fromMillis(nowMs),
        }).catch(warn("저장 정보"));
    } else {
        await profileRef.delete().catch(warn("저장 정보 삭제"));
    }
    await intentRef.update({ status: "done", refund: admin.firestore.FieldValue.delete(), reservationId: resId }).catch(warn("intent"));
    return { result: "created", id: resId };
}

module.exports = {
    PACKAGE_PRICES, PKG_LABELS, HOURLY, PARTITION_PRICE, cleaningPrice, REVIEW_PROMISE_DISCOUNT, POINT_MIN_USE,
    BookingError, normalizeInput, basePrice, quote, couponDiscount, hasConflict, isWeekendDate, hourlyRate,
    createIntent, finalizeIntent,
};
