/**
 * التقارير: الأرقام حسب الفترة والفرع + ملف Excel.  التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePdf, startSite, setupAdmin, loginAs, newKey, upload, clearanceMeta } = require('./helpers');
const reports = require('../src/services/reports');

async function world() {
  const site = await startSite();
  const admin = await setupAdmin(site);
  const key = await newKey(admin);
  const send = async (label, extra = {}) => {
    const pdf = fakePdf(label);
    const res = await upload(site, key, pdf, clearanceMeta(pdf, { customer_name: `عميل ${label}`, ...extra }));
    assert.equal(res.status, 201);
    return (await res.json()).id;
  };
  const store = await loginAs(site, { username: 'store' });
  const start = (id, worker) => store.post(`/documents/${id}/advance`, { expected_status: 'received', worker_name_new: worker }, `/documents/${id}`);
  const finish = (id) => store.post(`/documents/${id}/advance`, { expected_status: 'preparing' }, `/documents/${id}`);
  const hand = (id, courier) => store.post('/handover', { doc_ids: id, courier_name: courier }, `/documents/${id}`);
  return { site, admin, store, send, start, finish, hand };
}

test('الفترة: اليوم وأمس وآخر 7 أيام والشهر وفترة مخصصة، بأيام الرياض', () => {
  // 2026-11-18 01:30 بتوقيت الرياض = 2026-11-17 22:30 UTC
  const now = Date.parse('2026-11-17T22:30:00Z');
  const today = reports.resolvePeriod({}, now);
  assert.equal(today.fromDay, '2026-11-18');
  assert.equal(today.from, '2026-11-17T21:00:00.000Z');
  assert.equal(today.to, '2026-11-18T21:00:00.000Z');
  assert.equal(reports.resolvePeriod({ period: 'yesterday' }, now).fromDay, '2026-11-17');
  const week = reports.resolvePeriod({ period: 'week' }, now);
  assert.equal(week.fromDay, '2026-11-12');
  assert.equal(week.days, 7);
  assert.equal(reports.resolvePeriod({ period: 'month' }, now).fromDay, '2026-11-01');
  const last = reports.resolvePeriod({ period: 'last_month' }, now);
  assert.deepEqual([last.fromDay, last.toDay], ['2026-10-01', '2026-10-31']);
  const custom = reports.resolvePeriod({ from: '2026-11-10', to: '2026-11-05' }, now);
  assert.deepEqual([custom.fromDay, custom.toDay, custom.key], ['2026-11-05', '2026-11-10', 'custom'], 'التاريخين بالعكس ينعدلون');
  assert.throws(() => reports.resolvePeriod({ from: '2026-02-30' }, now), /تاريخ صحيح/);
  assert.throws(() => reports.resolvePeriod({ from: '2024-01-01', to: '2026-01-01' }, now), /طويلة/);
});

test('تقرير اليوم: وصل وتجهّز وانسلّم، الموظفين والموصلين، والفروع، والنواقص', async () => {
  const w = await world();
  try {
    const a = await w.send('a', { branch: 'جدة', customer_number: '1001' });
    const b = await w.send('b', { branch: 'جدة', customer_number: '1001' });
    const c = await w.send('c', { branch: 'الرياض', customer_number: '2002' });
    await w.start(a, 'محمد'); await w.finish(a); await w.hand(a, 'ناصر');
    await w.start(b, 'محمد'); await w.finish(b);
    await w.start(c, 'فهد');
    await w.store.post(`/documents/${c}/notes`, { kind: 'shortage', text: 'فلتر زيت ناقص' }, `/documents/${c}`);

    const html = await w.admin.html('/admin/reports');
    assert.match(html, /<h1>التقارير<\/h1>/);
    const kpi = (label) => new RegExp(`${label}</span><span class="rep-stage-value">(\\d+)<`).exec(html)[1];
    assert.equal(kpi('وصل المستودع'), '3');
    assert.equal(kpi('انتهى تجهيزه'), '2');
    assert.equal(kpi('انسلّم للموصل'), '1');
    assert.match(html, /<strong>محمد<\/strong><span class="rep-cell-sub">فرع جدة<\/span><\/td>\s*<td class="num">2<\/td>\s*<td class="num"><span class="rep-count">—</, 'محمد جهّز اثنين (بدون جدول أصناف = شرطة)');
    assert.match(html, /<strong>ناصر<\/strong><span class="rep-cell-sub">فرع جدة<\/span><\/td>\s*<td class="num"><span class="rep-count">1</);
    assert.match(html, /حسب الفرع/);
    assert.match(html, /مؤسسة|عميل a/);
    assert.doesNotMatch(html, /أبطأ الفسوحات/, "ما نرتّب الفسوحات بالأبطأ (بدون حكم على التأخير)");

    // فلتر الفرع
    const riyadh = await w.admin.html('/admin/reports?branch=' + encodeURIComponent('الرياض'));
    assert.equal(/وصل المستودع<\/span><span class="rep-stage-value">(\d+)</.exec(riyadh)[1], '1');
    assert.doesNotMatch(riyadh, /حسب الفرع/);

    // فترة فاضية
    const old = await w.admin.html('/admin/reports?from=2020-01-01&to=2020-01-02');
    assert.match(old, /ما فيه أي حركة في هذي الفترة/);
    // تاريخ غلط: رسالة واضحة ويرجع لليوم
    assert.match(await w.admin.html('/admin/reports?from=2026-13-40'), /اختر تاريخ صحيح/);
  } finally { await w.site.close(); }
});

test('ملف Excel: صف لكل فسح وصل في الفترة، والتقارير للإدارة فقط', async () => {
  const w = await world();
  try {
    const a = await w.send('x', { branch: 'جدة', customer_number: '0042' });
    await w.start(a, 'سالم');
    const res = await w.admin.get('/admin/reports/export.xlsx');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml/);
    assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 2).toString(), 'PK', 'ملف xlsx (zip)');
    const xml = buf.toString('utf8');
    assert.match(xml, /0042/, 'رقم العميل نص (الأصفار باقية)');
    assert.match(xml, /سالم/);
    assert.match(xml, /عميل x/);

    assert.equal((await w.store.get('/admin/reports')).status, 403);
    assert.equal((await w.store.get('/admin/reports/export.xlsx')).status, 403);
  } finally { await w.site.close(); }
});

test('الموظفين بالأصناف والقطع: مجموع أصناف وكميات الفسوحات اللي جهّزها كل موظف، وتطلع في صفحة الفسح والـ Excel', async () => {
  const w = await world();
  try {
    const a = await w.send('i1', { branch: 'جدة', customer_number: '1001', items_count: 15, items_qty: 67 });
    const b = await w.send('i2', { branch: 'جدة', customer_number: '1002', items_count: 3, items_qty: 10 });
    const c = await w.send('i3', { branch: 'جدة', customer_number: '1003', items_count: 4, items_qty: 4 });
    const bad = await w.send('i4', { branch: 'جدة', customer_number: '1004', items_count: -5, items_qty: 'كثير' });
    assert.deepEqual({ ...w.site.db.prepare('SELECT items_count, items_qty FROM documents WHERE id = ?').get(bad) }, { items_count: null, items_qty: null }, 'قيم غلط ما تنحفظ');
    await w.start(a, 'محمد'); await w.finish(a);
    await w.start(b, 'سالم'); await w.finish(b);
    await w.start(c, 'سالم'); await w.finish(c);

    // صفحة الفسح
    assert.match(await w.store.html(`/documents/${a}`), /<dt>الأصناف<\/dt><dd>15 صنف · 67 قطعة<\/dd>/);
    assert.doesNotMatch(await w.store.html(`/documents/${bad}`), /<dt>الأصناف<\/dt>/);

    // التقرير: محمد فسح واحد 15 صنف أول (الترتيب بالأصناف مو بعدد الفسوحات)، وسالم فسحين 7 أصناف و14 قطعة
    const html = await w.admin.html('/admin/reports');
    const row = (name) => new RegExp(`<strong>${name}</strong>.*?</td>\\s*<td class="num">(\\d+)</td>\\s*<td class="num"><span class="rep-count">([^<]+)</span></td>\\s*<td class="num">([^<]+)</td>`, 's').exec(html).slice(1);
    assert.deepEqual(row('محمد'), ['1', '15', '67']);
    assert.deepEqual(row('سالم'), ['2', '7', '14']);
    assert.ok(html.indexOf('<strong>محمد</strong>') < html.indexOf('<strong>سالم</strong>'), 'الأكثر أصناف فوق');

    const xml = Buffer.from(await (await w.admin.get('/admin/reports/export.xlsx')).arrayBuffer()).toString('utf8');
    assert.match(xml, /الأصناف/);
    assert.match(xml, /القطع/);
  } finally { await w.site.close(); }
});
