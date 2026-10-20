// 파티 신청·승인·결제 (서버가 기준)
//
// 흐름: 고객이 신청서 제출(무료) → 관리자가 사진·소개를 보고 승인/거절 → 승인되면 결제 안내 문자
//       → 고객이 결제(서버가 금액 계산) → 포트원에서 결제를 직접 확인한 뒤 참가 확정 + 확정 문자.
// 미승인자는 결제한 적이 없으므로 환불할 일이 없고, 그래서 환불 계좌를 받지 않는다.
// 파티 정보(parties/{id})는 관리자가 관리자 페이지에서 직접 저장하고, 신청서·결제는 이 파일의 서버 로직만 쓴다.

const admin = require("firebase-admin");

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const PAY_WINDOW_MS = 48 * 60 * 60 * 1000;   // 승인 후 결제 기한
const MIN_AGE = 19;                          // 연 나이 기준(올해 - 출생연도). 술이 무료 제공되므로 청소년 불가
const MAX_PHOTOS = 3;
const KEEP_DAYS_AFTER_PARTY = 30;            // 파티 후 이 기간이 지나면 사진·생년월일·직업·인스타·소개를 파기
const SITE = "https://monory.kr";

class PartyError extends Error {}
const fail = (msg) => { throw new PartyError(msg); };

const GENDER_LABEL = { male: "남성", female: "여성" };
const STATUS_LABEL = { pending: "심사 중", approved: "승인·결제 대기", paid: "참가 확정", rejected: "미승인", cancelled: "취소" };

function str(v, max, label, { required = false, min = 0 } = {}) {
    const s = typeof v === "string" ? v.trim() : "";
    if (required && !s) fail(`${label}을(를) 입력해 주세요.`);
    if (s && s.length < min) fail(`${label}을(를) ${min}자 이상 입력해 주세요.`);
    if (s.length > max) fail(`${label}이(가) 너무 깁니다. (${max}자 이하)`);
    return s;
}

function formatPhone(raw) {
    const d = String(raw || "").replace(/[^0-9]/g, "");
    if (!/^010\d{7,8}$/.test(d)) fail("올바른 연락처를 입력해 주세요. ('-' 없이 숫자만)");
    return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

const kstYear = (ms) => new Date(ms + KST_OFFSET_MS).getUTCFullYear();

// 'YYYY-MM-DD' + 'HH:MM' (KST) → ms
function kstMs(date, time = "00:00") {
    const d = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const t = String(time || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!d || !t) return null;
    return Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]) - KST_OFFSET_MS;
}
const partyStartMs = (p) => kstMs(p.date, p.startTime || "00:00");

// 생년월일: 'YYYYMMDD' 또는 'YYYY-MM-DD' → 'YYYY-MM-DD'
function normalizeBirth(v, nowMs) {
    const m = String(v || "").replace(/[^0-9]/g, "").match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) fail("생년월일 8자리를 입력해 주세요. (예: 19970315)");
    const y = +m[1], mo = +m[2], d = +m[3];
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) fail("생년월일이 올바르지 않습니다.");
    const age = kstYear(nowMs) - y;
    if (age > 80 || age < 0) fail("생년월일이 올바르지 않습니다.");
    if (age < MIN_AGE) fail(`청소년은 참여할 수 없어요. (${kstYear(nowMs) - MIN_AGE}년생까지 참여 가능)`);
    return `${m[1]}-${m[2]}-${m[3]}`;
}

