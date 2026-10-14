// 모노리 로컬 개발 서버 설정 (개발 전용: 사이트 코드/배포에는 영향 없음)
//  - 순수 HTML/CSS/JS 프로젝트를 그대로 서빙하고, 파일을 저장하면 브라우저에 자동 반영한다
//  - Firebase Hosting 이 제공하는 /__/firebase/* (SDK, init.js)는 운영 호스팅에서 가져온다
//  - 주의: 로컬에서도 운영 Firebase(DB/Auth)에 연결되므로 쓰기 작업은 실제 데이터에 반영된다
import { defineConfig } from 'vite';

export default defineConfig({
  appType: 'mpa',            // 페이지마다 별도 HTML (index, mypage, community, admin ...)
  server: {
    port: 5173,
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
