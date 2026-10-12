// 카카오 액세스 토큰 → Cloud Function(kakaoLogin) → Firebase 커스텀 토큰 로그인
// 함수가 아직 배포되지 않았거나 실패해도 기존 카카오 로그인 흐름은 그대로 진행되도록 항상 resolve 한다.
async function signInFirebaseWithKakao(accessToken) {
    try {
        if (typeof firebase === 'undefined' || !firebase.auth || !firebase.functions) return false;
        const call = firebase.functions().httpsCallable('kakaoLogin');
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000));
        const res = await Promise.race([call({ accessToken }), timeout]);
        await firebase.auth().signInWithCustomToken(res.data.customToken);
        return true;
    } catch (e) {
        console.warn('Firebase 인증 연동 실패(기존 로그인은 유지됨):', e.message || e);
        return false;
    }
}

async function signOutFirebase() {
    try { if (typeof firebase !== 'undefined' && firebase.auth) await firebase.auth().signOut(); } catch (e) {}
}
