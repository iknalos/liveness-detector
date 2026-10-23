// Copies face-api (MIT) and the three models the app uses from node_modules into
// www/vendor/face-api, so the APK works offline. Run by `npm run build` (and CI).
'use strict';
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', '@vladmandic', 'face-api');
const dst = path.join(__dirname, '..', 'www', 'vendor', 'face-api');
const models = ['tiny_face_detector_model', 'face_landmark_68_model', 'face_recognition_model'];

fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(path.join(dst, 'model'), { recursive: true });
fs.copyFileSync(path.join(src, 'dist', 'face-api.js'), path.join(dst, 'face-api.js'));
fs.copyFileSync(path.join(src, 'LICENSE'), path.join(dst, 'LICENSE'));
for (const m of models) {
  for (const f of [`${m}-weights_manifest.json`, `${m}.bin`]) {
    fs.copyFileSync(path.join(src, 'model', f), path.join(dst, 'model', f));
  }
}
const size = fs.readdirSync(path.join(dst, 'model')).reduce((a, f) => a + fs.statSync(path.join(dst, 'model', f)).size, 0);
console.log(`vendored face-api + ${models.length} models (${(size / 1e6).toFixed(1)} MB) into www/vendor/face-api`);
