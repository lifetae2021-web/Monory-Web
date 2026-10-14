// 모노리 포인트 적립/사용/회수 로직 (Firestore 트랜잭션)
//
// 데이터 구조
//  - members/{uid}/point_lots/{lotId} : 적립 묶음 { amount, remaining, expiresAt, type: 'earn'|'restore', reservationId, createdAt }
//      → 잔액 = 만료 전 lot 들의 remaining 합계. 사용은 만료가 빠른 lot 부터 차감(FIFO)
//  - members/{uid}/point_logs/{logId} : 내역 { type: 'earn'|'use'|'restore'|'clawback', amount, reservationId, memo, createdAt }
//  - point_holds/{merchantUid}        : 결제 중 선차감한 포인트 { uid, amount, allocations, status: 'held'|'confirmed'|'released', createdAt }
//
// 모든 쓰기는 서버(Admin SDK)에서만 일어나며, 클라이언트는 본인 lot/log 를 읽기만 한다(firestore.rules).

const admin = require("firebase-admin");

const EARN_RATE = 0.05;            // 실제 결제금액의 5% 적립
const MIN_USE = 1000;              // 최소 사용 포인트
const EXPIRE_MONTHS = 12;          // 적립 후 유효기간
const MIN_RESTORE_DAYS = 30;       // 복구된 포인트의 최소 유효기간

const Timestamp = admin.firestore.Timestamp;
const FieldValue = admin.firestore.FieldValue;

function addMonths(date, months) {
    const d = new Date(date.getTime());
    d.setMonth(d.getMonth() + months);
    return d;
}

function lotsRef(db, uid) { return db.collection("members").doc(String(uid)).collection("point_lots"); }
function logsRef(db, uid) { return db.collection("members").doc(String(uid)).collection("point_logs"); }

// 만료 전 + 잔여 있는 lot (만료 빠른 순). tx 가 있으면 트랜잭션 안에서 읽는다.
async function loadActiveLots(db, uid, nowMs, tx) {
    const q = lotsRef(db, uid).where("expiresAt", ">", Timestamp.fromMillis(nowMs)).orderBy("expiresAt");
    const snap = tx ? await tx.get(q) : await q.get();
    return snap.docs.filter((d) => (d.data().remaining || 0) > 0);
}

// 결제 전 포인트 선차감
async function reservePoints(db, { uid, merchantUid, amount, nowMs = Date.now() }) {
    if (!Number.isInteger(amount) || amount < MIN_USE) {
        throw new Error(`포인트는 ${MIN_USE.toLocaleString()}P 이상부터 사용할 수 있습니다.`);
    }
    const holdRef = db.collection("point_holds").doc(merchantUid);

    return db.runTransaction(async (tx) => {
        const hold = await tx.get(holdRef);
        if (hold.exists) throw new Error("이미 처리 중인 결제입니다.");

        const lots = await loadActiveLots(db, uid, nowMs, tx);
        const balance = lots.reduce((s, d) => s + d.data().remaining, 0);
        if (balance < amount) throw new Error("보유 포인트가 부족합니다.");

        let need = amount;
        const allocations = [];
        for (const lot of lots) {
            if (need <= 0) break;
            const take = Math.min(need, lot.data().remaining);
            allocations.push({ lotId: lot.id, amount: take, expiresAtMs: lot.data().expiresAt.toMillis() });
            tx.update(lot.ref, { remaining: lot.data().remaining - take });
            need -= take;
        }

        tx.set(holdRef, {
            uid: String(uid), amount, allocations, status: "held",
            createdAt: Timestamp.fromMillis(nowMs),
        });
        tx.set(logsRef(db, uid).doc(), {
            type: "use", amount, merchantUid, memo: "예약 결제에 사용",
            createdAt: Timestamp.fromMillis(nowMs),
        });
        return { balance: balance - amount };
    });
}