// 고객이 보낸 신청서를 검증하고 정리한다
function normalizeApplication(input, { uid, nowMs }) {
    const i = input || {};
    if (!["male", "female"].includes(i.gender)) fail("성별을 선택해 주세요.");
    const instagram = str(i.instagram, 40, "인스타그램 ID").replace(/^@+/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/\/.*$/, "");
    if (instagram && !/^[A-Za-z0-9._]{1,30}$/.test(instagram)) fail("인스타그램 ID는 영문·숫자·마침표·밑줄만 쓸 수 있어요.");
    const photos = Array.isArray(i.photos) ? i.photos : [];
    if (photos.length < 1) fail("사진을 1장 이상 올려 주세요.");
    if (photos.length > MAX_PHOTOS) fail(`사진은 ${MAX_PHOTOS}장까지 올릴 수 있어요.`);
    const prefix = `party_private/${uid}/`;
    for (const p of photos) {
        if (typeof p !== "string" || !p.startsWith(prefix) || p.length > 200 || p.includes("..")) fail("사진 정보가 올바르지 않습니다. 다시 올려 주세요.");
    }
    const c = i.consents || {};
    if (c.rules !== true) fail("참가 규칙에 동의해 주세요.");
    if (c.privacy !== true) fail("개인정보 수집·이용에 동의해 주세요.");
    return {
        gender: i.gender,
        name: str(i.name, 20, "이름", { required: true, min: 2 }),
        birth: normalizeBirth(i.birth, nowMs),
        phone: formatPhone(i.phone),
        job: str(i.job, 40, "직업", { required: true }),
        instagram,
        intro: str(i.intro, 500, "자기소개", { required: true, min: 10 }),
        photos,
        consents: { rules: true, privacy: true, agreedAt: admin.firestore.Timestamp.fromMillis(nowMs) },
    };
}

// 성별·신청 시각에 맞는 참가비. 얼리버드 가격이 있고 신청이 마감일(그날 23:59 KST) 이전이면 얼리버드 가격
function priceFor(party, gender, appliedAtMs) {
    const key = gender === "female" ? "Female" : "Male";
    const base = Number(party["price" + key]);
    if (!Number.isFinite(base) || base < 0) fail("참가비가 설정되지 않았습니다. 문의해 주세요.");
    const early = party["earlyPrice" + key];
    const until = party.earlyUntil ? kstMs(party.earlyUntil, "23:59") : null;
    if (early !== null && early !== undefined && early !== "" && Number(early) >= 0 && until && appliedAtMs <= until + 59999) {
        return { amount: Number(early), early: true };
    }
    return { amount: base, early: false };
}

const appId = (partyId, uid) => `${partyId}_${uid}`;

async function loadParty(db, partyId) {
    if (typeof partyId !== "string" || !/^[A-Za-z0-9_-]{1,60}$/.test(partyId)) fail("파티 정보가 올바르지 않습니다.");
    const snap = await db.collection("parties").doc(partyId).get();
    if (!snap.exists) fail("파티를 찾을 수 없습니다.");
    return { id: partyId, ...snap.data() };
}

// ── 신청서 제출 (심사 중인 신청서는 다시 제출하면 고쳐진다) ──
async function submitApplication(db, { uid, partyId, input, nowMs = Date.now() }) {
    const party = await loadParty(db, partyId);
    if (party.status !== "open") fail("지금은 신청을 받지 않는 파티입니다.");
    const start = partyStartMs(party);
    if (start !== null && nowMs >= start) fail("이미 시작한 파티입니다.");
    const a = normalizeApplication(input, { uid, nowMs });
    const ref = db.collection("party_applications").doc(appId(partyId, uid));
    const result = await db.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        if (cur.exists && cur.data().status !== "pending") {
            fail(`이미 신청한 파티입니다. (현재 상태: ${STATUS_LABEL[cur.data().status] || cur.data().status})`);
        }
        const now = admin.firestore.Timestamp.fromMillis(nowMs);
        if (cur.exists) {
            tx.update(ref, { ...a, updatedAt: now });
            return { updated: true, prevPhotos: cur.data().photos || [] };
        }
        tx.create(ref, {
            ...a, partyId, partyTitle: party.title || "", uid: String(uid),
            status: "pending", createdAt: now, updatedAt: now,
        });
        return { updated: false, prevPhotos: [] };
    });
    return { id: ref.id, party, application: a, ...result };
}

