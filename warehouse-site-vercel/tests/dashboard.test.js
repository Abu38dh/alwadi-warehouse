/**
 * اختبارات لوحة الإدارة والبحث ووضوح العرض.  التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePdf, startSite, setupAdmin, loginAs, newKey, upload, clearanceMeta } = require('./helpers');
const time = require('../src/services/time');

async function world(n = 3) {
  const site = await startSite();
  const admin = await setupAdmin(site);
  const key = await newKey(admin);
  for (let i = 1; i <= n; i++) {
    const pdf = fakePdf(`dash-${i}`);
    const meta = i === n
      ? clearanceMeta(pdf, { customer_number: null, customer_name: null, meta_problems: ['customer_number_missing'] })
      : clearanceMeta(pdf, { customer_number: String(5000 + i), customer_name: `مؤسسة ${i}` });
    assert.equal((await upload(site, key, pdf, meta)).status, 201);
  }
  const store = await loginAs(site, { username: 'store', fullName: 'خالد المستودع' });
  return { site, admin, store };
}

test('ما فيه لوحة إدارة: الكل يبدأ من الفسوحات، والرابط القديم يفتح الفسوحات', async () => {
  const w = await world(3);
  try {
    assert.equal((await w.admin.get('/')).headers.get('location'), '/documents');
    assert.equal((await w.store.get('/')).headers.get('location'), '/documents');
    const old = await w.admin.get('/dashboard');
    assert.equal(old.status, 302);
    assert.equal(old.headers.get('location'), '/documents');
    const list = await w.admin.html('/documents');
    assert.doesNotMatch(list, /لوحة الإدارة/);
    assert.doesNotMatch(list, /href="\/dashboard"/);

    // اللي كان في "يحتاج انتباهك" ظاهر على بطاقة الفسح نفسه
    await w.store.post('/documents/2/advance', { expected_status: 'received', worker_name_new: 'محمد' }, '/documents/2');
    await w.store.post('/documents/2/notes', { kind: 'shortage', text: 'ناقص كفرات عدد 4' }, '/documents/2');
    const all = await w.admin.html('/documents');
    assert.match(all, /نقص مفتوح/);
    assert.match(all, /بيانات ناقصة/);
  } finally { await w.site.close(); }
});

test('الأسماء واضحة: "فسح #1" مع الحالة والمدة في القائمة، ومراحل الفسح في صفحته', async () => {
  const w = await world(1);
  try {
    let list = await w.admin.html('/documents');
    assert.match(list, /فسح #1/);
    assert.doesNotMatch(list, /فسح رقم 1/, "الرقم الداخلي بعلامة # بس");
    assert.match(list, /class="tl-row"/, 'كل فسح في سطره ومعه مراحله');
    assert.doesNotMatch(list, /لم يبدأ تجهيزها|تحديث تلقائي|id="live-status"/, 'بدون شرح زايد ولا شارة التحديث');
    assert.match(list, /tl-done[\s\S]*?وصل[\s\S]*?tl-next[\s\S]*?بدأ التجهيز/, 'وصل (تم) ثم بدأ التجهيز (الخطوة الجاية)');

    let page = await w.admin.html('/documents/1');
    assert.match(page, /وين وصل الفسح؟/);
    assert.match(page, /step-done[\s\S]*وصل للمستودع/);
    assert.match(page, /step-next[\s\S]*بدأ التجهيز[\s\S]*الخطوة التالية/);
    assert.match(page, /مين يجهّز هذا الطلب؟/);

    await w.store.post('/documents/1/advance', { expected_status: 'received', worker_name_new: 'محمد' }, '/documents/1');
    page = await w.admin.html('/documents/1');
    assert.match(page, /يجهّزه: محمد/);
    assert.match(page, /يجهّزه: محمد/, 'اسم الموظف في مراحل الفسح');
    assert.match(page, / · خالد المستودع/, 'الحساب اللي ضغط الزر في السجل (للإدارة)');
  } finally { await w.site.close(); }
});

test('البحث: برقم الفسح، اسم العميل أو رقمه، والموصل — والمسؤول ما يشوف المسلّمة في البحث', async () => {
  const w = await world(3);
  try {
    await w.admin.post('/admin/couriers', { name: 'ماجد التوصيل' });
    const courierId = w.site.db.prepare('SELECT id FROM couriers').get().id;
    await w.store.post('/documents/1/advance', { expected_status: 'received', worker_name_new: 'فهد' }, '/documents/1');
    await w.store.post('/documents/1/advance', { expected_status: 'preparing' }, '/documents/1');
    await w.store.post('/handover', { courier_id: courierId, doc_ids: [1] }, '/documents');

    const found = (html) => [...new Set([...html.matchAll(/href="\/documents\/(\d+)"/g)].map(m => Number(m[1])))].sort();
    const q = (b, text) => b.html(`/documents?q=${encodeURIComponent(text)}`);

    assert.deepEqual(found(await q(w.admin, '2')), [2], 'رقم الفسح');
    assert.deepEqual(found(await q(w.admin, '#2')), [2]);
    assert.deepEqual(found(await q(w.admin, 'مؤسسة')), [1, 2], 'جزء من اسم العميل');
    assert.deepEqual(found(await q(w.admin, '5002')), [2], 'رقم العميل');
    assert.deepEqual(found(await q(w.admin, 'ماجد')), [1], 'اسم الموصل');
    assert.deepEqual(found(await q(w.admin, 'فهد')), [1], 'اسم الموظف اللي جهّزه');
    assert.match(await q(w.admin, 'لا يوجد شيء'), /ما لقيت شيء/);
    assert.match(await q(w.admin, '%'), /ما لقيت شيء/, 'رموز البحث تُعامل كنص');

    assert.deepEqual(found(await q(w.store, 'مؤسسة')), [2], 'المسؤول ما يشوف المسلّم');
    assert.doesNotMatch(await q(w.admin, 'مؤسسة'), /id="live-status"/, 'نتائج البحث ما تتحدث لحالها');
  } finally { await w.site.close(); }
});

test('الأوقات بكلام واضح', () => {
  const now = Date.parse('2026-11-18T09:00:00.000Z'); // 12:00 الرياض
  assert.equal(time.durationAr(30 * 1000), 'أقل من دقيقة');
  assert.equal(time.durationAr(60 * 1000), 'دقيقة');
  assert.equal(time.durationAr(2 * 60 * 1000), 'دقيقتين');
  assert.equal(time.durationAr(5 * 60 * 1000), '5 دقائق');
  assert.equal(time.durationAr(45 * 60 * 1000), '45 دقيقة');
  assert.equal(time.durationAr(125 * 60 * 1000), 'ساعتين و5 دقائق');
  assert.equal(time.durationAr(3 * 24 * 3600 * 1000 + 3600 * 1000), '3 أيام وساعة');
  assert.equal(time.formatWhen('2026-11-18T06:30:00.000Z', now), 'اليوم 09:30');
  assert.equal(time.formatWhen('2026-11-17T18:00:00.000Z', now), 'أمس 21:00');
  assert.equal(time.formatWhen('2026-11-15T07:05:00.000Z', now), '2026-11-15 10:05');
  // بداية اليوم بتوقيت الرياض: منتصف الليل = 21:00 UTC من اليوم اللي قبله
  assert.equal(time.startOfRiyadhDayIso(now), '2026-11-17T21:00:00.000Z');
  assert.equal(time.startOfRiyadhDayIso(Date.parse('2026-11-17T22:30:00.000Z')), '2026-11-17T21:00:00.000Z');
  assert.equal(time.minutesText(null), '—');
  assert.equal(time.minutesText(14.6), '15 دقيقة');
});
