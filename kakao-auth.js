window.__kakaoAuthVer = 2;
// 카카오 액세스 토큰 → Cloud Function(kakaoLogin) → Firebase 커스텀 토큰 로그인
// 함수가 아직 배포되지 않았거나 실패해도 기존 카카오 로그인 흐름은 그대로 진행되도록 항상 resolve 한다.
async function signInFirebaseWithKakao(accessToken) {
    try {
        if (typeof firebase === 'undefined' || !firebase.auth || !firebase.functions) return false;
        const call = firebase.functions().httpsCallable('kakaoLogin');
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000));
        const res = await Promise.race([call({ accessToken }), timeout]);
        await firebase.auth().signInWithCustomToken(res.data.customToken);
        try { localStorage.removeItem('monory_auth_error'); } catch (x) {}
        return true;
    } catch (e) {
        console.warn('Firebase 인증 연동 실패(기존 로그인은 유지됨):', e.code || '', e.message || e);
        // 마이페이지 진단 문구에 표시하기 위해 마지막 오류를 남겨 둔다
        try { localStorage.setItem('monory_auth_error', ((e.code || '') + ' ' + (e.message || '')).trim().slice(0, 160)); } catch (x) {}
        return false;
    }
}

async function signOutFirebase() {
    try { if (typeof firebase !== 'undefined' && firebase.auth) await firebase.auth().signOut(); } catch (e) {}
}
