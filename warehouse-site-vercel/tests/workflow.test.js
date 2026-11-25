/**
 * اختبارات المرحلة 2: الحالات، الصلاحيات، السجل، الملاحظات والنواقص، الموصلون، التسليم الجماعي، التصحيح،
 * وإدارة المستخدمين وحسابي.  التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePdf, startSite, browser, ADMIN, setupAdmin, loginAs, newKey, upload, clearanceMeta } = require('./helpers');

/** موقع فيه إدارة + مسؤول مستودع + عدد من الفسوحات الجديدة */
async function world({ docs = 1 } = {}) {
  const site = await startSite();
  const admin = await setupAdmin(site);
  const key = await newKey(admin);
  for (let i = 1; i <= docs; i++) {
    const pdf = fakePdf(`doc-${i}`);
    assert.equal((await upload(site, key, pdf, clearanceMeta(pdf, { customer_number: String(1000 + i), customer_name: `عميل ${i}` }))).status, 201);
  }
  const store = await loginAs(site, { username: 'store', fullName: 'مسؤول المستودع' });
  const doc = (id) => site.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  const events = (id) => site.db.prepare('SELECT * FROM document_events WHERE document_id = ? ORDER BY id').all(id);
  const userId = (username) => site.db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
  const addCourier = async (name, phone = '') => {
    await admin.post('/admin/couriers', { name, phone });
    return site.db.prepare('SELECT id FROM couriers WHERE name = ?').get(name).id;
  };
  const advance = (b, id, expected, worker = 'محمد') => b.postAndFollow(`/documents/${id}/advance`, { expected_status: expected, worker_name_new: worker }, `/documents/${id}`);
  /** تجهيز مستند حتى "تم التجهيز" */
  const prepare = async (id) => { await advance(store, id, 'received'); await advance(store, id, 'preparing'); };
  return { site, admin, store, key, doc, events, userId, addCourier, advance, prepare };
}

// ==========================================================
// الحالات
// ==========================================================

test('دورة المستند كاملة: وصل ← قيد التجهيز ← تم التجهيز ← سُلّم للموصل، وكل خطوة في السجل باسم صاحبها', async () => {
  const w = await world();
  try {
    const courierId = await w.addCourier('موصل التجربة', '0500000001');
    const storeId = w.userId('store');

    let page = await w.store.html('/documents/1');
    assert.match(page, /بدء التجهيز/);
    assert.doesNotMatch(page, /تصحيح: إرجاع/, 'التصحيح لا يظهر لمسؤول المستودع');

    let r = await w.advance(w.store, 1, 'received');
    assert.equal(r.location, '/documents/1');
    assert.match(r.html, /قيد التجهيز/);
    assert.match(r.html, /تم التجهيز/, 'زر الخطوة التالية');
    assert.equal(w.doc(1).status, 'preparing');
    assert.equal(w.doc(1).preparer_user_id, storeId);
    assert.ok(w.doc(1).prep_started_at);

    r = await w.advance(w.store, 1, 'preparing');
    assert.equal(w.doc(1).status, 'prepared');
    assert.ok(w.doc(1).prepared_at);
    // التسليم من صفحة الفسح نفسها: نموذج فيه الموصلين وزر "تسليم للموصل"
    assert.match(r.html, /<form method="post" action="\/handover" class="card action-card handover-form"/, 'نموذج التسليم في صفحة الفسح');
    assert.match(r.html, /name="doc_ids" value="1"/);
    assert.match(r.html, /موصل التجربة/);
    assert.equal((await w.store.get('/handover?ids=1')).headers.get('location'), '/documents/1', 'الرابط القديم يفتح صفحة الفسح');

    const done = await w.store.postAndFollow('/handover', { courier_id: courierId, doc_ids: [1] }, '/documents/1');
    assert.match(done.html, /تم تسليم مستند واحد للموصل موصل التجربة/);
    const d = w.doc(1);
    assert.equal(d.status, 'handed_to_courier');
    assert.equal(d.courier_id, courierId);
    assert.equal(d.handed_by_user_id, storeId);
    assert.ok(d.handed_over_at);

    const ev = w.events(1);
    assert.deepEqual(ev.map(e => [e.type, e.from_status, e.to_status]), [
      ['received', null, 'received'],
      ['status_change', 'received', 'preparing'],
      ['status_change', 'preparing', 'prepared'],
      ['status_change', 'prepared', 'handed_to_courier']
    ]);
    assert.deepEqual(ev.slice(1).map(e => e.user_id), [storeId, storeId, storeId]);
    assert.equal(ev[3].courier_id, courierId);

    // الإدارة تشوف السجل كاملاً بالأسماء
    page = await w.admin.html('/documents/1');
    assert.match(page, /سُلّم للموصل: موصل التجربة/);
    assert.match(page, /مسؤول المستودع/);
  } finally { await w.site.close(); }
});

