const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();

// PortOne (아임포트) API 키: Secret Manager에 등록해서 사용
//   firebase functions:secrets:set PORTONE_API_KEY
//   firebase functions:secrets:set PORTONE_API_SECRET
const PORTONE_API_KEY = defineSecret("PORTONE_API_KEY");
const PORTONE_API_SECRET = defineSecret("PORTONE_API_SECRET");
// 카카오 앱 ID(카카오 개발자 콘솔 > 앱 설정 > 요약 정보의 '앱 ID'). 설정하면 다른 앱에서 발급한 토큰을 거부한다.
const KAKAO_APP_ID = defineString("KAKAO_APP_ID", { default: "" });

const SECRETS = [PORTONE_API_KEY, PORTONE_API_SECRET];
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

        const customToken = await admin.auth().createCustomToken(String(kakaoId), { provider: "kakao" });
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
        if (payment.status !== "paid") { res.status(200).send("ignored: " + payment.status); return; }

        const db = admin.firestore();
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

        await resRef.create({
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
