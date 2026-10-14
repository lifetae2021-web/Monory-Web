const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");
const axios = require("axios");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const points = require("./points");
const notify = require("./notify");
const sms = require("./sms");
const slots = require("./slots");
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { applyPortoneCancellation: applyCancellation } = require("./cancellation");

admin.initializeApp();

// PortOne (아임포트) API 키: Secret Manager에 등록해서 사용
//   firebase functions:secrets:set PORTONE_API_KEY
//   firebase functions:secrets:set PORTONE_API_SECRET
const PORTONE_API_KEY = defineSecret("PORTONE_API_KEY");
const PORTONE_API_SECRET = defineSecret("PORTONE_API_SECRET");
// 카카오 앱 ID(카카오 개발자 콘솔 > 앱 설정 > 요약 정보의 '앱 ID'). 설정하면 다른 앱에서 발급한 토큰을 거부한다.
const KAKAO_APP_ID = defineString("KAKAO_APP_ID", { default: "" });

const SECRETS = [PORTONE_API_KEY, PORTONE_API_SECRET];
// 텔레그램 알림: BotFather 에서 만든 봇 토큰과, 알림을 받을 대화방 ID
const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = defineSecret("TELEGRAM_CHAT_ID");
const TELEGRAM_SECRETS = [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID];
// 고객 문자(솔라피)
const SOLAPI_API_KEY = defineSecret("SOLAPI_API_KEY");
const SOLAPI_API_SECRET = defineSecret("SOLAPI_API_SECRET");
const NOTIFY_SECRETS = [...TELEGRAM_SECRETS, SOLAPI_API_KEY, SOLAPI_API_SECRET];
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// ── 공통 헬퍼 ───────────────────────────────────────────────

async function getPortoneToken() {
    const resp = await axios.post("https://api.iamport.kr/users/getToken", {
        imp_key: PORTONE_API_KEY.value(),
        imp_secret: PORTONE_API_SECRET.value(),
    });
    if (resp.data.code !== 0) {
        throw new Error(`PortOne 토큰 발급 실패: ${resp.data.message}`);
    }
    return resp.data.response.access_token;
}

