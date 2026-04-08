const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();

// PortOne (아임포트) API Key & Secret
// 실제 환경에서는 Firebase Secret Manager 또는 환경 변수(Functions Config)를 통해 관리하는 것이 안전합니다.
// 예: const PORTONE_API_KEY = process.env.PORTONE_API_KEY;
const PORTONE_API_KEY = process.env.PORTONE_API_KEY || "YOUR_PORTONE_API_KEY";
const PORTONE_API_SECRET = process.env.PORTONE_API_SECRET || "YOUR_PORTONE_API_SECRET";

exports.cancelReservation = onCall(async (request) => {
    // 1. 인증 확인
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
    }
    const uid = request.auth.uid; // 카카오 로그인 등 Firebase Auth에 매핑된 UID
    
    // 클라이언트로부터 넘겨받은 reservationId (Firestore 문서 ID)
    const { reservationId, reason = "고객 변심" } = request.data;
    if (!reservationId) {
        throw new HttpsError("invalid-argument", "예약 ID가 제공되지 않았습니다.");
    }

    const db = admin.firestore();
    const resRef = db.collection("reservations").doc(reservationId);
    
    try {
        // 2. 예약 데이터 확인 및 권한 검증
        const resDoc = await resRef.get();
        if (!resDoc.exists) {
            throw new HttpsError("not-found", "예약 내역을 찾을 수 없습니다.");
        }
        
        const resData = resDoc.data();
        
        // 내 예약이 맞는지 검증 (resData.kakaoUid 나 Auth UID 비교)
        // 카카오 로그인은 커스텀 토큰 혹은 Firebase kakaoUid 매핑 시 uid 형태가 다를 수 있으므로 
        // string으로 형변환하여 안전하게 검증 (클라이언트 규칙과 맞춰야 함)
        if (String(resData.kakaoUid) !== String(uid)) {
            throw new HttpsError("permission-denied", "해당 예약을 취소할 권한이 없습니다.");
        }

        if (resData.status === "cancelled") {
            throw new HttpsError("failed-precondition", "이미 취소된 예약입니다.");
        }

        // 3. 예외 처리: 지난 예약인지 혹은 환불 불가 규칙에 해당하는지
        // 예: 예약 날짜가 오늘보다 이전이면 환불 불가
        if (resData.date) {
            const resDateStr = resData.date.includes("(") ? resData.date.split("(")[0].trim() : resData.date;
            // "2024년 5월 10일" 부분을 Javascript 파싱 가능한 형태로 변경해야 할 수도 있으나
            // 단순화를 위해 Date로 파싱할 수 있게 클라이언트와 협의된 형태라고 가정합니다.
            // 여기서는 임시로 통과합니다. 실제 운영 시 정교한 date parsing 및 Timezone 처리가 필요합니다.
        }

        const impUid = resData.impUid;
        const merchantUid = resData.merchantUid;

        if (!impUid && !merchantUid) {
            // 과거 무료예약이거나 결제연동 전이어서 결제 ID가 없을 때 (무통장 입금 등)
            // 그냥 DB 상태만 취소로 변경
            await resRef.update({ 
                status: "cancelled", 
                cancelledAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return { success: true, message: "예약이 취소되었습니다." };
        }

        // 4. PortOne 인증 토큰 발급 받기
        const tokenResp = await axios.post("https://api.iamport.kr/users/getToken", {
            imp_key: PORTONE_API_KEY,
            imp_secret: PORTONE_API_SECRET
        });
        const { access_token } = tokenResp.data.response;

        // 5. PortOne 결제 취소 API 호출
        // 전액 환불 기준. 부분환불 시 amount 속성 추가 필요
        const cancelData = {
            reason: reason,
            ...(impUid ? { imp_uid: impUid } : { merchant_uid: merchantUid })
        };

        const cancelResp = await axios.post("https://api.iamport.kr/payments/cancel", cancelData, {
            headers: {
                "Authorization": `Bearer ${access_token}`
            }
        });

        if (cancelResp.data.code !== 0) {
            // 취소 실패 메시지 반환
            throw new HttpsError("internal", `결제 취소 실패: ${cancelResp.data.message}`);
        }

        // 6. 상태 업데이트
        await resRef.update({
            status: "cancelled",
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            cancelReason: reason
        });

        // 7. (Optional) 쿠폰 반환 처리 로직 등 추가 가능
        // if (resData.usedCoupon) { ... 쿠폰 사용상태 초기화 ... }

        return { success: true, message: "성공적으로 환불 및 예약 취소가 완료되었습니다." };

    } catch (error) {
        console.error("Cancel Reservation Error:", error);
        if (error instanceof HttpsError) {
            throw error;
        }
        throw new HttpsError("internal", "예약 취소 중 서버 오류가 발생했습니다.");
    }
});

exports.checkPaymentStatus = onCall(async (request) => {
    // 1. 인증 로직 (임의)
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
    }
    
    const { impUid, merchantUid } = request.data;
    if (!impUid && !merchantUid) {
        throw new HttpsError("invalid-argument", "결제 정보가 제공되지 않았습니다.");
    }
    
    try {
        // PortOne 인증 토큰 발급 받기
        const tokenResp = await axios.post("https://api.iamport.kr/users/getToken", {
            imp_key: PORTONE_API_KEY,
            imp_secret: PORTONE_API_SECRET
        });
        const { access_token } = tokenResp.data.response;
        
        let paymentInfoUrl = "";
        if (impUid) {
            paymentInfoUrl = `https://api.iamport.kr/payments/${impUid}`;
        } else {
            paymentInfoUrl = `https://api.iamport.kr/payments/find/${merchantUid}`;
        }
        
        const paymentResp = await axios.get(paymentInfoUrl, {
            headers: { Authorization: `Bearer ${access_token}` }
        });
        
        if (paymentResp.data.code !== 0) {
            throw new HttpsError("not-found", `결제 정보 조회 실패: ${paymentResp.data.message}`);
        }
        
        const status = paymentResp.data.response.status; // "paid", "ready", "failed", "cancelled"
        
        return { success: true, status: status, data: paymentResp.data.response };
    } catch (e) {
        console.error("Payment Check Error:", e);
        throw new HttpsError("internal", "결제 상태 확인 중 서버 오류가 발생했습니다.");
    }
});
