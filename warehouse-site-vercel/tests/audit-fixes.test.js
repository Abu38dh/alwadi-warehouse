/**
 * تصليحات الفحص الشامل: قفل الدخول، تسجيل أجهزة الطابعة، رفع الملفات، التسليم، النسخ الجديدة،
 * الفسوحات القديمة بدون فرع، وتغيير اسم الفرع الرئيسي.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakePdf, sha256, startSite, browser, setupAdmin, loginAs, newKey, upload, clearanceMeta } = require('./helpers');
const auth = require('../src/auth');
const branches = require('../src/services/branches');
const people = require('../src/services/people');
const { openDb } = require('../src/db');

test('الدخول: محاولات خاطئة كثيرة بنفس اللحظة ما تفك القفل، والكلمة الصحيحة تنتظر', async () => {
  const site = await startSite();
  try {
    await setupAdmin(site);
    const hash = await auth.hashPassword(site.config, 'right-password-1');
    site.db.prepare("INSERT INTO users (username, password_hash, full_name, role, active, created_at) VALUES ('victim', ?, 'v', 'warehouse', 1, ?)").run(hash, new Date().toISOString());
    const tries = [];
    for (let i = 0; i < 30; i++) { const b = browser(site.base); tries.push({ b, csrf: await b.csrf('/login') }); }
    await Promise.all(tries.map(({ b, csrf }, i) => b.postRaw('/login', { username: 'victim', password: 'wrong' + i, _csrf: csrf })));
    assert.ok(await auth.lockRemainingMs(site.db, auth.userKey('victim')) > 0, 'الحساب مقفل');
    const b = browser(site.base);
    const csrf = await b.csrf('/login');
    assert.equal((await b.postRaw('/login', { username: 'victim', password: 'right-password-1', _csrf: csrf })).status, 429);
  } finally { await site.close(); }
});

test('ملف وصل ناقص (البصمة غلط) ما ينحفظ، ونفس الملف من جهازين = مهمتين كل وحدة بملفها', async () => {
  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    const key = await newKey(admin);
    await branches.addInstallBranch(site.db, 'الرياض');
    const k = await branches.installKeyFor(site.db, 'الرياض');
    const a = await branches.enrollDevice(site.db, { installKey: k, deviceName: 'PC-A' });
    const b = await branches.enrollDevice(site.db, { installKey: k, deviceName: 'PC-B' });
    const up = async (dev, pdf, sha) => {
      const form = new FormData();
      form.append('meta', JSON.stringify({ file_name: 'p.pdf', sha256: sha }));
      form.append('pdf', new Blob([pdf], { type: 'application/pdf' }), 'p.pdf');
      const res = await fetch(`${site.base}/api/relay/upload`, { method: 'POST', headers: { authorization: `Bearer ${dev.token}`, 'x-device-id': String(dev.device_id) }, body: form });
      return { status: res.status, json: await res.json() };
    };
    const pdf = fakePdf('shared');
    assert.equal((await up(a, pdf, 'deadbeef')).status, 400);
    assert.equal(site.db.prepare('SELECT COUNT(*) n FROM relay_jobs').get().n, 0, 'ما انحفظ');

    const ja = (await up(a, pdf, sha256(pdf))).json;
    const jb = (await up(b, pdf, sha256(pdf))).json;
    assert.notEqual(ja.job_id, jb.job_id);
    const main = (method, p) => fetch(`${site.base}/api/integration${p}`, { method, headers: { authorization: `Bearer ${key}` } });
    await main('POST', `/relay/${ja.job_id}/received`);
    const fileB = await main('GET', `/relay/${jb.job_id}/file`);
    assert.equal(fileB.status, 200, 'ملف الجهاز الثاني باقي');
  } finally { await site.close(); }
});

test('التسليم: موصل فرع ثاني ما يستلم، والتسليم اللي ما تم ما يضيف اسم موصل', async () => {
  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    const key = await newKey(admin);
    const jeddahCourier = await people.createCourier(site.db, { name: 'موصل جدة', branch: 'جدة' });
    const pdf = fakePdf('riy');
    const id = (await (await upload(site, key, pdf, clearanceMeta(pdf, { branch: 'الرياض' }))).json()).id;
    site.db.prepare("UPDATE documents SET status = 'prepared' WHERE id = ?").run(id);
    const riy = await loginAs(site, { username: 'riy', branch: 'الرياض' });
    await riy.post('/handover', { doc_ids: id, courier_id: jeddahCourier }, `/documents/${id}`);
    assert.equal(site.db.prepare('SELECT status FROM documents WHERE id = ?').get(id).status, 'prepared');

    const pdf2 = fakePdf('riy-2');
    const id2 = (await (await upload(site, key, pdf2, clearanceMeta(pdf2, { branch: 'الرياض' }))).json()).id;
    await riy.post('/handover', { doc_ids: id2, courier_name: 'سالم' }, `/documents/${id2}`);
    assert.equal(site.db.prepare("SELECT COUNT(*) n FROM couriers WHERE name = 'سالم'").get().n, 0, 'الفسح ما كان جاهز => ما انضاف');
  } finally { await site.close(); }
});

test('نسخة جديدة من نفس الفسح فيها عميل مصحّح: العميل يتحدث وينكتب في السجل', async () => {
  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    const key = await newKey(admin);
    const v1 = fakePdf('x1-v1');
    const id = (await (await upload(site, key, v1, clearanceMeta(v1, { doc_no: 'X1', customer_number: null, customer_name: null, meta_problems: ['customer_number_missing'] }))).json()).id;
    const v2 = fakePdf('x1-v2');
    const r = await (await upload(site, key, v2, clearanceMeta(v2, { doc_no: 'X1', customer_number: '2222', customer_name: 'جديد' }))).json();
    assert.equal(r.id, id);
    const doc = site.db.prepare('SELECT customer_number, customer_name, meta_problems FROM documents WHERE id = ?').get(id);
    assert.equal(doc.customer_number, '2222');
    assert.equal(doc.customer_name, 'جديد');
    assert.equal(doc.meta_problems, '[]');
    // نسخة ما انقرأ فيها العميل: يبقى اللي عندنا
    const v3 = fakePdf('x1-v3');
    await upload(site, key, v3, clearanceMeta(v3, { doc_no: 'X1', customer_number: null, customer_name: null }));
    assert.equal(site.db.prepare('SELECT customer_number FROM documents WHERE id = ?').get(id).customer_number, '2222');
  } finally { await site.close(); }
});

test('الفسوحات القديمة بدون فرع تنحسب على الفرع الرئيسي، وتصحيح اسم الرئيسي ينقل كل شي له', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-db-'));
  try {
    let db = await openDb({ dataDir: dir });
    await db.prepare("DELETE FROM schema_migrations WHERE name = '008_documents_branch.sql'").run();
    await db.prepare("INSERT INTO documents (doc_type, customer_number, status, received_at, created_at) VALUES ('clearance', '1', 'received', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
    db.close();
    db = await openDb({ dataDir: dir });
    assert.equal((await db.prepare('SELECT branch FROM documents').get()).branch, 'جدة');

    await db.prepare("INSERT INTO users (username, password_hash, full_name, role, active, branch, created_at) VALUES ('j', 'x', 'j', 'warehouse', 1, 'جدة', ?)").run(new Date().toISOString());
    await branches.addInstallBranch(db, 'الرياض');
    await branches.setMainBranchName(db, 'جده');
    assert.equal((await db.prepare('SELECT branch FROM documents').get()).branch, 'جده');
    assert.equal((await db.prepare("SELECT branch FROM users WHERE username = 'j'").get()).branch, 'جده');
    assert.deepEqual(await branches.allBranches(db), ['جده', 'الرياض']);
    // اختيار فرع موجود كرئيسي: ما يندمج الفرعين
    await branches.setMainBranchName(db, 'الرياض');
    assert.equal((await db.prepare('SELECT branch FROM documents').get()).branch, 'جده');
    assert.deepEqual(await branches.allBranches(db), ['الرياض', 'جده']);
    db.close();
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
});

test('رقم الفاتورة في رسائل العميل: يطلع لو انقرأ، ولو ما انقرأ تطلع الرسالة سليمة بدون "رقم"', async () => {
  const notifications = require('../src/services/notifications');
  const t = notifications.DEFAULT_CONFIG.events.preparing.text;
  assert.match(t, /\{رقم_الفاتورة\}/);
  assert.equal(notifications.render(t, { sales_order_no: '1911020' }), 'السلام عليكم، طلبكم رقم 1911020 قيد التجهيز في المستودع.');
  assert.equal(notifications.render(t, {}), 'السلام عليكم، طلبكم قيد التجهيز في المستودع.');
  assert.equal(notifications.render('تم شحن طلبكم رقم {رقم_الفاتورة}. شكراً', {}), 'تم شحن طلبكم. شكراً');

  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    const key = await newKey(admin);
    const v1 = fakePdf('so-v1');
    const id = (await (await upload(site, key, v1, clearanceMeta(v1, { doc_no: 'S1', sales_order_no: '1911020' }))).json()).id;
    const page = await admin.html(`/documents/${id}`);
    assert.match(page, /رقم أمر الشراء<\/dt><dd dir="ltr">1911020/);
    const found = await admin.html('/documents?q=1911020');
    assert.match(found, new RegExp(`/documents/${id}"`), 'البحث برقم الفاتورة');
    // الرسالة المجهّزة للعميل فيها الرقم
    site.db.prepare("UPDATE documents SET status = 'received' WHERE id = ?").run(id);
    const qid = await notifications.enqueueForEvent(site.db, { docId: id, eventType: 'preparing' });
    assert.match(site.db.prepare('SELECT text FROM wa_notifications WHERE id = ?').get(qid).text, /طلبكم رقم 1911020 قيد التجهيز/);
    // نسخة جديدة فيها رقم فاتورة مصحّح
    const v2 = fakePdf('so-v2');
    await upload(site, key, v2, clearanceMeta(v2, { doc_no: 'S1', sales_order_no: '1911021' }));
    assert.equal(site.db.prepare('SELECT sales_order_no FROM documents WHERE id = ?').get(id).sales_order_no, '1911021');
  } finally { await site.close(); }
});

test('اسم العميل: الاسم العام من القروب ("عميل رقم") ما ينحفظ، والفسح بدون اسم ياخذ آخر اسم معروف لنفس العميل', async () => {
  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    const key = await newKey(admin);
    const ing = async (label, extra) => { const pdf = fakePdf(label); return (await (await upload(site, key, pdf, clearanceMeta(pdf, extra))).json()).id; };
    const name = (id) => site.db.prepare('SELECT customer_name FROM documents WHERE id = ?').get(id).customer_name;
    assert.equal(name(await ing('n1', { customer_number: '0004', customer_name: 'عميل رقم' })), null, 'اسم عام = بدون اسم');
    assert.equal(name(await ing('n2', { customer_number: '0004', customer_name: null })), null);
    assert.equal(name(await ing('n3', { customer_number: '1001', customer_name: 'مؤسسة النخبة' })), 'مؤسسة النخبة');
    assert.equal(name(await ing('n4', { customer_number: '1001', customer_name: null })), 'مؤسسة النخبة', 'نفس الاسم في كل فسوحات العميل');
    // تصحيح العميل بدون اسم => الاسم المعروف
    const missing = await ing('n5', { customer_number: null, customer_name: null, meta_problems: ['customer_number_missing'] });
    await require('../src/services/documents').setCustomer(site.db, { docId: missing, number: '1001', name: '', user: { id: 1 } });
    assert.equal(name(missing), 'مؤسسة النخبة');
  } finally { await site.close(); }
});

test('سند التسليم: إجباري وقت التسليم، ينحفظ مع الفسح، ويروح مع رسالة الشحن للبرنامج', async () => {
  const { TEST_RECEIPT } = require('./helpers');
  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    const key = await newKey(admin);
    const pdf = fakePdf('rcpt-1');
    const id = (await (await upload(site, key, pdf, clearanceMeta(pdf, { customer_number: '0004', sales_order_no: '1911620' }))).json()).id;
    site.db.prepare("UPDATE documents SET status = 'prepared' WHERE id = ?").run(id);
    const store = await loginAs(site, { username: 'st', branch: 'جدة' });
    const status = () => site.db.prepare('SELECT status FROM documents WHERE id = ?').get(id).status;

    // بدون سند: ما ينسلّم
    await store.post('/handover', { doc_ids: id, courier_name: 'ناصر', receipt: null }, `/documents/${id}`);
    assert.equal(status(), 'prepared', 'بدون سند ما ينسلّم');
    // ملف مو صورة ولا PDF: مرفوض
    await store.post('/handover', { doc_ids: id, courier_name: 'ناصر', receipt: { data: Buffer.from('hello world text file'), type: 'text/plain', name: 'a.txt' } }, `/documents/${id}`);
    assert.equal(status(), 'prepared', 'نوع غلط ما ينقبل');
    assert.equal(site.db.prepare("SELECT COUNT(*) n FROM couriers WHERE name = 'ناصر'").get().n, 0);

    // مع صورة: ينسلّم والسند محفوظ
    await store.post('/handover', { doc_ids: id, courier_name: 'ناصر' }, `/documents/${id}`);
    assert.equal(status(), 'handed_to_courier');
    const att = site.db.prepare('SELECT * FROM document_attachments WHERE document_id = ?').all(id);
    assert.equal(att.length, 1);
    assert.equal(att[0].mime, 'image/jpeg');

    // البرنامج يشوف الرسالة ومعها السند، ويقدر يحمّله (وبس سندات نفس الرسالة)
    const list = await (await fetch(`${site.base}/api/integration/notifications?limit=10`, { headers: { authorization: `Bearer ${key}` } })).json();
    const n = list.notifications.find(x => /تم شحن طلبكم رقم 1911620/.test(x.text));
    assert.ok(n, 'رسالة الشحن موجودة');
    assert.deepEqual(n.attachments.map(a => a.mime), ['image/jpeg']);
    const file = await fetch(`${site.base}/api/integration/notifications/${n.id}/attachments/${n.attachments[0].id}`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), TEST_RECEIPT);
    const other = list.notifications.find(x => x.id !== n.id);
    if (other) assert.equal((await fetch(`${site.base}/api/integration/notifications/${other.id}/attachments/${n.attachments[0].id}`, { headers: { authorization: `Bearer ${key}` } })).status, 404);
    assert.equal((await fetch(`${site.base}/api/integration/notifications/${n.id}/attachments/${n.attachments[0].id}`)).status, 401, 'بدون مفتاح ممنوع');

    // صفحة الفسح (الإدارة): السند يطلع ويفتح
    const page = await admin.html(`/documents/${id}`);
    assert.match(page, /سند التسليم/);
    assert.equal((await admin.get(`/documents/${id}/attachments/${att[0].id}`)).status, 200);
    // مستودع فرع ثاني ما يشوف السند
    const riy = await loginAs(site, { username: 'riy', branch: 'الرياض' });
    assert.equal((await riy.get(`/documents/${id}/attachments/${att[0].id}`)).status, 404);
  } finally { await site.close(); }
});