async function getPortonePayment(impUid, token) {
    const resp = await axios.get(`https://api.iamport.kr/payments/${encodeURIComponent(impUid)}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.data.code !== 0) {
        throw new Error(`결제 조회 실패: ${resp.data.message}`);
    }
    return resp.data.response;
}

// 예약 날짜 문자열('26.10.22 (목)' 또는 '2026년 10월 22일')을 KST 자정 기준 Date(UTC 표현)로 변환
function parseReservationDate(str) {
    if (!str) return null;
    let m = str.match(/(\d{4})년 (\d+)월 (\d+)일/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) - KST_OFFSET_MS;
    m = str.match(/(\d{2})\.(\d{2})\.(\d{2})/);
    if (m) return Date.UTC(2000 + (+m[1]), +m[2] - 1, +m[3]) - KST_OFFSET_MS;
    return null;
}

// KST 달력 기준 날짜 차이(이용일 - 오늘)
function daysUntil(useDateMs, nowMs) {
    const kstDay = (ms) => Math.floor((ms + KST_OFFSET_MS) / 86400000);
    return kstDay(useDateMs) - kstDay(nowMs);
}

// 약관 제6조 환불 규정
//  - 결제 후 1시간 이내 취소: 100% (단, 이용일 1일 전 및 당일 결제 건 제외)
//  - 이용일 8일 전까지: 100% / 7~4일 전: 50% / 3일 전~당일: 환불 불가
function calcRefundRate(resData, nowMs) {
    const useMs = parseReservationDate(resData.date);
    if (useMs === null) return { rate: 0, reason: "예약 날짜를 확인할 수 없습니다." };

    const createdMs = resData.createdAt && resData.createdAt.toMillis ? resData.createdAt.toMillis() : null;
    const daysAtPayment = createdMs !== null ? daysUntil(useMs, createdMs) : 0;
    if (createdMs !== null && nowMs - createdMs <= 60 * 60 * 1000 && daysAtPayment >= 2) {
        return { rate: 1, label: "결제 후 1시간 이내" };
    }

    const d = daysUntil(useMs, nowMs);
    if (d >= 8) return { rate: 1, label: "이용일 8일 전까지" };
    if (d >= 4) return { rate: 0.5, label: "이용일 7~4일 전" };
    return { rate: 0, label: "이용일 3일 전~당일" };
}

// ── 1. 카카오 로그인 → Firebase 커스텀 토큰 ─────────────────
// 클라이언트가 보낸 카카오 액세스 토큰을 카카오 서버로 검증한 뒤, uid = 카카오 회원번호인 토큰 발급.
// (Firestore 규칙의 members/{uid}.role 조회, 예약 소유자 비교가 이 uid를 기준으로 동작한다)
// 로그인 토큰에 넣을 권한 표식. 관리자 권한(members.role)이 있으면 admin: true 를 넣어
// Storage 규칙이 "관리자만 파일 쓰기"를 판단할 수 있게 한다. (권한을 바꾼 뒤에는 다시 로그인해야 반영된다)
async function buildLoginClaims(uid) {
    const claims = { provider: "kakao" };
    try {
        const m = await admin.firestore().collection("members").doc(uid).get();
        if (m.exists && ["super_admin", "admin", "general_admin"].includes(m.data().role)) claims.admin = true;
    } catch (e) {
        console.warn("로그인 권한 표식 조회 실패(일반 회원으로 처리):", e.message);
    }
    return claims;
}
exports.buildLoginClaims = buildLoginClaims;

exports.kakaoLogin = onCall(async (request) => {
    const accessToken = request.data && request.data.accessToken;
    if (!accessToken || typeof accessToken !== "string") {
        throw new HttpsError("invalid-argument", "카카오 액세스 토큰이 필요합니다.");
    }
    try {
        const headers = { Authorization: `Bearer ${accessToken}` };

        const appId = KAKAO_APP_ID.value();
        if (appId) {
            const info = await axios.get("https://kapi.kakao.com/v1/user/access_token_info", { headers });
            if (String(info.data.app_id) !== String(appId)) {
                throw new HttpsError("permission-denied", "허용되지 않은 카카오 앱의 토큰입니다.");
            }
        }

        const me = await axios.get("https://kapi.kakao.com/v2/user/me", { headers });
        const kakaoId = me.data && me.data.id;
        if (!kakaoId) throw new HttpsError("unauthenticated", "카카오 사용자 정보를 확인할 수 없습니다.");

        const claims = await buildLoginClaims(String(kakaoId));
        const customToken = await admin.auth().createCustomToken(String(kakaoId), claims);
        return { customToken };
    } catch (e) {
        if (e instanceof HttpsError) throw e;
        console.error("kakaoLogin error:", e.response ? e.response.data : e.message);
        throw new HttpsError("unauthenticated", "카카오 인증에 실패했습니다.");
    }
});

// ── 2. 예약 취소 + 환불 (약관 제6조 반영) ───────────────────
exports.cancelReservation = onCall({ secrets: SECRETS }, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
    }
    const uid = request.auth.uid;

    const { reservationId, reason = "고객 요청 취소" } = request.data || {};
    if (!reservationId || typeof reservationId !== "string") {
        throw new HttpsError("invalid-argument", "예약 ID가 제공되지 않았습니다.");
    }

    const db = admin.firestore();
    const resRef = db.collection("reservations").doc(reservationId);

    try {
        const resDoc = await resRef.get();
        if (!resDoc.exists) throw new HttpsError("not-found", "예약 내역을 찾을 수 없습니다.");
        const resData = resDoc.data();

        if (String(resData.kakaoUid) !== String(uid)) {
            throw new HttpsError("permission-denied", "해당 예약을 취소할 권한이 없습니다.");
        }
        if (resData.status === "cancelled") {
            throw new HttpsError("failed-precondition", "이미 취소된 예약입니다.");
        }
        if (resData.status !== "paid") {
            throw new HttpsError("failed-precondition", "취소할 수 없는 예약 상태입니다.");
        }

        const { rate, label, reason: blockReason } = calcRefundRate(resData, Date.now());
        if (rate === 0) {
            throw new HttpsError(
                "failed-precondition",
                blockReason || `환불 규정상 환불이 불가한 시점입니다(${label}). 고객센터로 문의해 주세요.`
            );
        }

        const paidAmount = Number(resData.totalAmount) || 0;
        const refundAmount = Math.floor(paidAmount * rate);
        const impUid = resData.impUid;
        const isFree = !impUid || String(impUid).startsWith("FREE-") || paidAmount === 0;

        if (!isFree && refundAmount > 0) {
            const token = await getPortoneToken();
            const cancelResp = await axios.post(
                "https://api.iamport.kr/payments/cancel",
                {
                    imp_uid: impUid,
                    reason,
                    amount: refundAmount,
                    checksum: paidAmount, // 취소 가능 금액(이중 취소 방지)
                },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            if (cancelResp.data.code !== 0) {
                throw new HttpsError("internal", `결제 취소 실패: ${cancelResp.data.message}`);
            }
        }

        await resRef.update({
            status: "cancelled",
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            cancelReason: reason,
            refundRate: rate,
            refundAmount,
        });

        // 사용한 포인트는 환불 비율만큼 복구 (서버 기록 기준, 예약 문서의 값은 신뢰하지 않음)
        let pointsRestored = 0;
        if (resData.merchantUid) {
            const r = await points.releaseHold(db, {
                merchantUid: resData.merchantUid, rate,
                memo: rate === 1 ? "예약 취소로 포인트 복구" : `예약 취소로 포인트 일부 복구 (환불 ${Math.round(rate * 100)}%)`,
            }).catch((e) => { console.warn("포인트 복구 실패:", e.message); return { restored: 0 }; });
            pointsRestored = r.restored;
        }

        // 전액 환불 시에만 사용한 쿠폰 복구
        if (rate === 1 && resData.usedCoupon && resData.usedCoupon.id && resData.kakaoUid) {
            await db.collection("members").doc(String(resData.kakaoUid))
                .collection("coupons").doc(resData.usedCoupon.id)
                .update({ status: "active", isUsed: false, usedAt: admin.firestore.FieldValue.delete() })
                .catch((e) => console.warn("쿠폰 복구 실패:", e.message));
        }

        return {
            success: true,
            refundRate: rate,
            refundAmount,
            pointsRestored,
            message: rate === 1
                ? "전액 환불 및 예약 취소가 완료되었습니다."
                : `환불 규정(${label})에 따라 ${refundAmount.toLocaleString()}원이 환불되며 예약이 취소되었습니다.`,
        };
    } catch (error) {
        console.error("Cancel Reservation Error:", error.response ? error.response.data : error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "예약 취소 중 서버 오류가 발생했습니다.");
    }
});

// ── 3. 결제 상태 조회 (모바일 복귀 시 클라이언트가 호출) ────
exports.checkPaymentStatus = onCall({ secrets: SECRETS }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

    const { impUid, merchantUid } = request.data || {};
    if (!impUid && !merchantUid) {
        throw new HttpsError("invalid-argument", "결제 정보가 제공되지 않았습니다.");
    }
    try {
        const token = await getPortoneToken();
        const url = impUid
            ? `https://api.iamport.kr/payments/${encodeURIComponent(impUid)}`
            : `https://api.iamport.kr/payments/find/${encodeURIComponent(merchantUid)}`;
        const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
        if (resp.data.code !== 0) {
            throw new HttpsError("not-found", `결제 정보 조회 실패: ${resp.data.message}`);
        }
        const p = resp.data.response;
        return {
            success: true,
            status: p.status,
            data: { imp_uid: p.imp_uid, merchant_uid: p.merchant_uid, amount: p.amount, status: p.status },
        };
    } catch (e) {
        console.error("Payment Check Error:", e.response ? e.response.data : e);
        if (e instanceof HttpsError) throw e;
        throw new HttpsError("internal", "결제 상태 확인 중 서버 오류가 발생했습니다.");
    }
});