test('لا قفز بين المراحل: طلب خطوة لا تطابق حالة المستند يُرفض والحالة لا تتغير', async () => {
  const w = await world();
  try {
    const courierId = await w.addCourier('موصل');
    // المستند "وصل": محاولة "تم التجهيز" مباشرة
    let r = await w.advance(w.store, 1, 'preparing');
    assert.match(r.html, /تغيّرت حالة الفسح/);
    assert.equal(w.doc(1).status, 'received');
    // قيمة غير معروفة
    r = await w.advance(w.store, 1, 'prepared');
    assert.match(r.html, /غير متاح/);
    r = await w.advance(w.store, 1, 'handed_to_courier');
    assert.equal(w.doc(1).status, 'received');
    // تسليم مستند لم يتجهز
    const h = await w.store.postAndFollow('/handover', { courier_id: courierId, doc_ids: [1] }, '/documents');
    assert.match(h.html, /ما انسلّم شيء/);
    assert.equal(w.doc(1).status, 'received');
    assert.equal(w.events(1).length, 1, 'لا شيء تسجّل');
  } finally { await w.site.close(); }
});

test('ضغطتان بنفس اللحظة: الأولى تنجح والثانية ترى "تغيّرت الحالة" (خطوة واحدة فقط)', async () => {
  const w = await world();
  try {
    // نفس الطلب مرتين (نفس الحالة المتوقعة) — كأن الزر انضغط مرتين أو من جهازين
    const first = await w.advance(w.store, 1, 'received');
    const second = await w.advance(w.admin, 1, 'received');
    assert.doesNotMatch(first.html, /تغيّرت حالة الفسح/);
    assert.match(second.html, /تغيّرت حالة الفسح/);
    assert.equal(w.doc(1).status, 'preparing', 'تقدمت خطوة واحدة فقط');
    assert.equal(w.events(1).filter(e => e.type === 'status_change').length, 1);
    assert.equal(w.doc(1).preparer_user_id, w.userId('store'), 'المسجَّل هو صاحب الضغطة الأولى');

    // طلبان متزامنان فعلاً
    const [a, b] = await Promise.all([w.advance(w.store, 1, 'preparing'), w.advance(w.admin, 1, 'preparing')]);
    assert.equal([a, b].filter(x => /تغيّرت حالة الفسح/.test(x.html)).length, 1, 'واحد فقط يُرفض');
    assert.equal(w.doc(1).status, 'prepared');
    assert.equal(w.events(1).filter(e => e.type === 'status_change').length, 2);
  } finally { await w.site.close(); }
});

// ==========================================================
// التسليم للموصل
// ==========================================================