// ── 관리자: 승인 (이미 승인된 건을 다시 승인하면 결제 기한이 연장되고 안내 문자가 다시 간다) ──
async function approveApplication(db, { id, adminUid, nowMs = Date.now() }) {
    const ref = db.collection("party_applications").doc(String(id));
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) fail("신청서를 찾을 수 없습니다.");
        const a = snap.data();
        if (!["pending", "approved"].includes(a.status)) fail(`승인할 수 없는 상태입니다. (${STATUS_LABEL[a.status] || a.status})`);
        const pSnap = await tx.get(db.collection("parties").doc(a.partyId));
        if (!pSnap.exists) fail("파티를 찾을 수 없습니다.");
        const party = { id: a.partyId, ...pSnap.data() };
        const start = partyStartMs(party);
        if (start !== null && nowMs >= start) fail("이미 시작한 파티입니다.");
        const { amount, early } = priceFor(party, a.gender, a.createdAt.toMillis());
        const payDeadline = Math.min(nowMs + PAY_WINDOW_MS, start !== null ? start : Infinity);
        tx.update(ref, {
            status: "approved", amount, earlyPrice: early,
            approvedAt: admin.firestore.Timestamp.fromMillis(nowMs), approvedBy: String(adminUid),
            payDeadline: admin.firestore.Timestamp.fromMillis(payDeadline),
            updatedAt: admin.firestore.Timestamp.fromMillis(nowMs),
        });
        return { application: { ...a, amount, payDeadline }, party };
    });
}

// ── 관리자: 거절 (결제 전 신청만. 결제한 건은 취소·환불로 처리) ──
async function rejectApplication(db, { id, adminUid, nowMs = Date.now() }) {
    const ref = db.collection("party_applications").doc(String(id));
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) fail("신청서를 찾을 수 없습니다.");
        const a = snap.data();
        if (!["pending", "approved"].includes(a.status)) fail(`거절할 수 없는 상태입니다. (${STATUS_LABEL[a.status] || a.status}) 결제한 신청은 '취소·환불'로 처리해 주세요.`);
        tx.update(ref, {
            status: "rejected", rejectedAt: admin.firestore.Timestamp.fromMillis(nowMs), rejectedBy: String(adminUid),
            updatedAt: admin.firestore.Timestamp.fromMillis(nowMs),
        });
        return { application: a };
    });
}

// ── 결제 직전: 금액은 승인 때 서버가 정한 값. 정원이 이미 찼으면 결제를 막는다 ──
async function preparePayment(db, { uid, partyId, nowMs = Date.now() }) {
    const party = await loadParty(db, partyId);
    const ref = db.collection("party_applications").doc(appId(partyId, uid));
    const snap = await ref.get();
    if (!snap.exists) fail("신청 내역을 찾을 수 없습니다.");
    const a = snap.data();
    if (a.status === "paid") fail("이미 결제가 완료되었습니다.");
    if (a.status !== "approved") fail("승인된 신청만 결제할 수 있습니다.");
    if (a.payDeadline && nowMs > a.payDeadline.toMillis()) fail("결제 기한이 지났어요. 모노리로 문의해 주세요.");
    const start = partyStartMs(party);
    if (start !== null && nowMs >= start) fail("이미 시작한 파티입니다.");
    const cap = Number(a.gender === "female" ? party.capacityFemale : party.capacityMale) || 0;
    if (cap > 0) {
        const paid = await db.collection("party_applications")
            .where("partyId", "==", partyId).where("gender", "==", a.gender).where("status", "==", "paid").get();
        if (paid.size >= cap) fail(`${GENDER_LABEL[a.gender]} 정원이 모두 찼어요. 모노리로 문의해 주세요.`);
    }
    const merchantUid = "PRTY-" + nowMs;
    await db.collection("party_payments").doc(merchantUid).create({
        appId: ref.id, partyId, uid: String(uid), amount: a.amount, status: "open",
        createdAt: admin.firestore.Timestamp.fromMillis(nowMs),
    });
    return { merchantUid, amount: a.amount, title: party.title || "모노리 파티", name: a.name, phone: a.phone };
}