// ── 4. 포트원 웹훅: 결제는 됐는데 브라우저에서 예약 저장이 안 된 경우 서버가 복구 ──
// 포트원 콘솔 > 결제 연동 > 결제알림(Webhook) 에 이 함수 URL을 등록해야 동작한다.
// 클라이언트가 IMP.request_pay의 custom_data에 예약 정보를 실어 보낸다.
exports.portoneWebhook = onRequest({ secrets: SECRETS }, async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }
    const impUid = req.body && req.body.imp_uid;
    if (!impUid) { res.status(400).send("imp_uid required"); return; }

    try {
        const token = await getPortoneToken();
        // 웹훅 본문은 신뢰하지 않고 포트원 API로 다시 조회해서 판단한다
        const payment = await getPortonePayment(impUid, token);
        const db = admin.firestore();

        // 포트원 콘솔 등에서 환불/취소된 결제는 웹사이트 예약에도 반영한다
        if (Number(payment.cancel_amount) > 0) {
            const r = await applyCancellation(db, payment);
            console.log("포트원 환불 웹훅 처리:", impUid, JSON.stringify(r));
            res.status(200).send("cancel: " + r.result);
            return;
        }
        if (payment.status !== "paid") { res.status(200).send("ignored: " + payment.status); return; }

        const resRef = db.collection("reservations").doc(impUid);
        const existing = await resRef.get();
        if (existing.exists) { res.status(200).send("already saved"); return; }

        // 클라이언트가 이미 add()로 저장했는지(구버전 호환) 확인
        const dup = await db.collection("reservations").where("impUid", "==", impUid).limit(1).get();
        if (!dup.empty) { res.status(200).send("already saved"); return; }

        let b = {};
        try { b = JSON.parse(payment.custom_data || "{}"); } catch (e) { b = {}; }
        if (!b.date || !b.guestName) {
            console.error("웹훅: custom_data 없음 → 수동 확인 필요", impUid, payment.merchant_uid);
            await db.collection("payment_alerts").doc(impUid).set({
                impUid, merchantUid: payment.merchant_uid, amount: payment.amount,
                buyerName: payment.buyer_name || null, reason: "paid_without_reservation",
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            res.status(200).send("alert recorded");
            return;
        }
        if (Number(b.totalAmount) !== Number(payment.amount)) {
            console.error("웹훅: 금액 불일치", impUid, b.totalAmount, payment.amount);
            await db.collection("payment_alerts").doc(impUid).set({
                impUid, merchantUid: payment.merchant_uid, amount: payment.amount,
                claimedAmount: b.totalAmount, reason: "amount_mismatch",
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            res.status(200).send("amount mismatch");
            return;
        }

        const holdSnap = await db.collection("point_holds").doc(payment.merchant_uid).get();
        const pointUsed = holdSnap.exists ? holdSnap.data().amount : 0;

        await resRef.create({
            approvalStatus: "pending",
            usagePurpose: b.usagePurpose || "",
            visitSource: Array.isArray(b.visitSource) ? b.visitSource : [],
            pointUsed,
            kakaoUid: b.kakaoUid || null,
            kakaoName: b.kakaoName || null,
            bookingType: b.bookingType || "personal",
            companyName: b.companyName || null,
            guestName: b.guestName,
            phone: b.phone || "",
            requests: b.requests || "",
            date: b.date,
            guestCount: b.guestCount || 0,
            packageKey: b.packageKey || null,
            packageName: b.packageName || null,
            totalAmount: Number(payment.amount),
            usedCoupon: b.usedCoupon || null,
            reviewPromise: !!b.reviewPromise,
            reservationMode: b.reservationMode || "package",
            startTime: b.startTime ?? null,
            endTime: b.endTime ?? null,
            totalHours: b.totalHours ?? null,
            isWeekend: !!b.isWeekend,
            impUid,
            merchantUid: payment.merchant_uid,
            status: "paid",
            source: "webhook",
            createdAt: admin.firestore.Timestamp.now(),
        });

        if (b.usedCoupon && b.usedCoupon.id && b.kakaoUid) {
            await db.collection("members").doc(String(b.kakaoUid)).collection("coupons").doc(b.usedCoupon.id)
                .update({ status: "used", isUsed: true, usedAt: admin.firestore.Timestamp.now() })
                .catch((e) => console.warn("웹훅 쿠폰 처리 실패:", e.message));
        }
        res.status(200).send("saved");
    } catch (e) {
        console.error("portoneWebhook error:", e.response ? e.response.data : e);
        res.status(500).send("error");
    }
});


// ── 5. 포인트 ────────────────────────────────────────────────
const ADMIN_ROLES = ["super_admin", "admin", "general_admin"];

async function assertAdmin(request) {
    if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
    if (request.auth.token.email) return; // 이메일 로그인 관리자(최고 관리자 대행)
    const m = await admin.firestore().collection("members").doc(String(request.auth.uid)).get();
    if (!m.exists || !ADMIN_ROLES.includes(m.data().role)) {
        throw new HttpsError("permission-denied", "관리자 권한이 필요합니다.");
    }
}

// 결제 직전 포인트 선차감. 결제 실패/중단 시 releasePoints 또는 스케줄러가 복구한다.
exports.reservePoints = onCall(async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
    const { amount, merchantUid } = request.data || {};
    if (typeof merchantUid !== "string" || !/^MNRY-\d+$/.test(merchantUid)) {
        throw new HttpsError("invalid-argument", "결제 정보가 올바르지 않습니다.");
    }
    try {
        const r = await points.reservePoints(admin.firestore(), {
            uid: request.auth.uid, merchantUid, amount: Number(amount),
        });
        return { success: true, balance: r.balance };
    } catch (e) {
        throw new HttpsError("failed-precondition", e.message);
    }
});

// 결제 실패/취소 시 선차감한 포인트 복구 (본인 + 아직 예약이 저장되지 않은 건만)
exports.releasePoints = onCall(async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
    const { merchantUid } = request.data || {};
    if (typeof merchantUid !== "string") throw new HttpsError("invalid-argument", "결제 정보가 올바르지 않습니다.");

    const db = admin.firestore();
    const hold = await db.collection("point_holds").doc(merchantUid).get();
    if (!hold.exists) return { success: true, restored: 0 };
    if (String(hold.data().uid) !== String(request.auth.uid)) {
        throw new HttpsError("permission-denied", "권한이 없습니다.");
    }
    const saved = await db.collection("reservations").where("merchantUid", "==", merchantUid).limit(1).get();
    if (!saved.empty) return { success: true, restored: 0 }; // 결제가 완료된 건은 취소 흐름으로만 복구
    const r = await points.releaseHold(db, { merchantUid, rate: 1, memo: "결제 취소로 포인트 복구" });
    return { success: true, restored: r.restored };
});