test('تسليم عدة مستندات لنفس الموصل دفعة واحدة، والمستند غير الجاهز يُتخطى بدون ما يفشل الباقي', async () => {
  const w = await world({ docs: 4 });
  try {
    const courierId = await w.addCourier('موصل الدفعة');
    for (const id of [1, 2, 3]) await w.prepare(id);
    await w.advance(w.store, 4, 'received'); // الرابع ما زال قيد التجهيز

    // غير الجاهز ما يطلع له نموذج تسليم
    assert.doesNotMatch(await w.store.html('/documents/4'), /action="\/handover"/);

    const r = await w.store.postAndFollow('/handover', { courier_id: courierId, doc_ids: [1, 2, 3, 4] }, '/documents');
    assert.match(r.html, /تم تسليم 3 مستندات للموصل موصل الدفعة/);
    assert.match(r.html, /مستند واحد ما انسلّم/);
    for (const id of [1, 2, 3]) {
      assert.equal(w.doc(id).status, 'handed_to_courier');
      assert.equal(w.doc(id).courier_id, courierId);
    }
    assert.equal(w.doc(4).status, 'preparing');
    assert.equal(w.doc(1).handed_over_at, w.doc(3).handed_over_at, 'نفس وقت التسليم للدفعة');

    // تسليمها مرة ثانية (ضغطة مكررة): لا شيء يتغير ولا يتسجّل
    const again = await w.store.postAndFollow('/handover', { courier_id: courierId, doc_ids: [1, 2, 3] }, '/documents');
    assert.match(again.html, /ما انسلّم شيء/);
    assert.equal(w.events(1).filter(e => e.to_status === 'handed_to_courier').length, 1);
  } finally { await w.site.close(); }
});

test('التسليم يحتاج موصلاً فعّالاً من القائمة ومستنداً محدداً', async () => {
  const w = await world({ docs: 1 });
  try {
    const active = await w.addCourier('موصل فعّال');
    const stopped = await w.addCourier('موصل موقوف');
    await w.admin.post(`/admin/couriers/${stopped}`, { name: 'موصل موقوف', phone: '' }, '/admin/couriers'); // بدون active = إيقاف
    await w.prepare(1);

    const page = await w.store.html('/documents/1');
    assert.match(page, /موصل فعّال/);
    assert.doesNotMatch(page, /موصل موقوف/, 'الموقوف لا يظهر في نموذج التسليم');

    let r = await w.store.postAndFollow('/handover', { courier_id: stopped, doc_ids: [1] }, '/documents/1');
    assert.equal(r.location, '/documents/1', 'الخطأ يرجع لصفحة الفسح');
    assert.match(r.html, /موقوف/);
    r = await w.store.postAndFollow('/handover', { doc_ids: [1] }, '/documents/1');
    assert.match(r.html, /اختر الموصل/);
    r = await w.store.postAndFollow('/handover', { courier_id: 9999, doc_ids: [1] }, '/documents/1');
    assert.match(r.html, /اختر الموصل/);
    r = await w.store.postAndFollow('/handover', { courier_id: active }, '/documents/1');
    assert.match(r.html, /حدّد مستنداً/);
    assert.equal(w.doc(1).status, 'prepared');

    r = await w.store.postAndFollow('/handover', { courier_id: active, doc_ids: 1 }, '/documents/1');
    assert.equal(w.doc(1).status, 'handed_to_courier');
  } finally { await w.site.close(); }
});

// ==========================================================
// الملاحظات والنواقص
// ==========================================================