// ── 결제 후: 포트원 결제(서버가 직접 조회)와 저장해 둔 결제 준비 정보로 참가 확정 ──
//   paid / exists / no-intent / not-owner / payment-invalid / amount-mismatch / not-approved
async function settlePayment(db, { merchantUid, uid = null, payment = null, nowMs = Date.now() }) {
    const pRef = db.collection("party_payments").doc(String(merchantUid));
    const pSnap = await pRef.get();
    if (!pSnap.exists) return { result: "no-intent" };
    const it = pSnap.data();
    if (uid != null && String(it.uid) !== String(uid)) return { result: "not-owner" };
    const free = it.amount === 0;
    if (!free) {
        if (!payment || payment.status !== "paid" || payment.merchant_uid !== merchantUid) return { result: "payment-invalid" };
        if (Number(payment.amount) !== it.amount) return { result: "amount-mismatch", paid: Number(payment.amount), expected: it.amount };
    }
    const impUid = free ? "FREE-" + merchantUid : payment.imp_uid;
    const ref = db.collection("party_applications").doc(it.appId);
    const out = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return { result: "not-approved" };
        const a = snap.data();
        if (a.status === "paid") return { result: "exists", application: a };
        if (a.status !== "approved") return { result: "not-approved", application: a };
        tx.update(ref, {
            status: "paid", paidAt: admin.firestore.Timestamp.fromMillis(nowMs),
            paidAmount: it.amount, impUid, merchantUid,
            updatedAt: admin.firestore.Timestamp.fromMillis(nowMs),
        });
        tx.update(pRef, { status: "done", impUid });
        return { result: "paid", application: { ...a, paidAmount: it.amount } };
    });
    return { ...out, appId: it.appId, impUid };
}

// 포트원 콘솔 등에서 환불된 파티 결제를 신청서에 반영 (전액 환불이면 취소, 부분 환불이면 금액만 기록)
async function applyPortoneCancellation(db, payment, nowMs = Date.now()) {
    const pSnap = await db.collection("party_payments").doc(String(payment.merchant_uid)).get();
    if (!pSnap.exists) return { result: "no-intent" };
    const ref = db.collection("party_applications").doc(pSnap.data().appId);
    const cancelAmount = Number(payment.cancel_amount) || 0;
    const isFull = cancelAmount >= Number(payment.amount);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return { result: "no-application" };
        const a = snap.data();
        if (a.status === "cancelled") return { result: "already-cancelled" };
        if ((a.refundAmount || 0) === cancelAmount && !isFull) return { result: "already-recorded" };
        const upd = { refundAmount: cancelAmount, updatedAt: admin.firestore.Timestamp.fromMillis(nowMs) };
        if (isFull) Object.assign(upd, { status: "cancelled", cancelledAt: admin.firestore.Timestamp.fromMillis(nowMs), cancelReason: "결제대행사에서 환불 처리됨" });
        tx.update(ref, upd);
        return { result: isFull ? "cancelled" : "partial", application: a };
    });
}