// 관리자: 예약 상태 변경. 이용완료 시 결제금액의 5% 적립, 관리자 취소 시 사용 포인트 전액 복구.
exports.setReservationStatus = onCall(async (request) => {
    await assertAdmin(request);
    const { reservationId, newStatus } = request.data || {};
    if (typeof reservationId !== "string" || !["completed", "cancelled"].includes(newStatus)) {
        throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
    }
    const db = admin.firestore();
    const resRef = db.collection("reservations").doc(reservationId);

    const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(resRef);
        if (!snap.exists) throw new HttpsError("not-found", "예약을 찾을 수 없습니다.");
        const r = snap.data();
        if (r.status !== "paid") {
            throw new HttpsError("failed-precondition", "결제완료 상태의 예약만 변경할 수 있습니다.");
        }
        let earned = 0;
        if (newStatus === "completed") {
            earned = (await points.earnForReservation(db, tx, resRef, r)).earned;
        }
        tx.update(resRef, { status: newStatus, updatedAt: admin.firestore.Timestamp.now() });
        return { merchantUid: r.merchantUid, earned };
    });

    let restored = 0;
    if (newStatus === "cancelled" && result.merchantUid) {
        restored = (await points.releaseHold(db, {
            merchantUid: result.merchantUid, rate: 1, memo: "관리자 예약 취소로 포인트 복구",
        })).restored;
    }
    return { success: true, earned: result.earned, restored };
});

