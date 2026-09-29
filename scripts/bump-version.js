const fs = require('fs');
const path = require('path');

const versionFile = path.join(__dirname, '..', 'version.json');
let versionData = { version: '1.0.0', buildDate: '' };

if (fs.existsSync(versionFile)) {
    versionData = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
}

const vParts = versionData.version.split('.');
if (vParts.length === 3) {
    vParts[2] = parseInt(vParts[2], 10) + 1;
    versionData.version = vParts.join('.');
} else {
    versionData.version += '.1';
}

const now = new Date();
const pad = (n) => n.toString().padStart(2, '0');
versionData.buildDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

fs.writeFileSync(versionFile, JSON.stringify(versionData, null, 2) + '\n', 'utf8');
console.log(`version.json -> v${versionData.version} (${versionData.buildDate})`);