test('الملاحظة والنقص لا يغيّران الحالة، والنقص يبقى مفتوحاً حتى يُقفل مع وصف الحل', async () => {
  const w = await world();
  try {
    await w.advance(w.store, 1, 'received');

    let r = await w.store.postAndFollow('/documents/1/notes', { kind: 'note', text: 'العميل طلب التوصيل بعد العصر' }, '/documents/1');
    assert.match(r.html, /تمت إضافة الملاحظة/);
    assert.match(r.html, /العميل طلب التوصيل بعد العصر/);
    assert.equal(w.doc(1).status, 'preparing');
    assert.equal(w.doc(1).has_open_shortage, 0);

    r = await w.store.postAndFollow('/documents/1/notes', { kind: 'shortage', text: 'ناقص فلتر زيت عدد 2' }, '/documents/1');
    assert.match(r.html, /نواقص مفتوحة \(1\)/);
    r = await w.store.postAndFollow('/documents/1/notes', { kind: 'shortage', text: 'ناقص بواجي' }, '/documents/1');
    assert.match(r.html, /نواقص مفتوحة \(2\)/);
    assert.equal(w.doc(1).status, 'preparing', 'النقص لا يغيّر الحالة');
    assert.equal(w.doc(1).has_open_shortage, 1);
    assert.match(await w.store.html('/documents?status=preparing'), /نقص مفتوح/, 'علامة على الكرت');

    // النقص لا يمنع إكمال المراحل
    await w.advance(w.store, 1, 'preparing');
    assert.equal(w.doc(1).status, 'prepared');

    const [s1, s2] = w.events(1).filter(e => e.type === 'shortage');
    // الإقفال بدون وصف الحل مرفوض
    r = await w.store.postAndFollow(`/documents/1/shortages/${s1.id}/close`, { resolution: ' ' }, '/documents/1');
    assert.match(r.html, /اكتب كيف انحل/);
    assert.equal(w.doc(1).has_open_shortage, 1);

    r = await w.store.postAndFollow(`/documents/1/shortages/${s1.id}/close`, { resolution: 'وصلت الكمية من الفرع' }, '/documents/1');
    assert.match(r.html, /تم إقفال النقص/);
    assert.match(r.html, /نواقص مفتوحة \(1\)/);
    assert.equal(w.doc(1).has_open_shortage, 1, 'باقي نقص مفتوح');

    // إقفال نفس النقص مرتين مرفوض
    r = await w.admin.postAndFollow(`/documents/1/shortages/${s1.id}/close`, { resolution: 'مرة ثانية' }, '/documents/1');
    assert.match(r.html, /مقفول من قبل/);

    r = await w.admin.postAndFollow(`/documents/1/shortages/${s2.id}/close`, { resolution: 'العميل وافق على الإرسال بدونها' }, '/documents/1');
    assert.equal(w.doc(1).has_open_shortage, 0);
    assert.doesNotMatch(r.html, /نواقص مفتوحة/);
    assert.match(r.html, /نواقص مقفولة/);
    assert.match(r.html, /وصلت الكمية من الفرع/);

    const closed = w.events(1).filter(e => e.type === 'shortage_closed');
    assert.deepEqual(closed.map(e => e.ref_event_id), [s1.id, s2.id]);
    assert.deepEqual(closed.map(e => e.user_id), [w.userId('store'), w.userId('admin')]);
    assert.equal(w.doc(1).status, 'prepared');
  } finally { await w.site.close(); }
});

test('نص فارغ لا يُسجَّل، ونقص مستند آخر لا يُقفل من هذا المستند', async () => {
  const w = await world({ docs: 2 });
  try {
    let r = await w.store.postAndFollow('/documents/1/notes', { kind: 'note', text: '   ' }, '/documents/1');
    assert.match(r.html, /اكتب نص الملاحظة/);
    r = await w.store.postAndFollow('/documents/1/notes', { kind: 'shortage', text: '' }, '/documents/1');
    assert.match(r.html, /اكتب وصف النقص/);
    assert.equal(w.events(1).length, 1);

    await w.store.post('/documents/2/notes', { kind: 'shortage', text: 'نقص في المستند الثاني' }, '/documents/2');
    const s = w.events(2).find(e => e.type === 'shortage');
    r = await w.store.postAndFollow(`/documents/1/shortages/${s.id}/close`, { resolution: 'محاولة من مستند آخر' }, '/documents/1');
    assert.match(r.html, /النقص غير موجود/);
    assert.equal(w.doc(2).has_open_shortage, 1);

    // النص يُعرض كنص فقط
    r = await w.store.postAndFollow('/documents/1/notes', { kind: 'note', text: '<script>alert(1)</script>' }, '/documents/1');
    assert.doesNotMatch(r.html, /<script>alert\(1\)<\/script>/);
  } finally { await w.site.close(); }
});

// ==========================================================
// التصحيح والصلاحيات
// ==========================================================

