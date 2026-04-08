const fs = require('fs');
const { execSync } = require('child_process');

// 1. version.json 읽기
const versionFile = './version.json';
let versionData = { version: "1.0.0", buildDate: new Date().toISOString().split('T')[0] };

if (fs.existsSync(versionFile)) {
    versionData = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
}

// 2. 버전 숫자 올리기 (예: 1.0.29 -> 1.0.30)
const vParts = versionData.version.split('.');
if (vParts.length === 3) {
    vParts[2] = parseInt(vParts[2], 10) + 1;
    versionData.version = vParts.join('.');
} else {
    versionData.version += ".1"; // fallback
}

// 3. 현재 날짜/시간 업데이트 (YYYY-MM-DD HH:mm)
const now = new Date();
const pad = (n) => n.toString().padStart(2, '0');
versionData.buildDate = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

// 4. version.json 저장
fs.writeFileSync(versionFile, JSON.stringify(versionData, null, 2), 'utf8');
console.log(`\n🚀 Version bumped to v${versionData.version} (${versionData.buildDate})\n`);

try {
    // 5. Git Commit (변경된 파일들 모두 포함)
    console.log('📦 Git add & commit...');
    execSync('git add .', { stdio: 'inherit' });
    
    // 만약 commit할 변경사항이 없다면 에러가 날 수 있으니 catch로 무시
    try {
        execSync(`git commit -m "Deploy version v${versionData.version}"`, { stdio: 'inherit' });
    } catch (e) {
        console.log('💡 No new changes to commit (or commit failed). Proceeding to deploy...');
    }

    // 5.5 Git Push (깃허브에 반영)
    console.log('⬆️ Pushing to GitHub...');
    try {
        execSync('git push', { stdio: 'inherit' });
    } catch (e) {
        console.log('⚠️ Git push failed, check your remote repository settings.');
    }

    // 6. Firebase Deploy
    console.log('\n🔥 Firebase Deploying...\n');
    execSync('firebase deploy --only hosting', { stdio: 'inherit' });

    console.log(`\n🎉 Deploy Complete! Version v${versionData.version} is now live.`);
} catch (error) {
    console.error('\n❌ Deployment failed:', error.message);
    process.exit(1);
}
