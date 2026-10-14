window.__kakaoAuthVer = 2;
// 카카오 액세스 토큰 → Cloud Function(kakaoLogin) → Firebase 커스텀 토큰 로그인
// 함수가 아직 배포되지 않았거나 실패해도 기존 카카오 로그인 흐름은 그대로 진행되도록 항상 resolve 한다.
async function signInFirebaseWithKakao(accessToken) {
    try {
        if (typeof firebase === 'undefined' || !firebase.auth || !firebase.functions) return false;
        const call = firebase.functions().httpsCallable('kakaoLogin');
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
        const res = await Promise.race([call({ accessToken }), timeout]);
        await firebase.auth().signInWithCustomToken(res.data.customToken);
        _authStatePromise = null;
        try { localStorage.removeItem('monory_auth_error'); } catch (x) {}
        return true;
    } catch (e) {
        console.warn('Firebase 인증 연동 실패(기존 로그인은 유지됨):', e.code || '', e.message || e);
        // 마이페이지 진단 문구에 표시하기 위해 마지막 오류를 남겨 둔다
        try { localStorage.setItem('monory_auth_error', ((e.code || '') + ' ' + (e.message || '')).trim().slice(0, 160)); } catch (x) {}
        return false;
    }
}

// 서버(Firebase) 로그인 상태가 복원될 때까지 기다린다. 개인 데이터(예약·쿠폰·회원 정보)는 서버 로그인이 있어야 읽을 수 있다.
// 카카오 세션만 남아 있고 서버 로그인이 없으면(예전에 로그인한 사람) 한 번만 안내하고 다시 로그인하게 한다.
let _authStatePromise = null;
function firebaseAuthState() {
    if (!_authStatePromise) {
        _authStatePromise = new Promise(function (resolve) {
            try {
                if (typeof firebase === 'undefined' || !firebase.auth) return resolve(null);
                let done = false;
                const timer = setTimeout(function () { if (!done) { done = true; resolve(firebase.auth().currentUser); } }, 8000);
                const unsub = firebase.auth().onAuthStateChanged(function (u) {
                    if (done) return; done = true; clearTimeout(timer);
                    try { unsub(); } catch (e) {}
                    resolve(u);
                });
            } catch (e) { resolve(null); }
        });
    }
    return _authStatePromise;
}
window.firebaseAuthState = firebaseAuthState;

async function ensureFirebaseSession() {
    try {
        if (typeof firebase === 'undefined' || !firebase.auth) return null;
        await firebaseAuthState();   // 저장된 로그인 상태가 복원될 때까지 기다린다
    } catch (e) { /* 대기 실패 시 아래에서 현재 상태만 확인 */ }
    const u = firebase.auth().currentUser;
    try {
        if (!u && localStorage.getItem('monory_user') && !sessionStorage.getItem('monory_relogin_notice')) {
            sessionStorage.setItem('monory_relogin_notice', '1');
            localStorage.removeItem('monory_user');
            alert('보안이 강화되어 한 번 다시 로그인해 주세요.');
            location.reload();
        }
    } catch (e) {}
    return u;
}
window.ensureFirebaseSession = ensureFirebaseSession;

async function signOutFirebase() {
    try { if (typeof firebase !== 'undefined' && firebase.auth) await firebase.auth().signOut(); } catch (e) {}
}