// 선차감 포인트 복구. rate(0~1)만큼만 돌려주고 나머지는 소멸(환불 규정 비례).
// 이미 released 이면 아무것도 하지 않는다(멱등).
async function releaseHold(db, { merchantUid, rate = 1, memo = "포인트 사용 취소", nowMs = Date.now() }) {
    const holdRef = db.collection("point_holds").doc(merchantUid);

    return db.runTransaction(async (tx) => {
        const hold = await tx.get(holdRef);
        if (!hold.exists) return { restored: 0 };
        const h = hold.data();
        if (h.status === "released") return { restored: 0 };

        let remainingToRestore = Math.floor(h.amount * rate);
        const restoredTotal = remainingToRestore;
        const minExpiry = nowMs + MIN_RESTORE_DAYS * 86400000;
        const restoreRef = (i) => lotsRef(db, h.uid).doc(`restore_${merchantUid}_${i}`);

        h.allocations.forEach((a, i) => {
            if (remainingToRestore <= 0) return;
            const give = Math.min(a.amount, remainingToRestore);
            remainingToRestore -= give;
            tx.set(restoreRef(i), {
                amount: give, remaining: give, type: "restore", merchantUid,
                expiresAt: Timestamp.fromMillis(Math.max(a.expiresAtMs, minExpiry)),
                createdAt: Timestamp.fromMillis(nowMs),
            });
        });

        tx.update(holdRef, { status: "released", releasedAt: Timestamp.fromMillis(nowMs), restored: restoredTotal });
        if (restoredTotal > 0) {
            tx.set(logsRef(db, h.uid).doc(), {
                type: "restore", amount: restoredTotal, merchantUid, memo,
                createdAt: Timestamp.fromMillis(nowMs),
            });
        }
        return { restored: restoredTotal };
    });
}

// 이용완료 시 실제 결제금액(totalAmount, 포인트 사용분은 이미 제외된 금액)의 5% 적립.
// 같은 예약에 대해 한 번만 적립된다(lot 문서 ID 고정).
// tx 안에서 호출: 모든 읽기를 먼저 하고 마지막에 쓰기를 한다.
async function earnForReservation(db, tx, resRef, resData, nowMs = Date.now()) {
    const uid = resData.kakaoUid;
    const base = Number(resData.totalAmount) || 0;
    const points = Math.floor(base * EARN_RATE);
    if (!uid || points <= 0 || resData.pointsEarned) return { earned: 0 };

    const lotRef = lotsRef(db, uid).doc(`earn_${resRef.id}`);
    const lot = await tx.get(lotRef);
    if (lot.exists) return { earned: 0 };

    const now = new Date(nowMs);
    tx.set(lotRef, {
        amount: points, remaining: points, type: "earn", reservationId: resRef.id,
        expiresAt: Timestamp.fromDate(addMonths(now, EXPIRE_MONTHS)),
        createdAt: Timestamp.fromMillis(nowMs),
    });
    tx.set(logsRef(db, uid).doc(), {
        type: "earn", amount: points, reservationId: resRef.id, memo: "이용 완료 적립 (결제금액의 5%)",
        createdAt: Timestamp.fromMillis(nowMs),
    });
    tx.update(resRef, { pointsEarned: points });
    return { earned: points };
}

// 이용완료 후 환불이 생겼을 때 환불금액의 5%만큼 적립 포인트 회수(수동). 남은 포인트까지만 회수하고 부족분은 반환.
async function clawbackPoints(db, { reservationId, refundAmount, nowMs = Date.now() }) {
    const resRef = db.collection("reservations").doc(reservationId);

    return db.runTransaction(async (tx) => {
        const res = await tx.get(resRef);
        if (!res.exists) throw new Error("예약을 찾을 수 없습니다.");
        const r = res.data();
        const uid = r.kakaoUid;
        const earned = r.pointsEarned || 0;
        const already = r.pointsClawed || 0;
        if (!uid || earned <= 0) throw new Error("적립된 포인트가 없는 예약입니다.");

        const want = Math.min(Math.floor((Number(refundAmount) || 0) * EARN_RATE), earned - already);
        if (want <= 0) return { clawed: 0, shortfall: 0 };

        const lotRef = lotsRef(db, uid).doc(`earn_${reservationId}`);
        const lot = await tx.get(lotRef);
        const have = lot.exists ? (lot.data().remaining || 0) : 0;
        const take = Math.min(have, want);

        if (take > 0) {
            tx.update(lotRef, { remaining: have - take });
            tx.set(logsRef(db, uid).doc(), {
                type: "clawback", amount: take, reservationId, memo: "환불에 따른 적립 포인트 회수",
                createdAt: Timestamp.fromMillis(nowMs),
            });
        }
        tx.update(resRef, { pointsClawed: already + take });
        return { clawed: take, shortfall: want - take };
    });
}

module.exports = {
    EARN_RATE, MIN_USE, EXPIRE_MONTHS,
    loadActiveLots, reservePoints, releaseHold, earnForReservation, clawbackPoints,
};