// 파티별 신청 현황(성별 × 상태 개수)을 다시 세어 parties/{id}.counts 에 저장. 공개 화면의 "남은 자리" 표시에 쓴다
async function recountParty(db, partyId) {
    const snap = await db.collection("party_applications").where("partyId", "==", partyId).get();
    const counts = { male: { pending: 0, approved: 0, paid: 0 }, female: { pending: 0, approved: 0, paid: 0 } };
    snap.forEach((d) => {
        const a = d.data();
        if (counts[a.gender] && a.status in counts[a.gender]) counts[a.gender][a.status]++;
    });
    await db.collection("parties").doc(partyId).update({ counts, countsUpdatedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    return counts;
}

// 파티가 끝나고 KEEP_DAYS_AFTER_PARTY 일이 지나면 사진 파일과 민감한 항목을 지운다. 이름·성별·연락처·결제 기록은 남긴다
async function purgeOldApplications(db, bucket, nowMs = Date.now()) {
    const parties = await db.collection("parties").get();
    let purged = 0;
    for (const p of parties.docs) {
        const d = p.data();
        if (d.purgedAt) continue;
        const start = partyStartMs(d);
        if (start === null || nowMs < start + (KEEP_DAYS_AFTER_PARTY + 1) * 86400000) continue;
        const apps = await db.collection("party_applications").where("partyId", "==", p.id).get();
        for (const a of apps.docs) {
            for (const path of a.data().photos || []) await bucket.file(path).delete().catch(() => {});
            await a.ref.update({
                photos: [], birth: admin.firestore.FieldValue.delete(), job: admin.firestore.FieldValue.delete(),
                instagram: admin.firestore.FieldValue.delete(), intro: admin.firestore.FieldValue.delete(),
                purgedAt: admin.firestore.Timestamp.fromMillis(nowMs),
            });
            purged++;
        }
        await p.ref.update({ purgedAt: admin.firestore.Timestamp.fromMillis(nowMs) });
    }
    return purged;
}

// ── 문구 ────────────────────────────────────────────────────
const won = (n) => (Number(n) || 0).toLocaleString("ko-KR") + "원";
const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

function partyWhen(p) {
    const m = String(p.date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return p.date || "-";
    const dow = WEEKDAY_KO[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
    return `${+m[2]}월 ${+m[3]}일 (${dow}) ${p.startTime || ""}${p.endTime ? "~" + p.endTime : ""}`.trim();
}

function fmtDeadline(ms) {
    const k = new Date(ms + KST_OFFSET_MS);
    return `${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일 ${String(k.getUTCHours()).padStart(2, "0")}:${String(k.getUTCMinutes()).padStart(2, "0")}`;
}

const partyLink = (p) => `${SITE}/party.html?p=${encodeURIComponent(p.id)}`;

function approvedText(a, p, contact) {
    return [
        `[모노리] ${p.title || "파티"} 참가 신청이 승인되었습니다!`,
        "",
        `${a.name}님, 함께하게 되어 반가워요.`,
        `■ 일시: ${partyWhen(p)}`,
        `■ 참가비: ${won(a.amount)}`,
        `■ 결제 기한: ${fmtDeadline(a.payDeadline)}까지`,
        "",
        "아래 링크에서 결제하시면 참가가 확정됩니다.",
        partyLink(p),
        "",
        `문의 ${contact}`,
    ].join("\n");
}

function rejectedText(a, p, contact) {
    return [
        `[모노리] ${a.name}님, ${p.title || "파티"}에 관심 가져 주셔서 감사합니다.`,
        "",
        "아쉽게도 이번 파티는 인원·성비 구성상 함께하기 어렵게 되었습니다.",
        "결제된 금액은 없으며, 다음 파티에서 꼭 다시 만나요.",
        "",
        `문의 ${contact}`,
    ].join("\n");
}

function paidText(a, p, contact, address) {
    return [
        `[모노리] ${p.title || "파티"} 참가가 확정되었습니다.`,
        "",
        `■ 일시: ${partyWhen(p)}`,
        `■ 장소: ${p.place || address}`,
        `■ 결제: ${won(a.paidAmount)}`,
        "",
        "당일 입장 방법은 파티 전날 다시 안내드릴게요.",
        "※ 개인 사정으로 인한 취소·환불은 신청 화면의 규정을 따릅니다.",
        `문의 ${contact}`,
    ].join("\n");
}

function cancelledText(a, p, contact, refundAmount) {
    return [
        `[모노리] ${p.title || "파티"} 참가가 취소되었습니다.`,
        "",
        refundAmount > 0 ? `■ 환불 금액: ${won(refundAmount)}\n(카드사에 따라 영업일 기준 3~7일 소요)` : "환불 관련 내용은 아래 번호로 문의해 주세요.",
        `문의 ${contact}`,
    ].join("\n");
}

function newApplicationMessage(a, p, updated) {
    const age = a.birth ? `${String(a.birth).slice(2, 4)}년생` : "";
    return [
        `🎉 [모노리 파티] ${updated ? "신청서 수정" : "새 신청"} — ${p.title || p.id}`,
        "",
        `${a.name} / ${GENDER_LABEL[a.gender]} / ${age} / ${a.job}`,
        a.instagram ? `인스타 @${a.instagram}` : "인스타 없음",
        "",
        "관리자 페이지 > 파티 관리에서 승인/거절해 주세요.",
    ].join("\n");
}

function paidMessage(a, p) {
    return `💳 [모노리 파티] 참가 확정 — ${p.title || p.id}\n${a.name} / ${GENDER_LABEL[a.gender]} / ${won(a.paidAmount)}`;
}

module.exports = {
    PartyError, MIN_AGE, PAY_WINDOW_MS, KEEP_DAYS_AFTER_PARTY, GENDER_LABEL, STATUS_LABEL,
    normalizeApplication, normalizeBirth, priceFor, partyStartMs, kstMs, appId, loadParty,
    submitApplication, approveApplication, rejectApplication, preparePayment, settlePayment,
    applyPortoneCancellation, recountParty, purgeOldApplications,
    approvedText, rejectedText, paidText, cancelledText, newApplicationMessage, paidMessage, partyWhen,
};
