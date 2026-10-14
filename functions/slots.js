// 예약 가능 시간 표시용 공개 데이터(booked_slots) 만들기
//
// reservations 컬렉션에는 이름·연락처 등 개인정보가 있어서 본인과 관리자만 읽을 수 있다.
// 대신 "어느 날짜의 몇 시부터 몇 시까지 예약됨"만 booked_slots 에 따로 복사해 두고, 이것만 누구나 읽게 한다.
// (이름, 연락처, 결제 정보, 예약 번호는 들어가지 않는다. 문서 ID 도 예약 번호를 해시해서 만든다.)

const crypto = require("crypto");

// 패키지별 이용 시간 (시각 인덱스: 24 이상은 익일)
const PKG_HOURS = { day: [10, 17], night: [18, 24], allnight: [18, 33] };

function slotId(reservationId) {
    return "s_" + crypto.createHash("sha256").update(String(reservationId)).digest("hex").slice(0, 24);
}

// '26.10.22 (목)' 또는 '2026년 10월 22일' → { y, m(1~12), d }
function parseDateParts(str) {
    if (!str) return null;
    let m = String(str).match(/(\d{4})년 (\d+)월 (\d+)일/);
    if (m) return { y: +m[1], m: +m[2], d: +m[3] };
    m = String(str).match(/(\d{2})\.(\d{2})\.(\d{2})/);
    if (m) return { y: 2000 + (+m[1]), m: +m[2], d: +m[3] };
    return null;
}

// 예약 문서 → 공개용 슬롯 데이터 (공개 대상이 아니면 null)
function slotFromReservation(r) {
    if (!r || !["paid", "completed"].includes(r.status)) return null;
    const date = parseDateParts(r.date);
    if (!date) return null;
    let range = null;
    if (r.reservationMode === "hourly" && r.startTime != null && r.endTime != null) range = [Number(r.startTime), Number(r.endTime)];
    else if (PKG_HOURS[r.packageKey]) range = PKG_HOURS[r.packageKey];
    if (!range || !(range[1] > range[0])) return null;
    return { y: date.y, m: date.m, d: date.d, start: range[0], end: range[1] };
}

module.exports = { slotId, slotFromReservation, parseDateParts, PKG_HOURS };