test('التصحيح: الإدارة فقط، خطوة واحدة للخلف مع سبب، ولا شيء يُحذف من السجل', async () => {
  const w = await world();
  try {
    const courierId = await w.addCourier('موصل');
    await w.prepare(1);
    await w.store.post('/handover', { courier_id: courierId, doc_ids: [1] }, '/documents');
    assert.equal(w.doc(1).status, 'handed_to_courier');
    const before = w.events(1).length;

    // مسؤول المستودع: ممنوع (والمستند المسلَّم لا يظهر له أصلاً)
    const csrf = await w.store.csrf('/documents');
    assert.equal((await w.store.postRaw('/documents/1/correct', { _csrf: csrf, expected_status: 'handed_to_courier', reason: 'محاولة' })).status, 403);
    assert.equal(w.doc(1).status, 'handed_to_courier');

    // بدون سبب: مرفوض
    let r = await w.admin.postAndFollow('/documents/1/correct', { expected_status: 'handed_to_courier', reason: '' }, '/documents/1');
    assert.match(r.html, /اكتب سبب التصحيح/);
    assert.equal(w.doc(1).status, 'handed_to_courier');

    r = await w.admin.postAndFollow('/documents/1/correct', { expected_status: 'handed_to_courier', reason: 'انسلّم للموصل الغلط' }, '/documents/1');
    assert.match(r.html, /تم التصحيح/);
    let d = w.doc(1);
    assert.equal(d.status, 'prepared');
    assert.deepEqual([d.courier_id, d.handed_over_at, d.handed_by_user_id], [null, null, null]);
    assert.ok(d.prepared_at, 'وقت التجهيز باقٍ');

    // ضغطة تصحيح مكررة بنفس الحالة القديمة: لا ترجع خطوة ثانية
    r = await w.admin.postAndFollow('/documents/1/correct', { expected_status: 'handed_to_courier', reason: 'ضغطة مكررة' }, '/documents/1');
    assert.match(r.html, /تغيّرت حالة الفسح/);
    assert.equal(w.doc(1).status, 'prepared');

    await w.admin.post('/documents/1/correct', { expected_status: 'prepared', reason: 'رجوع ثاني' }, '/documents/1');
    await w.admin.post('/documents/1/correct', { expected_status: 'preparing', reason: 'رجوع ثالث' }, '/documents/1');
    d = w.doc(1);
    assert.equal(d.status, 'received');
    assert.deepEqual([d.prep_started_at, d.preparer_user_id, d.prepared_at], [null, null, null]);
    r = await w.admin.postAndFollow('/documents/1/correct', { expected_status: 'received', reason: 'لا خطوة قبلها' }, '/documents/1');
    assert.match(r.html, /أول مرحلة/);

    const ev = w.events(1);
    assert.equal(ev.length, before + 3, 'السجل زاد ولم ينقص');
    const corrections = ev.filter(e => e.type === 'correction');
    assert.deepEqual(corrections.map(e => [e.from_status, e.to_status, e.text]), [
      ['handed_to_courier', 'prepared', 'انسلّم للموصل الغلط'],
      ['prepared', 'preparing', 'رجوع ثاني'],
      ['preparing', 'received', 'رجوع ثالث']
    ]);
    assert.ok(corrections.every(e => e.user_id === w.userId('admin')));
    assert.match(await w.admin.html('/documents/1'), /السبب: انسلّم للموصل الغلط/);
    assert.equal(w.site.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'document_corrected'").get().n, 3);

    // بعد التصحيح المستند يكمل دورته عادي
    await w.prepare(1);
    assert.equal(w.doc(1).status, 'prepared');
  } finally { await w.site.close(); }
});

test('مسؤول المستودع يشوف المفتوحة فقط: المسلَّم للموصل وصفحات الإدارة مقفلة عليه في السيرفر', async () => {
  const w = await world({ docs: 2 });
  try {
    const courierId = await w.addCourier('موصل');
    await w.prepare(1);
    await w.store.post('/handover', { courier_id: courierId, doc_ids: [1] }, '/documents');

    for (const url of ['/documents/1/view', '/documents/1/pdf', '/documents/1/pdf-data']) {
      assert.equal((await w.store.get(url)).status, 404, `${url} للمسؤول`);
      assert.equal((await w.admin.get(url)).status, 200, `${url} للإدارة`);
    }
    // صفحة الفسح: ما تختفي بدون سبب — تقول له إنه انسلّم، بدون أي إجراء ولا ملف
    const handed = await w.store.get('/documents/1');
    assert.equal(handed.status, 200);
    const handedHtml = await handed.text();
    assert.match(handedHtml, /انسلّم للموصل/);
    assert.match(handedHtml, /الموصل: موصل/);
    assert.doesNotMatch(handedHtml, /\/documents\/1\/(view|advance|notes)/);
    assert.equal((await w.admin.get('/documents/1')).status, 200);
    // لا ملاحظة ولا إجراء على مستند مسلَّم من حساب المسؤول
    const csrf = await w.store.csrf('/documents');
    assert.equal((await w.store.postRaw('/documents/1/notes', { _csrf: csrf, kind: 'note', text: 'محاولة' })).status, 404);

    const storeList = await w.store.html('/documents?status=handed_to_courier');
    assert.doesNotMatch(storeList, /href="\/documents\/1"/, 'المسلّم ما يطلع للمسؤول');
    assert.doesNotMatch(storeList, /href="\/documents\/1"/);
    const adminList = await w.admin.html('/documents?status=handed_to_courier');
    assert.match(adminList, /tl-done[\s\S]*سُلّم للموصل/, 'المسلّم يطلع للإدارة ومراحله كلها خلصت');
    assert.match(adminList, /href="\/documents\/1"/);
    assert.match(adminList, /class="tl-who">موصل/, 'اسم الموصل تحت "سُلّم للموصل"');

    for (const url of ['/admin/users', '/admin/couriers', '/admin/integration']) {
      assert.equal((await w.store.get(url)).status, 403, url);
    }
    for (const [url, form] of [
      ['/admin/users', { full_name: 'x', username: 'hacker', role: 'admin', password: 'password-123', password2: 'password-123' }],
      ['/admin/users/1', { full_name: 'x', role: 'warehouse' }],
      ['/admin/users/1/password', { password: 'password-123', password2: 'password-123' }],
      ['/admin/couriers', { name: 'موصل دخيل' }],
      [`/admin/couriers/${courierId}`, { name: 'تعديل' }]
    ]) {
      assert.equal((await w.store.postRaw(url, { ...form, _csrf: csrf })).status, 403, `POST ${url}`);
    }
    assert.equal(w.site.db.prepare('SELECT COUNT(*) n FROM users').get().n, 2);
    assert.equal(w.site.db.prepare('SELECT COUNT(*) n FROM couriers').get().n, 1);
    assert.doesNotMatch(await w.store.html('/documents'), /\/admin\//, 'روابط الإدارة لا تظهر للمسؤول');

    // بدون دخول: كل شيء مقفل
    const anon = browser(w.site.base);
    for (const url of ['/handover', '/account', '/admin/users', '/admin/couriers']) {
      assert.equal((await anon.get(url)).headers.get('location'), '/login', url);
    }
  } finally { await w.site.close(); }
});

// ==========================================================
// الموصلون والمستخدمون وحسابي
// ==========================================================

test('الموصلون: إضافة وتعديل وإيقاف (بدون حذف)، والاسم يبقى في سجل ما استلمه', async () => {
  const w = await world();
  try {
    let r = await w.admin.postAndFollow('/admin/couriers', { name: '  ', phone: '' });
    assert.match(r.html, /اكتب اسم الموصل/);
    r = await w.admin.postAndFollow('/admin/couriers', { name: 'سالم', phone: 'abc' });
    assert.match(r.html, /رقم الجوال غير صحيح/);
    const id = await w.addCourier('سالم', '0555000111');
    r = await w.admin.postAndFollow('/admin/couriers', { name: 'سالم', phone: '' });
    assert.match(r.html, /موجود في القائمة/);
    assert.equal(w.site.db.prepare('SELECT COUNT(*) n FROM couriers').get().n, 1);

    await w.prepare(1);
    await w.store.post('/handover', { courier_id: id, doc_ids: [1] }, '/documents');

    // تعديل الاسم ثم الإيقاف
    await w.admin.post(`/admin/couriers/${id}`, { name: 'سالم الجديد', phone: '0555000111', active: '1' }, '/admin/couriers');
    r = await w.admin.postAndFollow(`/admin/couriers/${id}`, { name: 'سالم الجديد', phone: '0555000111' }, '/admin/couriers');
    assert.match(r.html, /موقوف/);
    const c = w.site.db.prepare('SELECT * FROM couriers WHERE id = ?').get(id);
    assert.deepEqual([c.name, c.active], ['سالم الجديد', 0]);
    assert.equal(w.doc(1).courier_id, id, 'المستند ما زال مربوطاً بالموصل');
    assert.match(await w.admin.html('/documents/1'), /سالم الجديد/);
  } finally { await w.site.close(); }
});

test('المستخدمون: الإدارة تنشئ الحسابات وتوقفها، ولا يبقى الموقع بدون إدارة', async () => {
  const w = await world();
  try {
    const create = (form) => w.admin.postAndFollow('/admin/users', { role: 'warehouse', password: 'new-user-pass-1', password2: 'new-user-pass-1', ...form });
    assert.match((await create({ full_name: 'بديل', username: 'store' })).html, /مستخدم من قبل/);
    assert.match((await create({ full_name: 'بديل', username: 'STORE' })).html, /مستخدم من قبل/, 'بدون تفريق بين الحروف');
    assert.match((await create({ full_name: 'بديل', username: 'backup', password: 'short', password2: 'short' })).html, /8 خانات/);
    assert.match((await create({ full_name: 'بديل', username: 'backup', password2: 'different-pass-1' })).html, /غير متطابقتين/);
    assert.match((await create({ full_name: 'بديل', username: 'backup', role: 'owner' })).html, /اختر الدور/);
    assert.equal(w.site.db.prepare('SELECT COUNT(*) n FROM users').get().n, 2);

    assert.match((await create({ full_name: 'بديل الإجازة', username: 'backup' })).html, /تم إنشاء الحساب/);
    const backupId = w.userId('backup');
    const backup = browser(w.site.base);
    assert.equal((await backup.post('/login', { username: 'backup', password: 'new-user-pass-1' })).headers.get('location'), '/documents');
    assert.equal((await backup.get('/admin/users')).status, 403);

    // تغيير كلمة المرور من الإدارة: يطلع من جلسته ويدخل بالجديدة فقط
    await w.admin.post(`/admin/users/${backupId}/password`, { password: 'reset-pass-22', password2: 'reset-pass-22' }, '/admin/users');
    assert.equal((await backup.get('/documents')).headers.get('location'), '/login', 'جلسته انتهت');
    assert.equal((await browser(w.site.base).post('/login', { username: 'backup', password: 'new-user-pass-1' })).status, 401);
    assert.equal((await backup.post('/login', { username: 'backup', password: 'reset-pass-22' })).headers.get('location'), '/documents');

    // الإيقاف: يطلع فوراً وما يقدر يدخل
    await w.admin.post(`/admin/users/${backupId}`, { full_name: 'بديل الإجازة', role: 'warehouse' }, '/admin/users');
    assert.equal((await backup.get('/documents')).headers.get('location'), '/login');
    assert.equal((await browser(w.site.base).post('/login', { username: 'backup', password: 'reset-pass-22' })).status, 401);
    assert.equal(w.site.db.prepare('SELECT COUNT(*) n FROM users').get().n, 3, 'الحساب موقوف وليس محذوفاً');

    // حماية آخر حساب إدارة
    const adminId = w.userId('admin');
    let r = await w.admin.postAndFollow(`/admin/users/${adminId}`, { full_name: ADMIN.full_name, role: 'admin' }, '/admin/users');
    assert.match(r.html, /ما تقدر توقف حسابك/);
    r = await w.admin.postAndFollow(`/admin/users/${adminId}`, { full_name: ADMIN.full_name, role: 'warehouse', active: '1' }, '/admin/users');
    assert.match(r.html, /حساب إدارة واحد فعّال على الأقل/);
    assert.deepEqual(w.site.db.prepare('SELECT role, active FROM users WHERE id = ?').get(adminId), { role: 'admin', active: 1 });

    // ترقية المسؤول لإدارة: الصلاحية تسري فوراً بدون إعادة دخول
    assert.equal((await w.store.get('/admin/users')).status, 403);
    await w.admin.post(`/admin/users/${w.userId('store')}`, { full_name: 'مسؤول المستودع', role: 'admin', active: '1' }, '/admin/users');
    assert.equal((await w.store.get('/admin/users')).status, 200);

    const actions = w.site.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'user_%' ORDER BY id").all().map(a => a.action);
    assert.deepEqual(actions, ['user_created', 'user_password_reset', 'user_updated', 'user_updated']);
  } finally { await w.site.close(); }
});

test('حسابي: تغيير كلمة المرور يحتاج الكلمة الحالية، والأجهزة الأخرى تطلع', async () => {
  const w = await world();
  try {
    const otherDevice = browser(w.site.base);
    await otherDevice.post('/login', { username: 'store', password: 'test-password-1' });
    assert.equal((await otherDevice.get('/documents')).status, 200);

    const change = (form) => w.store.postAndFollow('/account/password', form, '/account');
    assert.match((await change({ current_password: 'wrong', password: 'brand-new-pass-1', password2: 'brand-new-pass-1' })).html, /الحالية غير صحيحة/);
    assert.match((await change({ current_password: 'test-password-1', password: 'short', password2: 'short' })).html, /8 خانات/);
    assert.match((await change({ current_password: 'test-password-1', password: 'brand-new-pass-1', password2: 'brand-new-pass-2' })).html, /غير متطابقتين/);
    assert.equal((await browser(w.site.base).post('/login', { username: 'store', password: 'test-password-1' })).headers.get('location'), '/documents', 'الكلمة القديمة ما زالت تعمل');

    assert.match((await change({ current_password: 'test-password-1', password: 'brand-new-pass-1', password2: 'brand-new-pass-1' })).html, /تم تغيير كلمة المرور/);
    assert.equal((await w.store.get('/documents')).status, 200, 'هذا الجهاز يبقى داخلاً');
    assert.equal((await otherDevice.get('/documents')).headers.get('location'), '/login', 'الجهاز الآخر طلع');
    assert.equal((await browser(w.site.base).post('/login', { username: 'store', password: 'test-password-1' })).status, 401);
    assert.equal((await browser(w.site.base).post('/login', { username: 'store', password: 'brand-new-pass-1' })).headers.get('location'), '/documents');
  } finally { await w.site.close(); }
});

test('قاعدة موجودة من المرحلة 1 (فيها بيانات) تترقى تلقائياً بدون فقد شيء', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const Database = require('better-sqlite3');
  const { openDb } = require('../src/db');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-site-upgrade-'));
  let db = null;
  try {
    // قاعدة كما تركتها المرحلة 1: الملف الأول فقط + مستند وحدثه
    const old = new Database(path.join(dataDir, 'warehouse.sqlite'));
    old.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_init.sql'), 'utf8'));
    old.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    old.prepare("INSERT INTO schema_migrations VALUES ('001_init.sql', ?)").run(new Date().toISOString());
    old.prepare("INSERT INTO documents (doc_type, customer_number, status, received_at, created_at) VALUES ('clearance', '3339', 'received', ?, ?)").run('2026-11-18T07:00:00.000Z', '2026-11-18T07:00:00.000Z');
    old.prepare("INSERT INTO document_events (document_id, type, to_status, text, created_at) VALUES (1, 'received', 'received', 'وصل المستند للمستودع', ?)").run('2026-11-18T07:00:00.000Z');
    old.close();

    await (await openDb({ dataDir })).close();
    db = new Database(path.join(dataDir, 'warehouse.sqlite'));
    assert.deepEqual(db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map(r => r.name), ['001_init.sql', '002_workflow.sql', '003_workers.sql', '004_notifications.sql', '005_branches.sql', '006_branch_scoping.sql', '007_branch_names.sql', '008_documents_branch.sql', '009_generic_customer_names.sql', '010_attachments.sql', '011_items.sql', '012_file_chunks.sql', '013_engine_commands.sql']);
    assert.ok(db.prepare('PRAGMA table_info(document_events)').all().some(c => c.name === 'ref_event_id'));
    assert.ok(db.prepare('PRAGMA table_info(documents)').all().some(c => c.name === 'preparer_worker_id'));
    assert.equal(db.prepare('SELECT customer_number FROM documents WHERE id = 1').get().customer_number, '3339');
    const event = db.prepare('SELECT * FROM document_events WHERE document_id = 1').get();
    assert.equal(event.text, 'وصل المستند للمستودع');
    assert.equal(event.ref_event_id, null);
    // السجل ما زال إضافة فقط بعد الترقية
    assert.throws(() => db.prepare("UPDATE document_events SET text = 'x'").run(), /append-only/);
  } finally {
    if (db) db.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }
});
