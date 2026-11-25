/**
 * تقارير الفواتير (نسخة فيرسيل): البرنامج يرسل قائمة العملاء وسجل المستندات، والموقع يحسب التقرير.  التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startSite, setupAdmin, loginAs, newKey } = require('./helpers');

const now = new Date();
const iso = (daysAgo) => new Date(now.getTime() - daysAgo * 86400000).toISOString();

const snapshot = () => ({
  importedAt: iso(30),
  customers: [
    { number: '0004', repCode: '7', repName: 'اديب' },
    { number: '1001', repCode: '8', repName: 'سالم' },
    { number: '1002', repCode: '', repName: '' }
  ],
  records: [
    { customer: '0004', type: 'invoice', status: 'sent', group: 'عميل 0004', at: iso(0), file: 'a.pdf' },
    { customer: '0004', type: 'statement', status: 'sent', group: 'عميل 0004', at: iso(0), file: 'b.pdf' },
    { customer: '1001', type: 'invoice', status: 'review', reason: 'لا يوجد قروب للعميل [1001]', at: iso(0), file: 'c.pdf' },
    { customer: '9999', type: 'invoice', status: 'cash', at: iso(0), file: 'd.pdf' },
    { customer: '0004', type: 'invoice', status: 'sent', at: iso(400), file: 'old.pdf' }
  ],
  groupsLoaded: true,
  groups: { 4: 'عميل 0004', 1002: 'مؤسسة 1002' }
});

async function push(site, key, body) {
  return fetch(`${site.base}/api/integration/customer-report`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('تقارير الفواتير: البيانات توصل من البرنامج والصفحة تحسب الفلاتر زي البرنامج', async () => {
  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    let page = await admin.html('/admin/customers');
    assert.match(page, /بيانات التقرير ما وصلت من برنامج الواتساب للحين/);
    assert.match(page, /href="\/admin\/customers"/, 'الرابط في القائمة');

    const key = await newKey(admin);
    assert.equal((await push(site, 'wrong', snapshot())).status, 401);
    assert.equal((await push(site, key, { customers: 'x' })).status, 400);
    const r = await push(site, key, snapshot());
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, customers: 3, records: 5 });

    page = await admin.html('/admin/customers');
    const count = (k) => Number(new RegExp(`filter-${k}[^"]*"[^>]*>\\s*<span class="filter-tile-count">(\\d+)<`).exec(page)[1]);
    assert.equal(count('all'), 4, '3 في القائمة + 9999 مو في القائمة');
    assert.equal(count('ordered'), 3);
    assert.equal(count('notOrdered'), 1, '1002 ما طلب');
    assert.equal(count('statementSent'), 1);
    assert.equal(count('statementNotSent'), 2);
    assert.equal(count('problems'), 1);
    assert.match(page, /<strong dir="ltr">1001<\/strong><\/a> <span class="tag tag-danger">ما له قروب/);

    // فلتر ما طلبوا + المندوب + البحث
    assert.match(await admin.html('/admin/customers?filter=notOrdered'), /العملاء \(1\)/);
    assert.match(await admin.html('/admin/customers?rep=7'), /العملاء \(1\)/);
    assert.match(await admin.html('/admin/customers?q=0004'), /العملاء \(1\)/);
    // الفترة: الفاتورة القديمة (قبل 400 يوم) ما تنحسب إلا لو الفترة تشملها
    const from = iso(410).slice(0, 10);
    const wide = await admin.html(`/admin/customers?from=${from}&q=0004`);
    assert.match(wide, /<td class="num text-success">2<\/td>/, 'فاتورتين');

    // صفحة العميل: كل مستنداته
    const one = await admin.html('/admin/customers/0004');
    assert.match(one, /قروبه: <strong>عميل 0004<\/strong>/);
    assert.match(one, /المندوب: <strong>اديب<\/strong>/);
    assert.match(one, /كل مستنداته \(3\)/);

    // Excel
    const x = await admin.get('/admin/customers/export.xlsx?filter=ordered');
    assert.equal(x.status, 200);
    assert.match(x.headers.get('content-type'), /spreadsheetml/);

    // بيانات جديدة تحل محل القديمة
    const s2 = snapshot();
    s2.customers.push({ number: '2002', repCode: '', repName: '' });
    assert.equal((await push(site, key, s2)).status, 200);
    assert.match(await admin.html('/admin/customers'), /العملاء \(5\)/);

    // للإدارة بس
    const store = await loginAs(site, { username: 'store' });
    assert.equal((await store.get('/admin/customers')).status, 403);
  } finally { await site.close(); }
});

test('رفع قائمة العملاء: البرنامج يقرأ الملف، الموقع يعرض التعديلات، وما يتغير شي إلا بعد "موافق"', async () => {
  const site = await startSite();
  try {
    const admin = await setupAdmin(site);
    const key = await newKey(admin);
    const api = (method, url, body) => fetch(`${site.base}/api/integration${url}`, {
      method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined
    });
    const uploadList = async (data, name = 'العملاء.csv') => {
      const fd = new FormData();
      fd.append('_csrf', await admin.csrf('/admin/customers'));
      fd.append('file', new Blob([data], { type: 'text/csv' }), name);
      return fetch(`${site.base}/admin/customers/import`, { method: 'POST', redirect: 'manual', headers: { cookie: admin.cookie() }, body: fd });
    };
    const beat = async () => (await (await api('POST', '/heartbeat', { whatsapp: 'connected', outbox_pending: 0 })).json());

    // القائمة الحالية عند الموقع (من البرنامج): 0004 مندوبه اديب، 1001 مندوبه سالم، 1002
    await push(site, key, snapshot());
    let page = await admin.html('/admin/customers');
    assert.match(page, /رفع قائمة العملاء/, 'الزر فوق');
    assert.doesNotMatch(page, /data-refresh-soon/);

    // 1) رفع الملف => ينتظر البرنامج يقرأه
    const csv = 'customer_no,rep\n0004,سالم\n1001,سالم\n3003,\n';
    assert.equal((await uploadList(csv)).status, 302);
    page = await admin.html('/admin/customers');
    assert.match(page, /جاري قراءة الملف: <strong><bdi>العملاء.csv<\/bdi><\/strong>/);
    assert.match(page, /data-refresh-soon/, 'الصفحة تتحدث لحالها وهي تنتظر');

    // 2) البرنامج يقرأ بس ويرجّع القائمة
    const job = (await beat()).customers_import;
    assert.equal(job.mode, 'parse');
    assert.equal(await (await api('GET', `/customers-import/${job.id}/file`)).text(), csv);
    const parsed = [{ number: '0004', repCode: '8', repName: 'سالم' }, { number: '1001', repCode: '8', repName: 'سالم' }, { number: '3003', repCode: '', repName: '' }];
    assert.equal((await api('POST', `/customers-import/${job.id}/result`, { ok: true, customers: parsed })).status, 200);
    assert.equal((await beat()).customers_import, undefined, 'ما ينحفظ شي قبل الموافقة');

    // 3) الموقع يعرض التعديلات
    page = await admin.html('/admin/customers');
    assert.match(page, /التعديلات في القائمة الجديدة/);
    const tile = (cls) => Number(new RegExp(`diff-tile ${cls}"><b>([0-9]+)<`).exec(page)[1]);
    assert.equal(tile('diff-added'), 1, '3003 جديد');
    assert.equal(tile('diff-removed'), 1, '1002 انشال');
    assert.equal(tile('diff-changed'), 1, '0004 من اديب إلى سالم');
    assert.match(page, /<strong dir="ltr">0004<\/strong> · اديب ← سالم/);
    assert.match(page, /موافق، حدّث القائمة/);

    // إلغاء: ما يتغير شي
    await admin.post('/admin/customers/import/cancel', {}, '/admin/customers');
    page = await admin.html('/admin/customers');
    assert.match(page, /انلغى. القائمة ما تغيّرت/);
    assert.doesNotMatch(page, /التعديلات في القائمة الجديدة/);
    assert.equal((await beat()).customers_import, undefined);

    // نفس الخطوات وبعدين "موافق": البرنامج يحفظ نفس القائمة اللي شافتها الإدارة
    await uploadList(csv);
    const j2 = (await beat()).customers_import;
    await api('POST', `/customers-import/${j2.id}/result`, { ok: true, customers: parsed });
    assert.equal((await admin.post('/admin/customers/import/approve', {}, '/admin/customers')).status, 302);
    const j3 = (await beat()).customers_import;
    assert.equal(j3.mode, 'apply');
    assert.deepEqual(JSON.parse(await (await api('GET', `/customers-import/${j3.id}/file`)).text()).customers.map(c => c.number), ['0004', '1001', '3003']);
    page = await admin.html('/admin/customers');
    assert.match(page, /جاري تحديث القائمة/);
    await api('POST', `/customers-import/${j3.id}/result`, { ok: true, count: 3 });
    assert.match(await admin.html('/admin/customers'), /تم تحديث قائمة العملاء: 3 عميل/);

    // ملف ما فيه أرقام عملاء: يطلع السبب
    await uploadList('hello,world\n', 'غلط.csv');
    const j4 = (await beat()).customers_import;
    await api('POST', `/customers-import/${j4.id}/result`, { ok: false, message: 'الملف لازم يكون فيه عمود customer_no (رقم العميل)' });
    assert.match(await admin.html('/admin/customers'), /غلط.csv<\/bdi>: الملف لازم يكون فيه عمود customer_no/);

    // ملف مو PDF ولا CSV
    await uploadList(Buffer.from([0, 1, 2, 3, 0, 5, 6, 7, 8, 9, 10, 11]), 'صورة.bin');
    assert.match(await admin.html('/admin/customers'), /الملف لازم يكون PDF أو CSV/);
  } finally { await site.close(); }
});
