// 호스팅(monory.kr)에 올릴 파일만 dist/ 로 복사한다. (허용 목록 방식)
//
//  - 여기에 적힌 파일만 공개된다. 새 파일을 만들어도 이 목록에 넣기 전에는 절대 공개되지 않는다.
//  - 새 페이지/스크립트를 추가했다면 아래 SITE_FILES 에 직접 추가할 것 (빠뜨리면 경고가 뜬다).
//  - 비밀 키, .env, 로그, DB, 서버 소스, .git 등은 허용 목록에 없으므로 공개되지 않는다.
//  - firebase.json 의 predeploy 와 GitHub Actions 배포 단계에서 자동으로 실행된다.
//
//  실행:  node scripts/build-public.js   (또는 npm run build:public)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');

// ── 공개할 파일 (루트 기준) ─────────────────────────────────
const SITE_FILES = [
    // 페이지
    'index.html', 'community.html', 'party.html', 'mypage.html', 'login.html', 'admin.html',
    'payment-success.html', 'terms.html', 'privacy.html', '404.html',
    // 스타일 / 스크립트
    'style.css', 'admin.css', 'kakao-auth.js', 'version-badge.js',
    // 데이터 / 검색엔진
    'version.json', 'robots.txt', 'sitemap.xml',
];

// ── 공개할 폴더 (확장자 제한) ───────────────────────────────
const SITE_DIRS = {
    assets: ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif', '.ico', '.mp4'],
};

// ── 어떤 경우에도 공개되면 안 되는 이름 (허용 목록에 실수로 넣어도 막는다) ──
const FORBIDDEN = /(serviceaccount|adminsdk|\.env|\.pem|\.p12|\.key$|secret|\.log$|\.db$|\.sqlite|\.py$|\.git|node_modules|credentials|id_rsa)/i;

function fail(msg) {
    console.error('\n[build-public] 중단: ' + msg + '\n');
    process.exit(1);
}

function copyFile(rel) {
    if (FORBIDDEN.test(rel)) fail(`공개하면 안 되는 이름의 파일이 허용 목록에 있습니다: ${rel}`);
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) fail(`허용 목록의 파일이 없습니다: ${rel}`);
    const dst = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return rel;
}

// 1) dist 비우고 다시 만들기
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const copied = [];
SITE_FILES.forEach(f => copied.push(copyFile(f)));
for (const [dir, exts] of Object.entries(SITE_DIRS)) {
    const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).forEach(e => {
        const rel = path.join(d, e.name);
        if (e.isDirectory()) return walk(rel);
        if (e.name.startsWith('.')) return;                       // 숨김 파일은 제외
        if (!exts.includes(path.extname(e.name).toLowerCase())) { console.warn(`  (제외) ${rel} - 허용되지 않은 확장자`); return; }
        copied.push(copyFile(rel));
    });
    if (fs.existsSync(path.join(ROOT, dir))) walk(dir);
}

// 2) 페이지가 참조하는 로컬 파일이 모두 dist 에 있는지 검사 (빠뜨리면 사이트가 깨지므로 중단)
const missing = [];
copied.filter(f => f.endsWith('.html')).forEach(html => {
    const body = fs.readFileSync(path.join(OUT, html), 'utf8');
    const refs = new Set();
    for (const m of body.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) refs.add(m[1]);
    for (const m of body.matchAll(/["'`]((?:\.\/)?assets\/[A-Za-z0-9_\-./]+\.(?:png|jpe?g|svg|webp|gif|mp4|ico))["'`]/g)) refs.add(m[1]);
    refs.forEach(r => {
        let u = r.split('#')[0].split('?')[0];
        if (!u || /^(https?:|\/\/|mailto:|tel:|javascript:|data:|\/__\/)/.test(u) || u.includes('${')) return;
        u = u.replace(/^\.?\//, '');
        if (!fs.existsSync(path.join(OUT, u))) missing.push(`${html} → ${r}`);
    });
});
if (missing.length) fail('페이지가 참조하는 파일이 공개 목록에 없습니다:\n  ' + missing.join('\n  '));

// 3) 허용 목록에 없는 웹 파일 알림 (새 페이지를 만들고 목록에 안 넣은 경우)
const DEV_ONLY = ['check_db.js', 'deploy.js', 'firebase.json', 'package.json', 'package-lock.json', 'skills-lock.json', 'vite.config.mjs'];
const unlisted = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isFile() && /\.(html|css|js|json|xml|txt)$/i.test(e.name) && !copied.includes(e.name) && !DEV_ONLY.includes(e.name) && !e.name.startsWith('.'))
    .map(e => e.name);
if (unlisted.length) {
    console.warn('\n※ 공개 목록에 없어서 올라가지 않는 파일: ' + unlisted.join(', '));
    console.warn('  (사이트에 필요한 파일이라면 scripts/build-public.js 의 SITE_FILES 에 추가하세요)');
}

console.log(`\n[build-public] dist/ 에 ${copied.length}개 파일 준비 완료`);
