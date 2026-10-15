// 시스템이 자동 지급하는 쿠폰(가입 환영, 리뷰 보상). 고객 브라우저는 쿠폰을 만들 수 없고 서버만 만든다.
// 쿠폰 문서 ID를 고정해서(가입: WELCOME_10K, 리뷰: REVIEW_<예약ID>) 같은 쿠폰이 두 번 나가지 않게 한다.

const admin = require("firebase-admin");

const NO_EXPIRY = () => admin.firestore.Timestamp.fromDate(new Date("2099-12-31T23:59:59"));

function welcomeCoupon(nowTs) {
    return {
        couponId: "WELCOME_10K",
        title: "신규 가입 감사 쿠폰 (10,000원)",
        name: "신규 가입 감사 쿠폰 (10,000원)",
        discountType: "fixed",
        discountValue: 10000,
        discountAmount: 10000,
        discountRate: 0,
        isUsed: false,
        status: "active",
        isUnlimited: true,
        issuedAt: nowTs,
        createdAt: nowTs,
        expireAt: NO_EXPIRY(),
        expiryDate: NO_EXPIRY(),
    };
}

function reviewCoupon(nowTs) {
    return {
        title: "리뷰 감사 쿠폰 (5,000원)",
        name: "리뷰 감사 쿠폰 (5,000원)",
        discountType: "fixed",
        discountValue: 5000,
        discountAmount: 5000,
        discountRate: 0,
        isUsed: false,
        status: "active",
        isUnlimited: true,
        expireAt: NO_EXPIRY(),
        createdAt: nowTs,
        issuedBy: "system_review_reward",
    };
}

// 가입 환영 쿠폰: 이미 있으면 다시 만들지 않는다
async function issueWelcomeCoupon(db, uid, nowTs = admin.firestore.Timestamp.now()) {
    const ref = db.collection("members").doc(String(uid)).collection("coupons").doc("WELCOME_10K");
    try {
        await ref.create(welcomeCoupon(nowTs));
        return { result: "issued" };
    } catch (e) {
        if (e.code === 6 || /already exists/i.test(e.message)) return { result: "exists" };
        throw e;
    }
}

// 리뷰 보상 쿠폰: 본인 예약에 쓴 사진 있는 리뷰에만, 예약당 1장
async function issueReviewCoupon(db, review, nowTs = admin.firestore.Timestamp.now()) {
    const uid = review && review.authorId != null ? String(review.authorId) : "";
    const resId = review && review.resId ? String(review.resId) : "";
    if (!uid || !resId) return { result: "no-reservation-link" };
    if (!Array.isArray(review.photoUrls) || review.photoUrls.length < 1) return { result: "no-photo" };
    if (typeof review.content !== "string" || review.content.trim().length < 10) return { result: "too-short" };

    const resSnap = await db.collection("reservations").doc(resId).get();
    if (!resSnap.exists || String(resSnap.data().kakaoUid) !== uid) return { result: "not-owner" };
    if (resSnap.data().status === "cancelled") return { result: "cancelled" };

    const ref = db.collection("members").doc(uid).collection("coupons").doc("REVIEW_" + resId);
    try {
        await ref.create(reviewCoupon(nowTs));
        return { result: "issued" };
    } catch (e) {
        if (e.code === 6 || /already exists/i.test(e.message)) return { result: "exists" };
        throw e;
    }
}

module.exports = { issueWelcomeCoupon, issueReviewCoupon, welcomeCoupon, reviewCoupon };
