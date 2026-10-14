// 포트원(결제대행사)에서 환불/취소된 결제를 웹사이트 예약에 반영한다.
// 포트원 콘솔에서 직접 환불하거나, 웹사이트의 취소 기능으로 환불했을 때 모두 같은 웹훅이 들어온다.
//  - 전액 환불: 예약 취소 + 사용 포인트 복구 + 쿠폰 복구 + (이용완료 건이면) 적립 포인트 회수
//  - 부분 환불: 환불 금액만 기록하고 상태는 유지 (관리자가 상황에 맞게 처리)
// 이미 취소 처리된 예약은 다시 처리하지 않는다(멱등).

const admin = require("firebase-admin");
const points = require("./points");

// payment: 포트원 API 로 다시 조회한 결제 정보(웹훅 본문은 신뢰하지 않는다)
async function applyPortoneCancellation(db, payment, nowMs = Date.now()) {
    const cancelAmount = Number(payment.cancel_amount) || 0;
    if (cancelAmount <= 0) return { result: "no-cancel" };

    const found = await db.collection("reservations").where("impUid", "==", payment.imp_uid).limit(1).get();
    if (found.empty) return { result: "no-reservation" };
    const resRef = found.docs[0].ref;

    const isFull = payment.status === "cancelled" || cancelAmount >= Number(payment.amount);
    const history = Array.isArray(payment.cancel_history) ? payment.cancel_history : [];
    const lastReason = history.length ? (history[history.length - 1].reason || "") : "";

    const outcome = await db.runTransaction(async (tx) => {
        const snap = await tx.get(resRef);
        const r = snap.data();

        if (!isFull) {
            if ((r.refundAmount || 0) === cancelAmount) return { result: "already-recorded" };
            tx.update(resRef, {
                refundAmount: cancelAmount,
                partialRefund: true,
                refundSource: "portone",
                updatedAt: admin.firestore.Timestamp.fromMillis(nowMs),
            });
            return { result: "partial", reservation: r };
        }

        if (r.status === "cancelled") return { result: "already-cancelled" };

        tx.update(resRef, {
            status: "cancelled",
            cancelledAt: admin.firestore.Timestamp.fromMillis(nowMs),
            cancelReason: lastReason || "결제대행사에서 환불 처리됨",
            refundRate: 1,
            refundAmount: cancelAmount,
            refundSource: "portone",
            updatedAt: admin.firestore.Timestamp.fromMillis(nowMs),
        });
        return { result: "cancelled", reservation: r, wasCompleted: r.status === "completed" };
    });

    if (outcome.result !== "cancelled") return { result: outcome.result };

    const r = outcome.reservation;
    const extra = { pointsRestored: 0, pointsClawed: 0, couponRestored: false };

    // 사용한 포인트 전액 복구 (서버 기록 기준)
    if (r.merchantUid) {
        const rel = await points.releaseHold(db, {
            merchantUid: r.merchantUid, rate: 1, memo: "환불로 포인트 복구", nowMs,
        }).catch((e) => { console.warn("포인트 복구 실패:", e.message); return { restored: 0 }; });
        extra.pointsRestored = rel.restored;
    }

    // 이용완료 후 환불이면 적립했던 포인트 회수
    if (outcome.wasCompleted && r.pointsEarned > 0) {
        const claw = await points.clawbackPoints(db, {
            reservationId: resRef.id, refundAmount: cancelAmount, nowMs,
        }).catch((e) => { console.warn("포인트 회수 실패:", e.message); return { clawed: 0 }; });
        extra.pointsClawed = claw.clawed;
    }

    // 전액 환불이므로 사용한 쿠폰 복구
    if (r.usedCoupon && r.usedCoupon.id && r.kakaoUid) {
        try {
            await db.collection("members").doc(String(r.kakaoUid)).collection("coupons").doc(r.usedCoupon.id)
                .update({ status: "active", isUsed: false, usedAt: admin.firestore.FieldValue.delete() });
            extra.couponRestored = true;
        } catch (e) {
            console.warn("쿠폰 복구 실패:", e.message);
        }
    }
    return { result: "cancelled", ...extra };
}

module.exports = { applyPortoneCancellation };