// 관리자: 이용완료 후 환불이 생겼을 때 환불금액의 5%만큼 적립 포인트 회수
exports.clawbackPoints = onCall(async (request) => {
    await assertAdmin(request);
    const { reservationId, refundAmount } = request.data || {};
    if (typeof reservationId !== "string" || !(Number(refundAmount) > 0)) {
        throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
    }
    try {
        const r = await points.clawbackPoints(admin.firestore(), { reservationId, refundAmount: Number(refundAmount) });
        return { success: true, ...r };
    } catch (e) {
        throw new HttpsError("failed-precondition", e.message);
    }
});

// 결제 중 선차감만 되고 예약이 저장되지 않은 건(탭 닫기 등)을 30분마다 정리
exports.releaseStalePointHolds = onSchedule("every 30 minutes", async () => {
    const db = admin.firestore();
    const cutoff = Date.now() - 60 * 60 * 1000;
    const held = await db.collection("point_holds").where("status", "==", "held").get();
    for (const doc of held.docs) {
        if (doc.data().createdAt.toMillis() > cutoff) continue;
        const saved = await db.collection("reservations").where("merchantUid", "==", doc.id).limit(1).get();
        if (!saved.empty) {
            await doc.ref.update({ status: "confirmed" });
        } else {
            await points.releaseHold(db, { merchantUid: doc.id, rate: 1, memo: "결제 미완료로 포인트 자동 복구" })
                .catch((e) => console.warn("포인트 자동 복구 실패:", doc.id, e.message));
        }
    }
});

