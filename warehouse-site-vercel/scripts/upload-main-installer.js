/**
 * برنامج الواتساب للجهاز الرئيسي: يرفع البرنامج (main-payload.zip) على تخزين الموقع، ويحط ملف التثبيت الصغير
 * وبيانات الملف داخل مجلد installers (ينرفعون مع الموقع). يتشغّل بعد كل بناء جديد للبرنامج:
 *
 *   في مجلد inovces:              node build-main.js
 *   في هذا المجلد:                set BLOB_READ_WRITE_TOKEN=...   ثم   node scripts/upload-main-installer.js
 *   ثم رفع الموقع:                npx vercel deploy --prod
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { put } = require('@vercel/blob');

(async () => {
  const dist = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'inovces', 'dist'));
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN مطلوب');
  const zip = path.join(dist, 'main-payload.zip');
  const stub = path.join(dist, 'main-setup.exe');
  for (const f of [zip, stub]) if (!fs.existsSync(f)) throw new Error(`الملف غير موجود: ${f} (شغّل node build-main.js في مجلد inovces)`);
  const data = fs.readFileSync(zip);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const blob = await put(`main/alwadi-whatsapp-${sha256.slice(0, 12)}.zip`, data, {
    access: 'public', addRandomSuffix: true, contentType: 'application/zip', token, multipart: true
  });
  const out = path.join(__dirname, '..', 'installers');
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(stub, path.join(out, 'main-setup.exe'));
  fs.writeFileSync(path.join(out, 'main-payload.json'), JSON.stringify({ url: blob.url, sha256, size: data.length, uploadedAt: new Date().toISOString() }, null, 2));
  console.log(`تم رفع البرنامج (${(data.length / 1048576).toFixed(1)} ميقا). ارفع الموقع الحين: npx vercel deploy --prod`);
})().catch((err) => { console.error('فشل الرفع:', err.message); process.exit(1); });
