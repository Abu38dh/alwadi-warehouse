/**
 * اختبارات موقع المستودع (المرحلة 1): الدخول، أول حساب إدارة، استقبال المستندات بدون تكرار، القائمة وعرض الـ PDF.
 * كل اختبار على قاعدة ومجلد بيانات مؤقتين.  التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const auth = require('../src/auth');

const { sha256, fakePdf, startSite, browser, ADMIN, setupAdmin, newKey, upload, clearanceMeta } = require('./helpers');

// ==========================================================

test('أول تشغيل: يطلب إنشاء حساب الإدارة مرة واحدة فقط', async () => {
  const site = await startSite();
  try {
    const b = browser(site.base);
    assert.equal((await b.get('/')).headers.get('location'), '/login');
    assert.equal((await b.get('/login')).headers.get('location'), '/setup');

    let res = await b.post('/setup', { ...ADMIN, password: 'short', password2: 'short' });
    assert.equal(res.status, 400);
    res = await b.post('/setup', { ...ADMIN, password2: 'different-one' });
    assert.equal(res.status, 400);
    res = await b.post('/setup', { ...ADMIN, username: 'مدير' });
    assert.equal(res.status, 400);
    assert.equal(site.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);

    res = await b.post('/setup', ADMIN);
    assert.equal(res.headers.get('location'), '/admin/integration');
    const user = site.db.prepare('SELECT * FROM users').get();
    assert.equal(user.role, 'admin');
    assert.notEqual(user.password_hash, ADMIN.password);
    assert.match(user.password_hash, /^\$2[aby]\$/, 'كلمة المرور مخزنة bcrypt');
    assert.equal((await b.get('/admin/integration')).status, 200, 'دخل مباشرة بعد الإنشاء');

    // الصفحة تُقفل بعد أول حساب
    const other = browser(site.base);
    assert.equal((await other.get('/setup')).headers.get('location'), '/login');
    const again = await other.post('/setup', { ...ADMIN, username: 'hacker' }, '/login');
    assert.equal(again.headers.get('location'), '/login');
    assert.equal(site.db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  } finally { await site.close(); }
});

test('في الإنتاج: إنشاء أول حساب يحتاج رمز SETUP_TOKEN', async () => {
  const site = await startSite({ setupToken: 'the-setup-token' });
  try {
    const b = browser(site.base);
    let res = await b.post('/setup', { ...ADMIN, setup_token: 'wrong' });
    assert.equal(res.status, 403);
    assert.equal(site.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
    res = await b.post('/setup', { ...ADMIN, setup_token: 'the-setup-token' });
    assert.equal(res.status, 302);
    assert.equal(site.db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  } finally { await site.close(); }
});

test('الدخول: كلمة مرور خاطئة تُرفض، والصحيحة تدخل، والخروج ينهي الجلسة', async () => {
  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    await admin.post('/logout', {}, '/documents');
    assert.equal((await admin.get('/documents')).headers.get('location'), '/login');

    const b = browser(site.base);
    let res = await b.post('/login', { username: 'admin', password: 'wrong-password' });
    assert.equal(res.status, 401);
    assert.equal((await b.get('/documents')).headers.get('location'), '/login');

    res = await b.post('/login', { username: 'ADMIN', password: ADMIN.password });
    assert.equal(res.headers.get('location'), '/documents', 'اسم المستخدم لا يفرّق بين الحروف الكبيرة والصغيرة، والإدارة تبدأ من الفسوحات');
    assert.equal((await b.get('/documents')).status, 200);

    const actions = site.db.prepare('SELECT action FROM audit_log ORDER BY id').all().map(r => r.action);
    assert.deepEqual(actions, ['setup_first_admin', 'logout', 'login_failed', 'login']);
  } finally { await site.close(); }
});

test('القفل: 5 محاولات خاطئة تقفل الدخول 15 دقيقة حتى بكلمة المرور الصحيحة', async () => {
  const site = await startSite();
  try {
    await setupAdmin(site);
    const b = browser(site.base);
    for (let i = 1; i <= 4; i++) {
      assert.equal((await b.post('/login', { username: 'admin', password: `bad-${i}` })).status, 401, `محاولة ${i}`);
    }
    assert.equal((await b.post('/login', { username: 'admin', password: 'bad-5' })).status, 429, 'المحاولة الخامسة تقفل');
    const locked = await b.post('/login', { username: 'admin', password: ADMIN.password });
    assert.equal(locked.status, 429, 'الصحيحة مرفوضة أثناء القفل');
    assert.match(await locked.text(), /مقفل مؤقتاً/);

    // بعد انتهاء مدة القفل يرجع الدخول
    site.db.prepare('UPDATE login_throttle SET locked_until = ?').run(Date.now() - 1000);
    assert.equal((await b.post('/login', { username: 'admin', password: ADMIN.password })).headers.get('location'), '/documents');
  } finally { await site.close(); }
});

test('CSRF: أي طلب تغيير بدون رمز الصفحة يُرفض', async () => {
  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    const before = site.db.prepare("SELECT value_json FROM settings WHERE key = 'integration_key'").get();
    assert.equal((await admin.postRaw('/admin/integration/rotate', {})).status, 403);
    assert.equal((await admin.postRaw('/admin/integration/rotate', { _csrf: 'made-up' })).status, 403);
    assert.deepEqual(site.db.prepare("SELECT value_json FROM settings WHERE key = 'integration_key'").get(), before);
    const anon = browser(site.base);
    assert.equal((await anon.postRaw('/login', { username: 'admin', password: ADMIN.password })).status, 403);
  } finally { await site.close(); }
});

test('الصلاحيات في السيرفر: مسؤول المستودع لا يفتح صفحات الإدارة، والحساب الموقوف تنتهي جلسته فوراً', async () => {
  const site = await startSite();
  try {
    await setupAdmin(site);
    const hash = await auth.hashPassword(site.config, 'warehouse-pass-1');
    site.db.prepare("INSERT INTO users (username, password_hash, full_name, role, active, created_at) VALUES ('store', ?, 'مسؤول التجربة', 'warehouse', 1, ?)").run(hash, new Date().toISOString());

    const w = browser(site.base);
    assert.equal((await w.post('/login', { username: 'store', password: 'warehouse-pass-1' })).headers.get('location'), '/documents');
    assert.equal((await w.get('/documents')).status, 200);
    assert.equal((await w.get('/admin/integration')).status, 403);
    const csrf = await w.csrf('/documents');
    assert.equal((await w.postRaw('/admin/integration/rotate', { _csrf: csrf })).status, 403);
    assert.equal(site.db.prepare("SELECT COUNT(*) n FROM settings WHERE key = 'integration_key'").get().n, 0);

    site.db.prepare("UPDATE users SET active = 0 WHERE username = 'store'").run();
    assert.equal((await w.get('/documents')).headers.get('location'), '/login');
    assert.equal((await browser(site.base).post('/login', { username: 'store', password: 'warehouse-pass-1' })).status, 401);
  } finally { await site.close(); }
});

test('واجهة الربط: بدون مفتاح صحيح لا يُقبل شيء، والمفتاح القديم يتوقف عند إنشاء جديد', async () => {
  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    const pdf = fakePdf('auth');
    assert.equal((await upload(site, null, pdf, clearanceMeta(pdf))).status, 401, 'قبل إنشاء أي مفتاح');
    assert.equal((await upload(site, 'wh_guess', pdf, clearanceMeta(pdf))).status, 401);

    const key1 = await newKey(admin);
    assert.equal(site.db.prepare("SELECT value_json FROM settings WHERE key = 'integration_key'").get().value_json.includes(key1), false, 'المفتاح نفسه لا يُحفظ في القاعدة');
    assert.equal((await upload(site, key1, pdf, clearanceMeta(pdf))).status, 201);

    const key2 = await newKey(admin);
    assert.notEqual(key1, key2);
    const pdf2 = fakePdf('auth-2');
    assert.equal((await upload(site, key1, pdf2, clearanceMeta(pdf2))).status, 401, 'المفتاح القديم توقف');
    assert.equal((await upload(site, key2, pdf2, clearanceMeta(pdf2))).status, 201);
    assert.equal(site.db.prepare('SELECT COUNT(*) n FROM documents').get().n, 2);
  } finally { await site.close(); }
});

test('استقبال الفسح: جديد => 201، ونفس الملف مرة ثانية => 200 duplicate بدون أي تكرار', async () => {
  const site = await startSite();
  try {
    const key = await newKey(await setupAdmin(site));
    const pdf = fakePdf('first');

    const r1 = await upload(site, key, pdf, clearanceMeta(pdf));
    assert.equal(r1.status, 201);
    const b1 = await r1.json();
    assert.deepEqual({ ok: b1.ok, duplicate: b1.duplicate, sha256: b1.sha256 }, { ok: true, duplicate: false, sha256: sha256(pdf) });

    for (let i = 0; i < 3; i++) {
      const r = await upload(site, key, pdf, clearanceMeta(pdf));
      assert.equal(r.status, 200);
      const b = await r.json();
      assert.equal(b.duplicate, true);
      assert.equal(b.id, b1.id);
      assert.equal(b.sha256, sha256(pdf));
    }
    assert.equal(site.db.prepare('SELECT COUNT(*) n FROM documents').get().n, 1);
    assert.equal(site.db.prepare('SELECT COUNT(*) n FROM document_files').get().n, 1);
    assert.equal(site.db.prepare('SELECT COUNT(*) n FROM document_events').get().n, 1);

    const doc = site.db.prepare('SELECT * FROM documents').get();
    assert.equal(doc.status, 'received');
    assert.equal(doc.customer_number, '3339');
    assert.equal(doc.customer_name, 'مؤسسة التجربة');
    assert.equal(doc.source_device, 'ACC-PC-1');
    const file = site.db.prepare('SELECT * FROM document_files').get();
    const saved = Buffer.concat(site.db.prepare('SELECT data FROM file_chunks WHERE key = ? ORDER BY idx').all(file.path).map(r => r.data));
    assert.deepEqual(saved, pdf, 'الملف محفوظ كما هو');
  } finally { await site.close(); }
});

test('استقبال الفسح: الملفات والبيانات غير المقبولة تُرفض ولا يُسجَّل شيء', async () => {
  const site = await startSite({ maxPdfBytes: 5000 });
  try {
    const key = await newKey(await setupAdmin(site));
    const pdf = fakePdf('reject');
    const status = async (...args) => (await upload(site, key, ...args)).status;

    assert.equal(await status(Buffer.from('<html>not a pdf</html>'.repeat(20)), clearanceMeta(pdf, { sha256: undefined })), 400, 'ليس PDF');
    assert.equal(await status(pdf, clearanceMeta(pdf, { sha256: 'a'.repeat(64) })), 400, 'بصمة لا تطابق');
    assert.equal(await status(pdf, clearanceMeta(pdf, { doc_type: 'invoice' })), 422, 'الفاتورة لا تذهب للمستودع');
    assert.equal(await status(pdf, '{broken json'), 400);
    assert.equal(await status(null, clearanceMeta(pdf)), 400, 'بدون ملف');
    const big = Buffer.concat([pdf, Buffer.alloc(6000, 48)]);
    assert.equal(await status(big, clearanceMeta(big)), 413, 'أكبر من الحد');

    assert.equal(site.db.prepare('SELECT COUNT(*) n FROM documents').get().n, 0);
    assert.equal(site.db.prepare('SELECT COUNT(*) n FROM document_files').get().n, 0);
  } finally { await site.close(); }
});

test('بيانات ناقصة: فسح بدون رقم عميل يُقبل ويُعلَّم، وكل فسح بدون رقم مستند مستند مستقل', async () => {
  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    const key = await newKey(admin);
    const a = fakePdf('missing-a');
    const b = fakePdf('missing-b');
    assert.equal((await upload(site, key, a, clearanceMeta(a, { customer_number: null, customer_name: null, meta_problems: ['customer_number_missing'] }))).status, 201);
    assert.equal((await upload(site, key, b, clearanceMeta(b))).status, 201);
    assert.equal(site.db.prepare('SELECT COUNT(*) n FROM documents').get().n, 2);

    const html = await (await admin.get('/documents')).text();
    assert.match(html, /بيانات ناقصة/);
    assert.match(html, /العميل غير معروف/);
    const detail = await (await admin.get('/documents/1')).text();
    assert.match(detail, /رقم العميل غير مقروء في المستند/);
  } finally { await site.close(); }
});

test('نفس رقم المستند بملف مختلف: نسخة جديدة وعلامة "تعدّل" (لا مستند مكرر ولا حذف)', async () => {
  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    const key = await newKey(admin);
    const v1 = fakePdf('v1');
    const v2 = fakePdf('v2');
    assert.equal((await upload(site, key, v1, clearanceMeta(v1, { doc_no: '48921' }))).status, 201);
    const r2 = await upload(site, key, v2, clearanceMeta(v2, { doc_no: '48921' }));
    assert.equal(r2.status, 201);
    assert.deepEqual((({ version, modified }) => ({ version, modified }))(await r2.json()), { version: 2, modified: true });

    assert.equal(site.db.prepare('SELECT COUNT(*) n FROM documents').get().n, 1);
    assert.equal(site.db.prepare('SELECT modified_flag FROM documents').get().modified_flag, 1);
    assert.deepEqual(site.db.prepare('SELECT type FROM document_events ORDER BY id').all().map(e => e.type), ['received', 'modified']);

    assert.deepEqual(Buffer.from(await (await admin.get('/documents/1/pdf')).arrayBuffer()), v2, 'الافتراضي آخر نسخة');
    assert.deepEqual(Buffer.from(await (await admin.get('/documents/1/pdf?v=1')).arrayBuffer()), v1, 'النسخة الأولى محفوظة');
    assert.match(await (await admin.get('/documents/1')).text(), /فسح 48921/);
  } finally { await site.close(); }
});

test('القائمة والتفاصيل والـ PDF: لمستخدم مسجّل فقط', async () => {
  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    const key = await newKey(admin);
    const pdf = fakePdf('view');
    assert.equal((await upload(site, key, pdf, clearanceMeta(pdf))).status, 201);

    // بدون دخول: لا قائمة ولا ملف
    const anon = browser(site.base);
    for (const url of ['/documents', '/documents/1', '/documents/1/pdf', '/documents/1/view', '/documents/1/pdf-data', '/documents/cards', '/admin/integration']) {
      const res = await anon.get(url);
      assert.equal(res.status, 302, url);
      assert.equal(res.headers.get('location'), '/login', url);
    }
    const viaScript = await anon.get('/documents/cards', { headers: { 'x-requested-with': 'fetch', accept: 'application/json' } });
    assert.equal(viaScript.status, 401);

    // بعد الدخول
    const list = await (await admin.get('/documents')).text();
    assert.match(list, /فسح #1/);
    assert.match(list, /مؤسسة التجربة/);
    assert.match(list, /عميل 3339/);

    const cards = await (await admin.get('/documents/cards?status=received', { headers: { 'x-requested-with': 'fetch', accept: 'application/json' } })).json();
    assert.equal(cards.latestId, 1);
    assert.equal(cards.counts.received, 1);
    assert.match(cards.html, /href="\/documents\/1"/);
    const other = await (await admin.get('/documents/cards?status=prepared', { headers: { 'x-requested-with': 'fetch' } })).json();
    assert.match(other.html, /documents\/1"/, 'قائمة وحدة لكل المراحل');

    const detail = await (await admin.get('/documents/1')).text();
    assert.match(detail, /وصل للمستودع/);
    assert.match(detail, /وصل المستند للمستودع/);
    assert.match(detail, /ACC-PC-1/);

    const file = await admin.get('/documents/1/pdf');
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    assert.match(file.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), pdf);
    assert.match(file.headers.get('content-disposition'), /^inline/);
    assert.match((await admin.get('/documents/1/pdf?download=1')).headers.get('content-disposition'), /^attachment/);

    // العارض داخل الموقع: الزر يفتح صفحة العارض، والعارض يأخذ الملف كبيانات (لا تخطفه برامج التنزيل)
    assert.match(detail, /href="\/documents\/1\/view"/);
    const viewer = await (await admin.get('/documents/1/view')).text();
    assert.match(viewer, /data-src="\/documents\/1\/pdf-data\?v=1"/);
    assert.match(viewer, /src="\/static\/js\/viewer\.js\?v=[0-9a-f]{10}"/, 'مع رقم النسخة (المتصفح ياخذ الجديد بعد كل تعديل)');
    const data = await (await admin.get('/documents/1/pdf-data', { headers: { accept: 'application/json' } })).json();
    assert.deepEqual(Buffer.from(data.base64, 'base64'), pdf);
    for (const asset of ['/static/js/viewer.js', '/static/vendor/pdfjs/legacy/build/pdf.min.mjs', '/static/vendor/pdfjs/legacy/build/pdf.worker.min.mjs', '/static/css/app.css', '/static/img/logo.png']) {
      const res = await fetch(site.base + asset);
      assert.equal(res.status, 200, asset);
      if (/\.m?js$/.test(asset)) assert.match(res.headers.get('content-type'), /javascript/, asset);
    }

    for (const url of ['/documents/999', '/documents/999/pdf', '/documents/999/view', '/documents/abc', '/documents/1/pdf?v=7', '/documents/1/view?v=7', '/documents/1/pdf-data?v=7']) {
      assert.equal((await admin.get(url)).status, 404, url);
    }
  } finally { await site.close(); }
});

test('نصوص المستند تُعرض كنص فقط (لا يُنفَّذ أي HTML قادم من بيانات المستند)', async () => {
  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    const key = await newKey(admin);
    const pdf = fakePdf('xss');
    await upload(site, key, pdf, clearanceMeta(pdf, { customer_name: '<script>alert(1)</script>', source_device: '"><img src=x onerror=alert(1)>' }));
    for (const url of ['/documents', '/documents/1']) {
      const html = await (await admin.get(url)).text();
      assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, url);
      assert.doesNotMatch(html, /<img src=x/, url);
    }
    const res = await admin.get('/documents');
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  } finally { await site.close(); }
});

test('سجل المستند إضافة فقط: التعديل والحذف مرفوضان من القاعدة نفسها', async () => {
  const site = await startSite();
  try {
    const key = await newKey(await setupAdmin(site));
    const pdf = fakePdf('events');
    await upload(site, key, pdf, clearanceMeta(pdf));
    assert.throws(() => site.db.prepare("UPDATE document_events SET text = 'x'").run(), /append-only/);
    assert.throws(() => site.db.prepare('DELETE FROM document_events').run(), /append-only/);
    assert.equal(site.db.prepare('SELECT COUNT(*) n FROM document_events').get().n, 1);
  } finally { await site.close(); }
});

test('البيانات تبقى بعد إعادة تشغيل الموقع (القاعدة والجلسة ومفتاح الربط)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-site-restart-'));
  const boot = async () => {
    const config = loadConfig({ dataDir, bcryptRounds: 4, production: false, secureCookies: false, trustProxy: false, setupToken: '' });
    const db = await openDb({ dataDir });
    const app = createApp({ config, db });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    return { base: `http://127.0.0.1:${server.address().port}`, db, config, stop: async () => { app.locals.sessionStore.close(); await new Promise(r => { server.closeAllConnections(); server.close(r); }); db.close(); } };
  };
  let site = await boot();
  try {
    const admin = await setupAdmin(site);
    const key = await newKey(admin);
    const pdf = fakePdf('restart');
    assert.equal((await upload(site, key, pdf, clearanceMeta(pdf))).status, 201);
    assert.equal((await admin.get('/documents')).status, 200);
    await site.stop();

    site = await boot();
    // الجلسة محفوظة في القاعدة: المستخدم يبقى داخلاً بعد إعادة التشغيل
    const stillIn = await fetch(`${site.base}/documents`, { redirect: 'manual', headers: { accept: 'text/html', cookie: admin.cookie() } });
    assert.equal(stillIn.status, 200);
    // نفس الملف بعد إعادة التشغيل: مكرر
    const again = await upload(site, key, pdf, clearanceMeta(pdf));
    assert.equal(again.status, 200);
    assert.equal((await again.json()).duplicate, true);
    assert.equal((await site.db.prepare('SELECT COUNT(*) n FROM documents').get()).n, 1);
  } finally {
    await site.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }
});
