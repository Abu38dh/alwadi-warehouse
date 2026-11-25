/**
 * رفع ملف الطابعة الأصلي (printer-setup.exe) على Vercel Blob — مرة وحدة (وكل ما انبنى ملف جديد).
 *
 *   set BLOB_READ_WRITE_TOKEN=...   (من فيرسيل: Storage ← Blob ← .env.local)
 *   node scripts/upload-installer.js ..\inovces\dist\printer-setup.exe
 *
 * يطبع الرابط: حطّه في فيرسيل باسم PRINTER_INSTALLER_URL
 */
const fs = require('fs');
const path = require('path');
const { put } = require('@vercel/blob');

(async () => {
  const file = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'inovces', 'dist', 'printer-setup.exe'));
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN مطلوب');
  if (!fs.existsSync(file)) throw new Error(`الملف غير موجود: ${file}`);
  const blob = await put('base/printer-setup.exe', fs.readFileSync(file), {
    access: 'public',
    addRandomSuffix: true,
    contentType: 'application/vnd.microsoft.portable-executable',
    token,
    multipart: true
  });
  console.log('تم الرفع. حط هذا في فيرسيل باسم PRINTER_INSTALLER_URL:');
  console.log(blob.url);
})().catch((err) => { console.error('فشل الرفع:', err.message); process.exit(1); });