// ── 6. 환불 동기화(웹훅 보완) ────────────────────────────────
// 포트원 V1 은 콘솔에서 직접 취소할 때 웹훅을 보내지 않는 경우가 있어서, 30분마다 결제완료/이용완료 예약을
// 포트원에 조회해 환불된 건을 사이트에도 반영한다. (이미 반영된 건은 건드리지 않는다)
exports.reconcilePortoneCancellations = onSchedule({ schedule: "every 30 minutes", secrets: SECRETS }, async () => {
    const db = admin.firestore();
    const snap = await db.collection("reservations").where("status", "in", ["paid", "completed"]).get();
    const targets = snap.docs.filter((d) => String(d.data().impUid || "").startsWith("imp_"));
    if (!targets.length) return;

    const token = await getPortoneToken();
    let applied = 0;
    for (const doc of targets) {
        try {
            const payment = await getPortonePayment(doc.data().impUid, token);
            if (Number(payment.cancel_amount) > 0) {
                const r = await applyCancellation(db, payment);
                if (r.result === "cancelled" || r.result === "partial") {
                    applied++;
                    console.log("환불 동기화:", doc.id, JSON.stringify(r));
                }
            }
        } catch (e) {
            console.warn("환불 동기화 조회 실패:", doc.id, e.message);
        }
    }
    console.log(`환불 동기화 완료: 점검 ${targets.length}건, 반영 ${applied}건`);
});


// ── 7. 예약 알림(텔레그램) ───────────────────────────────────
// Firestore 가 서울(asia-northeast3)에 있어서 트리거도 같은 지역에 둔다.
// 알림 전송이 실패해도 예약 처리에는 영향이 없도록 오류는 로그만 남기고 삼킨다.
async function pushTelegram(text) {
    try {
        await notify.sendTelegram(TELEGRAM_BOT_TOKEN.value(), TELEGRAM_CHAT_ID.value(), text);
    } catch (e) {
        console.error("텔레그램 알림 실패:", e.response ? JSON.stringify(e.response.data) : e.message);
    }
}

exports.notifyNewReservation = onDocumentCreated(
    { document: "reservations/{resId}", region: "asia-northeast3", secrets: TELEGRAM_SECRETS },
    async (event) => {
        const r = event.data && event.data.data();
        if (!r || r.status !== "paid") return;
        await pushTelegram(notify.newReservationMessage(r));
    }
);

// 고객 문자 발송. 실패해도 예약 처리에는 영향 없고, 대표님께 텔레그램으로 알려 직접 연락할 수 있게 한다.
async function pushSms(r, text, label) {
    try {
        await sms.sendSms({ apiKey: SOLAPI_API_KEY.value(), apiSecret: SOLAPI_API_SECRET.value(), to: r.phone, text });
        return true;
    } catch (e) {
        const reason = e.response ? JSON.stringify(e.response.data) : e.message;
        console.error(`고객 문자 실패(${label}):`, reason);
        await pushTelegram(`⚠️ [모노리] 고객 문자 발송 실패 (${label})\n${r.guestName || "-"} / ${r.phone || "-"}\n직접 연락이 필요합니다.\n사유: ${String(reason).slice(0, 150)}`);
        return false;
    }
}

// 확정/전날 안내 문구 템플릿 (system_state/sms_templates: { confirm, reminder }). 없으면 기본 문구.
async function loadSmsTemplates() {
    try {
        const d = await admin.firestore().collection("system_state").doc("sms_templates").get();
        return d.exists ? d.data() : {};
    } catch (e) {
        console.warn("문자 템플릿 조회 실패:", e.message);
        return {};
    }
}

exports.notifyCancelledReservation = onDocumentUpdated(
    { document: "reservations/{resId}", region: "asia-northeast3", secrets: NOTIFY_SECRETS },
    async (event) => {
        const before = event.data.before.data();
        const after = event.data.after.data();
        if (!before || !after || before.status === "cancelled" || after.status !== "cancelled") return;
        await pushTelegram(notify.cancelledMessage(after));
        // 승인 거절은 거절 안내 문구, 그 외 취소는 취소 안내 문구
        await pushSms(after, after.rejected ? sms.rejectedText(after) : sms.cancelledText(after), after.rejected ? "승인 거절" : "예약 취소");
    }
);

// 승인(대기 → 승인) 시 예약 확정 문자
exports.notifyApprovedReservation = onDocumentUpdated(
    { document: "reservations/{resId}", region: "asia-northeast3", secrets: NOTIFY_SECRETS },
    async (event) => {
        const before = event.data.before.data();
        const after = event.data.after.data();
        if (!before || !after) return;
        if (before.approvalStatus === "approved" || after.approvalStatus !== "approved") return;
        if (after.status !== "paid" || after.confirmSmsSentAt) return;
        const tpl = await loadSmsTemplates();
        const ok = await pushSms(after, sms.approvedText(after, tpl.confirm), "예약 확정");
        if (ok) await event.data.after.ref.update({ confirmSmsSentAt: admin.firestore.FieldValue.serverTimestamp() });
    }
);


