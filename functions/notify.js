// 예약 알림(텔레그램). 메시지 문구 만들기 + 전송.
const axios = require("axios");

const won = (n) => (Number(n) || 0).toLocaleString("ko-KR") + "원";

function bookingLines(r) {
    const lines = [];
    const who = r.guestName || "-";
    lines.push(`${who}${r.bookingType === "corporate" && r.companyName ? ` (${r.companyName})` : ""}${r.guestCount ? ` / ${r.guestCount}명` : ""}`);
    lines.push(`${r.date || "-"}  ${r.packageName || ""}`.trim());
    return lines;
}

// 새 예약
function newReservationMessage(r) {
    const lines = ["🎉 [모노리] 새 예약 — ⏳ 승인 필요", "", ...bookingLines(r)];
    lines.push(`결제 ${won(r.totalAmount)}`);
    if (r.usedCoupon && r.usedCoupon.name) lines.push(`쿠폰: ${r.usedCoupon.name}`);
    if (r.pointUsed > 0) lines.push(`포인트 사용: ${Number(r.pointUsed).toLocaleString("ko-KR")}P`);
    if (r.reviewPromise) lines.push("📷 포토리뷰 약속");
    lines.push(`연락처 ${r.phone || "-"}`);
    if (r.requests) lines.push(`요청: ${r.requests}`);
    lines.push("", "관리자 페이지에서 승인하면 고객에게 확정 문자가 갑니다.");
    return lines.join("\n");
}

// 예약 취소
function cancelledMessage(r) {
    const lines = ["❌ [모노리] 예약 취소", "", ...bookingLines(r)];
    lines.push(`결제 ${won(r.totalAmount)}${r.refundAmount ? ` / 환불 ${won(r.refundAmount)}` : ""}`);
    if (r.cancelReason) lines.push(`사유: ${r.cancelReason}`);
    lines.push(`연락처 ${r.phone || "-"}`);
    return lines.join("\n");
}

async function sendTelegram(token, chatId, text) {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
    }, { timeout: 10000 });
}

module.exports = { newReservationMessage, cancelledMessage, sendTelegram };
