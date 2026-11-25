/**
 * اسم الموظف اللي يجهّز، واسم الموصل: أسماء فقط بدون حسابات، تنكتب أو تنختار وقت الشغل.
 * التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePdf, startSite, setupAdmin, loginAs, newKey, upload, clearanceMeta } = require('./helpers');

async function world(n = 3) {
  const site = await startSite();
  const admin = await setupAdmin(site);
  const key = await newKey(admin);
  for (let i = 1; i <= n; i++) {
    const pdf = fakePdf(`names-${i}`);
    assert.equal((await upload(site, key, pdf, clearanceMeta(pdf, { customer_name: `عميل ${i}` }))).status, 201);
  }
  const store = await loginAs(site, { username: 'store', fullName: 'جوال المستودع' });
  const doc = (id) => site.db.prepare(`
    SELECT d.*, w.name AS worker, c.name AS courier FROM documents d
    LEFT JOIN workers w ON w.id = d.preparer_worker_id LEFT JOIN couriers c ON c.id = d.courier_id WHERE d.id = ?`).get(id);
  const count = (table) => site.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const start = (id, form) => store.postAndFollow(`/documents/${id}/advance`, { expected_status: 'received', ...form }, `/documents/${id}`);
  const finish = (id) => store.post(`/documents/${id}/advance`, { expected_status: 'preparing' }, `/documents/${id}`);
  return { site, admin, store, doc, count, start, finish };
}

test('بدء التجهيز يطلب اسم الموظف: أول مرة يُكتب، وبعدها يظهر في القائمة للاختيار', async () => {
  const w = await world(3);
  try {
    let page = await w.store.html('/documents/1');
    assert.match(page, /مين يجهّز هذا الطلب؟/);
    assert.match(page, />اسم الموظف:</, 'ما فيه أسماء بعد => خانة كتابة فقط');
    assert.doesNotMatch(page, /name="worker_name" value=/);

    // بدون اسم: ما يبدأ
    let r = await w.start(1, {});
    assert.match(r.html, /اختر اسم الموظف اللي يجهّز الطلب أو اكتبه/);
    assert.equal(w.doc(1).status, 'received');
    assert.equal(w.count('workers'), 0);

    r = await w.start(1, { worker_name_new: '  محمد  ' });
    assert.match(r.html, /بدأ التجهيز — يجهّزه محمد/);
    assert.equal(w.doc(1).status, 'preparing');
    assert.equal(w.doc(1).worker, 'محمد');
    assert.match(r.html, /يجهّزه: محمد/);

    // المستند الثاني: الاسم صار في القائمة (واحد بس => محدد تلقائياً)
    page = await w.store.html('/documents/2');
    assert.match(page, /name="worker_name" value="محمد" checked/);
    assert.match(page, /أو اكتب اسم موظف جديد/);
    await w.start(2, { worker_name: 'محمد' });
    assert.equal(w.doc(2).worker, 'محمد');
    assert.equal(w.count('workers'), 1, 'ما تكرر الاسم');

    // اسم جديد مكتوب يتقدم على المختار، ونفس الاسم بحروف مختلفة ما يتكرر
    await w.start(3, { worker_name: 'محمد', worker_name_new: 'Ahmed' });
    assert.equal(w.doc(3).worker, 'Ahmed');
    await w.site.db.prepare("UPDATE documents SET status = 'received', preparer_worker_id = NULL WHERE id = 3").run();
    await w.start(3, { worker_name_new: 'AHMED' });
    assert.equal(w.count('workers'), 2);

    // الاسم يظهر في القائمة وسجل الفسح
    assert.match(await w.store.html('/documents?status=preparing'), /class="tl-who">محمد</, 'اسم اللي يجهّز تحت "بدأ التجهيز"');
    assert.match(await w.admin.html('/documents/1'), /— يجهّزه محمد/);
    // الحساب اللي ضغط الزر محفوظ للسجل
    assert.equal(w.doc(1).preparer_user_id, w.site.db.prepare("SELECT id FROM users WHERE username = 'store'").get().id);
  } finally { await w.site.close(); }
});

test('التسليم: يُكتب اسم الموصل مباشرة بدون أي حساب أو إضافة مسبقة، وبعدها يظهر للاختيار', async () => {
  const w = await world(3);
  try {
    for (const id of [1, 2, 3]) { await w.start(id, { worker_name_new: 'محمد' }); await w.finish(id); }

    // التسليم من صفحة الفسح نفسها
    let page = await w.store.html('/documents/1');
    assert.match(page, /مين الموصل اللي استلم الطلب؟/);
    assert.match(page, />اسم الموصل:</);
    assert.doesNotMatch(page, /href="\/handover"/, 'ما فيه صفحة تسليم منفصلة في القائمة');

    let r = await w.store.postAndFollow('/handover', { doc_ids: [1] }, '/documents');
    assert.match(r.html, /اختر الموصل أو اكتب اسمه/);
    assert.equal(w.doc(1).status, 'prepared');

    r = await w.store.postAndFollow('/handover', { courier_name: 'سالم', doc_ids: [1, 2] }, '/documents');
    assert.match(r.html, /تم تسليم مستندين للموصل سالم/);
    assert.equal(w.doc(1).courier, 'سالم');
    assert.equal(w.doc(2).courier, 'سالم');
    assert.equal(w.count('couriers'), 1);

    page = await w.store.html('/documents/3');
    assert.match(page, /name="courier_id" value="\d+"[\s\S]*سالم/, 'الاسم صار في القائمة');
    assert.match(page, /أو اكتب اسم موصل جديد/);

    // نفس الاسم مكتوب مرة ثانية: ما يتكرر
    await w.store.post('/handover', { courier_name: 'سالم ', doc_ids: [3] }, '/documents');
    assert.equal(w.doc(3).courier, 'سالم');
    assert.equal(w.count('couriers'), 1);
    assert.match(await w.admin.html('/documents/3'), /الموصل: سالم/);
  } finally { await w.site.close(); }
});

test('الإدارة: صفحة الموظفين والموصلين — أسماء فقط، تعديل وإيقاف، والموقوف ما يظهر للاختيار', async () => {
  const w = await world(2);
  try {
    let page = await w.admin.html('/admin/couriers');
    assert.match(page, /الموظفون والموصلون/);

    let r = await w.admin.postAndFollow('/admin/workers', { name: 'خالد' }, '/admin/couriers');
    assert.match(r.html, /تمت إضافة الموظف/);
    r = await w.admin.postAndFollow('/admin/workers', { name: 'خالد' }, '/admin/couriers');
    assert.match(r.html, /موجود في القائمة/);
    await w.admin.post('/admin/workers', { name: 'سعد' }, '/admin/couriers');

    const khaled = w.site.db.prepare("SELECT id FROM workers WHERE name = 'خالد'").get().id;
    await w.admin.post(`/admin/workers/${khaled}`, { name: 'خالد' }, '/admin/couriers'); // بدون active = إيقاف
    page = await w.store.html('/documents/1');
    assert.doesNotMatch(page, /value="خالد"/, 'الموقوف ما يظهر');
    assert.match(page, /value="سعد"/);

    // لو أحد كتب اسم موقوف، يرجع فعّال (ما يتكرر)
    await w.start(1, { worker_name_new: 'خالد' });
    assert.equal(w.site.db.prepare('SELECT active FROM workers WHERE id = ?').get(khaled).active, 1);
    assert.equal(w.count('workers'), 2);

    // مسؤول المستودع ما يدخل صفحة الإدارة
    assert.equal((await w.store.get('/admin/couriers')).status, 403);
    const csrf = await w.store.csrf('/documents');
    assert.equal((await w.store.postRaw('/admin/workers', { _csrf: csrf, name: 'دخيل' })).status, 403);

    // التصحيح للخلف يمسح اسم الموظف من المستند (ويبقى في السجل)
    await w.admin.post('/documents/1/correct', { expected_status: 'preparing', reason: 'بدأه بالغلط' }, '/documents/1');
    assert.equal(w.doc(1).preparer_worker_id, null);
    const ev = w.site.db.prepare("SELECT worker_id FROM document_events WHERE document_id = 1 AND to_status = 'preparing'").get();
    assert.equal(ev.worker_id, khaled);

  } finally { await w.site.close(); }
});