// ── 8. 예약 승인 / 거절 ──────────────────────────────────────
// 결제 후 예약은 "승인 대기"(approvalStatus: pending)로 들어오고, 관리자가 승인하면 확정 문자가 나간다.
// approvalStatus 가 없는 예전 예약은 확정된 것으로 본다.
exports.approveReservation = onCall(async (request) => {
    await assertAdmin(request);
    const { reservationId } = request.data || {};
    if (typeof reservationId !== "string") throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");
    const ref = admin.firestore().collection("reservations").doc(reservationId);
    await admin.firestore().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError("not-found", "예약을 찾을 수 없습니다.");
        const r = snap.data();
        if (r.status !== "paid") throw new HttpsError("failed-precondition", "결제완료 상태의 예약만 승인할 수 있습니다.");
        if (r.approvalStatus === "approved") throw new HttpsError("failed-precondition", "이미 승인된 예약입니다.");
        tx.update(ref, {
            approvalStatus: "approved",
            approvedAt: admin.firestore.FieldValue.serverTimestamp(),
            approvedBy: String(request.auth.uid),
        });
    });
    return { success: true };
});

// 승인 거절: 포트원에서 전액 환불 + 예약 취소 + 포인트/쿠폰 복구. (고객 문자는 취소 트리거가 보낸다)
exports.rejectReservation = onCall({ secrets: SECRETS }, async (request) => {
    await assertAdmin(request);
    const { reservationId, reason = "운영 사정으로 승인 거절" } = request.data || {};
    if (typeof reservationId !== "string") throw new HttpsError("invalid-argument", "요청이 올바르지 않습니다.");

    const db = admin.firestore();
    const ref = db.collection("reservations").doc(reservationId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "예약을 찾을 수 없습니다.");
    const r = snap.data();
    if (r.status !== "paid") throw new HttpsError("failed-precondition", "결제완료 상태의 예약만 거절할 수 있습니다.");
    if (r.approvalStatus === "approved") throw new HttpsError("failed-precondition", "이미 승인된 예약은 '예약취소'로 처리해 주세요.");

    const paid = Number(r.totalAmount) || 0;
    const impUid = r.impUid;
    const isFree = !impUid || String(impUid).startsWith("FREE-") || paid === 0;

    try {
        if (!isFree) {
            const token = await getPortoneToken();
            const resp = await axios.post(
                "https://api.iamport.kr/payments/cancel",
                { imp_uid: impUid, reason, amount: paid, checksum: paid },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            if (resp.data.code !== 0) throw new HttpsError("internal", `환불 실패: ${resp.data.message}`);
        }
    } catch (e) {
        console.error("승인 거절 환불 오류:", e.response ? e.response.data : e);
        if (e instanceof HttpsError) throw e;
        throw new HttpsError("internal", "환불 처리 중 오류가 발생했습니다. 포트원에서 확인해 주세요.");
    }

    await ref.update({
        status: "cancelled",
        rejected: true,
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        cancelReason: reason,
        refundRate: 1,
        refundAmount: paid,
        refundSource: "admin-reject",
    });

    // 사용한 포인트/쿠폰 복구 (전액 환불이므로 전부)
    let pointsRestored = 0;
    if (r.merchantUid) {
        pointsRestored = (await points.releaseHold(db, { merchantUid: r.merchantUid, rate: 1, memo: "승인 거절로 포인트 복구" })
            .catch((e) => { console.warn("포인트 복구 실패:", e.message); return { restored: 0 }; })).restored;
    }
    if (r.usedCoupon && r.usedCoupon.id && r.kakaoUid) {
        await db.collection("members").doc(String(r.kakaoUid)).collection("coupons").doc(r.usedCoupon.id)
            .update({ status: "active", isUsed: false, usedAt: admin.firestore.FieldValue.delete() })
            .catch((e) => console.warn("쿠폰 복구 실패:", e.message));
    }
    return { success: true, refundAmount: paid, pointsRestored };
});

// ── 9. 이용 전날 리마인더 문자 (매일 오전 10시) ───────────────
exports.sendReservationReminders = onSchedule(
    { schedule: "0 10 * * *", timeZone: "Asia/Seoul", secrets: NOTIFY_SECRETS },
    async () => {
        const db = admin.firestore();
        const snap = await db.collection("reservations").where("status", "==", "paid").get();
        const now = Date.now();
        const tpls = await loadSmsTemplates();
        let sent = 0;
        for (const doc of snap.docs) {
            const r = doc.data();
            if (r.approvalStatus !== "approved" || r.reminderSentAt) continue;
            const useMs = parseReservationDate(r.date);
            if (useMs === null || daysUntil(useMs, now) !== 1) continue;
            if (await pushSms(r, sms.reminderText(r, tpls.reminder), "전날 안내")) {
                await doc.ref.update({ reminderSentAt: admin.firestore.FieldValue.serverTimestamp() });
                sent++;
            }
        }
        console.log(`전날 안내 문자: ${sent}건 발송`);
    }
);


// ── 10. 문자 잔액 부족 알림 ──────────────────────────────────
// 솔라피 잔액이 LOW_BALANCE_WON 미만이면 텔레그램으로 알린다. 같은 상태에서는 하루에 한 번만 알리고,
// 충전해서 기준 이상으로 돌아오면 다음에 또 떨어질 때 다시 알린다.
const LOW_BALANCE_WON = 1000;

exports.checkSmsBalance = onSchedule(
    { schedule: "every 3 hours", timeZone: "Asia/Seoul", secrets: NOTIFY_SECRETS },
    async () => {
        const stateRef = admin.firestore().collection("system_state").doc("solapi_balance");
        let balance;
        try {
            balance = await sms.getBalance({ apiKey: SOLAPI_API_KEY.value(), apiSecret: SOLAPI_API_SECRET.value() });
        } catch (e) {
            console.error("솔라피 잔액 조회 실패:", e.response ? JSON.stringify(e.response.data) : e.message);
            return;
        }
        const state = (await stateRef.get()).data() || {};
        if (balance >= LOW_BALANCE_WON) {
            if (state.alertedAt) await stateRef.set({ alertedAt: null, balance, checkedAt: admin.firestore.FieldValue.serverTimestamp() });
            return;
        }
        const last = state.alertedAt && state.alertedAt.toMillis ? state.alertedAt.toMillis() : 0;
        if (Date.now() - last < 24 * 60 * 60 * 1000) return; // 24시간 안에 이미 알림
        await pushTelegram(`⚠️ [모노리] 문자 잔액 부족\n현재 잔액 ${balance.toLocaleString("ko-KR")}원 (기준 ${LOW_BALANCE_WON.toLocaleString("ko-KR")}원 미만)\n솔라피에서 충전해 주세요. 소개팅 서비스와 잔액을 함께 쓰고 있어요.`);
        await stateRef.set({ alertedAt: admin.firestore.FieldValue.serverTimestamp(), balance, checkedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
);


// ── 11. 청소 보증금 환급 계좌 자동 파기 ──────────────────────
// 이용일로부터 REFUND_ACCOUNT_KEEP_DAYS 일이 지났거나, 예약이 없어졌거나 취소된 계좌 정보는 매일 새벽에 삭제한다.
const REFUND_ACCOUNT_KEEP_DAYS = 14;

exports.cleanupRefundAccounts = onSchedule({ schedule: "0 4 * * *", timeZone: "Asia/Seoul" }, async () => {
    const db = admin.firestore();
    const snap = await db.collection("reservation_private").get();
    const now = Date.now();
    let removed = 0;
    for (const doc of snap.docs) {
        const res = await db.collection("reservations").doc(doc.id).get();
        let expired = false;
        if (!res.exists || res.data().status === "cancelled") {
            expired = true;
        } else {
            const useMs = parseReservationDate(res.data().date);
            expired = useMs !== null && now > useMs + (REFUND_ACCOUNT_KEEP_DAYS + 1) * 86400000;
        }
        if (expired) { await doc.ref.delete(); removed++; }
    }
    console.log(`환급 계좌 파기: ${removed}건 (전체 ${snap.size}건)`);
});


// ── 12. 예약 가능 시간(공개) 동기화 ───────────────────────────
// reservations 가 생기거나 상태가 바뀌면 booked_slots(날짜·시간만 있는 공개 데이터)를 맞춰 둔다.
// 결제완료/이용완료 예약만 남기고, 취소·삭제되면 지운다.
exports.syncBookedSlot = onDocumentWritten(
    { document: "reservations/{resId}", region: "asia-northeast3" },
    async (event) => {
        const db = admin.firestore();
        const ref = db.collection("booked_slots").doc(slots.slotId(event.params.resId));
        const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
        const slot = slots.slotFromReservation(after);
        if (!slot) {
            if (after && ["paid", "completed"].includes(after.status)) {
                console.warn("예약 시간을 계산할 수 없어 공개 슬롯을 만들지 못했습니다:", event.params.resId);
            }
            await ref.delete().catch(() => {});
            return;
        }
        await ref.set({ ...slot, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
);
