// 모노리 로컬 개발 서버 설정 (개발 전용: 사이트 코드/배포에는 영향 없음)
//  - 순수 HTML/CSS/JS 프로젝트를 그대로 서빙하고, 파일을 저장하면 브라우저에 자동 반영한다
//  - Firebase Hosting 이 제공하는 /__/firebase/* (SDK, init.js)는 운영 호스팅에서 가져온다
//  - 주의: 로컬에서도 운영 Firebase(DB/Auth)에 연결되므로 쓰기 작업은 실제 데이터에 반영된다
import { defineConfig } from 'vite';

// 개발 전용: 파일 저장 → 자동 새로고침될 때 보던 화면 위치(스크롤)를 그대로 복원한다
//  - 관리자 탭은 admin.html 이 이미 sessionStorage 로 복원하므로 여기서는 스크롤만 다룬다
//  - apply:'serve' 라서 운영 빌드/배포에는 전혀 들어가지 않는다
const keepStatePlugin = {
  name: 'monory-keep-state-on-reload',
  apply: 'serve',
  transformIndexHtml() {
    return [{
      tag: 'script',
      attrs: { type: 'module' },
      injectTo: 'head',
      children: `
const KEY = '__dev_reload_state:' + location.pathname;
const pathOf = (el) => { const p = []; for (; el && el !== document.body; el = el.parentElement) p.unshift(Array.prototype.indexOf.call(el.parentElement.children, el)); return p.join('/'); };
const byPath = (s) => { let el = document.body; for (const i of s.split('/')) { el = el && el.children[+i]; } return el; };
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeFullReload', () => {
    const inner = {};
    document.querySelectorAll('*').forEach((el) => { if (el.scrollTop > 0 && el !== document.documentElement && el !== document.body) inner[pathOf(el)] = el.scrollTop; });
    try { sessionStorage.setItem(KEY, JSON.stringify({ x: scrollX, y: scrollY, inner, t: Date.now() })); } catch (e) {}
  });
}
try {
  const raw = sessionStorage.getItem(KEY);
  sessionStorage.removeItem(KEY);
  const st = raw && JSON.parse(raw);
  if (st && Date.now() - st.t < 15000) {
    history.scrollRestoration = 'manual';
    const t0 = Date.now();
    // 로그인·데이터가 늦게 채워지므로 원하는 위치까지 늘어날 때까지 최대 8초 재시도
    const tick = () => {
      let done = true;
      const doc = document.documentElement;
      if (doc.scrollHeight - innerHeight >= st.y - 1 || Date.now() - t0 > 8000) scrollTo(st.x, st.y); else done = false;
      for (const [k, v] of Object.entries(st.inner)) { const el = byPath(k); if (el) { el.scrollTop = v; if (el.scrollTop < v - 1) done = false; } }
      if (!done && Date.now() - t0 <= 8000) setTimeout(tick, 150); else if (!done) return;
      else {
        const n = document.createElement('div');
        n.textContent = '↻ 수정사항이 반영됐어요';
        n.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#222;color:#fff;padding:8px 14px;border-radius:8px;font:13px sans-serif;opacity:.95;transition:opacity .4s';
        document.body.appendChild(n);
        setTimeout(() => { n.style.opacity = 0; setTimeout(() => n.remove(), 400); }, 1800);
      }
    };
    addEventListener('DOMContentLoaded', tick);
  }
} catch (e) {}
`,
    }];
  },
};

export default defineConfig({
  plugins: [keepStatePlugin],
  appType: 'mpa',            // 페이지마다 별도 HTML (index, mypage, community, admin ...)
  server: {
    port: 8000,              // 카카오 로그인 리다이렉트 주소(localhost:8000)와 맞춘다
    strictPort: true,
    host: true,              // 같은 와이파이의 휴대폰에서도 접속 가능
    open: false,
    proxy: {
      '/__': { target: 'https://monory-web.web.app', changeOrigin: true, secure: true },
    },
    watch: {
      // 서버 함수, 비밀 키, DB 파일, 로그 등은 감시하지 않는다 (불필요한 새로고침 방지)
      ignored: [
        '**/functions/**', '**/node_modules/**', '**/.git/**', '**/__pycache__/**',
        '**/*.db', '**/*.log', '**/*.py', '**/serviceAccountKey.json', '**/_*.html',
      ],
    },
  },
});
