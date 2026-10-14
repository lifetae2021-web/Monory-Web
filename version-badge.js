// 하단 버전 표시: 관리자 계정(members.role)으로 로그인한 경우에만 노출
(function () {
    const el = document.getElementById('version-display');
    if (!el) return;
    const ADMIN_ROLES = ['super_admin', 'admin', 'general_admin'];

    async function show() {
        let user = null;
        try { user = JSON.parse(localStorage.getItem('monory_user') || 'null'); } catch (e) {}
        if (!user || !user.kakaoId) return;
        try {
            // 서버 로그인이 복원될 때까지 기다린다 (kakao-auth.js 가 늦게 로드될 수 있어 잠깐 기다림)
            for (let i = 0; i < 50 && !window.firebaseAuthState; i++) await new Promise(r => setTimeout(r, 100));
            if (window.firebaseAuthState) await window.firebaseAuthState();
            if (!firebase.auth || !firebase.auth().currentUser) return;
            const doc = await firebase.firestore().collection('members').doc(String(user.kakaoId)).get();
            if (!doc.exists || !ADMIN_ROLES.includes(doc.data().role)) return;
            const res = await fetch('version.json?t=' + Date.now());
            const data = await res.json();
            el.innerText = `v${data.version} (${data.buildDate})`;
            el.style.display = '';
        } catch (e) { console.warn('버전 표시 실패', e); }
    }

    // Firebase 초기화 대기 (최대 10초)
    let tries = 0;
    const timer = setInterval(() => {
        if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) {
            clearInterval(timer); show();
        } else if (++tries > 100) clearInterval(timer);
    }, 100);
})();
