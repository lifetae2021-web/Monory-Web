// 고객 문자 발송(솔라피) + 문구. 문구는 이 파일에서만 고치면 된다.
const axios = require("axios");
const crypto = require("crypto");

const SMS_FROM = "01091301577";          // 솔라피에 등록된 발신번호
const CONTACT = "010-9130-1577";
const ADDRESS = "부산시 부산진구 중앙대로 763-1 4층";
const DIRECTIONS = "서면역 15번 출구 도보 3분 / 부전역 1번 출구 도보 4분";
// 출입 방법(도어락 등) 안내. 비워 두면 문자에 넣지 않는다. 예: "출입 비밀번호는 ○○○○# 입니다."
const ENTRY_GUIDE = "";

const won = (n) => (Number(n) || 0).toLocaleString("ko-KR") + "원";

function normalizePhone(p) {
    const d = String(p || "").replace(/\D/g, "");
    return /^01[016789]\d{7,8}$/.test(d) ? d : null;
}

function authHeader(apiKey, apiSecret) {
    const date = new Date().toISOString();
    const salt = crypto.randomBytes(16).toString("hex");
    const signature = crypto.createHmac("sha256", apiSecret).update(date + salt).digest("hex");
    return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

// 90바이트 이하는 SMS, 넘으면 LMS 로 자동 전환된다(솔라피가 판단)
async function sendSms({ apiKey, apiSecret, to, text }) {
    const phone = normalizePhone(to);
    if (!phone) throw new Error("올바른 휴대폰 번호가 아닙니다: " + to);
    const res = await axios.post(
        "https://api.solapi.com/messages/v4/send",
        { message: { to: phone, from: SMS_FROM, text } },
        { headers: { Authorization: authHeader(apiKey, apiSecret) }, timeout: 15000 }
    );
    return res.data;
}

// 솔라피 잔액(원) 조회
async function getBalance({ apiKey, apiSecret }) {
    const res = await axios.get("https://api.solapi.com/cash/v1/balance", {
        headers: { Authorization: authHeader(apiKey, apiSecret) }, timeout: 15000,
    });
    return Number(res.data.balance) || 0;
}

// ── 템플릿 ──────────────────────────────────────────────────
// 확정/전날 안내 문구(출입 비밀번호, 보증금 계좌 등 민감한 내용 포함)는 코드에 넣지 않고
// Firestore system_state/sms_templates 문서(서버만 읽을 수 있음)에 저장한다. 문서가 없으면 아래 기본 문구를 쓴다.
// 사용 가능한 치환 문구: {이름} {일시} {상품} {인원} {결제금액} {문의번호}
function fmtDate(d) {
    const m = String(d || "").match(/(\d{2})\.(\d{1,2})\.(\d{1,2})\s*(\(.\))?/);
    if (!m) return d || "-";
    return `20${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일${m[4] ? " " + m[4] : ""}`;
}

function reservationFields(r) {
    // packageName 예: "시간제 (14시~17시)", "나이트 패키지 (18:00~24:00)"
    const m = String(r.packageName || "").match(/^(.*?)\s*\((.*)\)\s*$/);
    const name = m ? m[1] : (r.packageName || "-");
    let time = m ? m[2] : "";
    if (r.startTime != null && r.endTime != null) {
        const h = (v) => String(v % 24).padStart(2, "0") + ":00";
        time = `${h(r.startTime)}~${h(r.endTime)}${r.totalHours ? ` (총 ${r.totalHours}시간)` : ""}`;
    }
    return {
        "이름": r.guestName || "고객",
        "일시": `${fmtDate(r.date)}${time ? " " + time : ""}`,
        "상품": name,
        "인원": r.guestCount ? `${r.guestCount}명` : "-",
        "결제금액": won(r.totalAmount),
        "문의번호": CONTACT,
    };
}

function renderTemplate(tpl, r) {
    const f = reservationFields(r);
    return String(tpl).replace(/\{(.+?)\}/g, (all, k) => (k in f ? f[k] : all));
}

// ── 문구 ────────────────────────────────────────────────────
const refundPolicy = "※ 취소·환불: 이용일 8일 전까지 100%, 7~4일 전 50%, 3일 전~당일은 환불 불가 (마이페이지에서 취소)";

function summaryLines(r) {
    return [
        `■ 일시: ${r.date || "-"}`,
        `■ 이용: ${r.packageName || "-"}${r.guestCount ? ` / ${r.guestCount}명` : ""}`,
    ];
}

function approvedText(r, tpl) {
    if (tpl) return renderTemplate(tpl, r);
    const lines = [
        "[모노리] 예약이 확정되었습니다.",
        "",
        `${r.guestName || "고객"}님, 예약해 주셔서 감사합니다.`,
        ...summaryLines(r),
        `■ 결제: ${won(r.totalAmount)}`,
        "",
        "■ 오시는 길",
        ADDRESS,
        DIRECTIONS,
        "",
        "이용 전날 출입 방법과 이용 안내를 다시 보내드립니다.",
        refundPolicy,
        `문의 ${CONTACT}`,
    ];
    return lines.join("\n");
}

function reminderText(r, tpl) {
    if (tpl) return renderTemplate(tpl, r);
    const lines = [
        "[모노리] 내일 예약 안내",
        "",
        `${r.guestName || "고객"}님, 내일 모노리 이용일입니다.`,
        ...summaryLines(r),
        "",
        "■ 오시는 길",
        ADDRESS,
        DIRECTIONS,
    ];
    if (ENTRY_GUIDE) lines.push("", "■ 출입 안내", ENTRY_GUIDE);
    lines.push("", `문의 ${CONTACT}`);
    return lines.join("\n");
}

function cancelledText(r) {
    const lines = [
        "[모노리] 예약이 취소되었습니다.",
        "",
        ...summaryLines(r),
        r.refundAmount > 0
            ? `■ 환불 예정 금액: ${won(r.refundAmount)}\n(카드사에 따라 영업일 기준 3~7일 소요)`
            : "환불 관련 내용은 아래 번호로 문의해 주세요.",
        `문의 ${CONTACT}`,
    ];
    return lines.join("\n");
}

function rejectedText(r) {
    const lines = [
        "[모노리] 죄송합니다. 요청하신 예약을 진행하기 어려워 승인되지 않았습니다.",
        "",
        ...summaryLines(r),
        `결제하신 ${won(r.refundAmount || r.totalAmount)}은 전액 환불됩니다.`,
        "(카드사에 따라 영업일 기준 3~7일 소요)",
        `문의 ${CONTACT}`,
    ];
    return lines.join("\n");
}

module.exports = {
    SMS_FROM, normalizePhone, sendSms, getBalance, renderTemplate, reservationFields, fmtDate,
    approvedText, reminderText, cancelledText, rejectedText,
};
