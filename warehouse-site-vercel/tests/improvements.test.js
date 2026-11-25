/**
 * تحسينات المراجعة: تصحيح العميل، البحث عن المسلّم، الرقم الداخلي #، مقارنة النسخ، نقطة واتساب الحمراء.  التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePdf, startSite, setupAdmin, loginAs, newKey, upload, clearanceMeta } = require('./helpers');

async function world() {
  const site = await startSite();
  const admin = await setupAdmin(site);
  const key = await newKey(admin);
  const send = async (pdf, extra = {}) => {
    const res = await upload(site, key, pdf, clearanceMeta(pdf, extra));
    return { status: res.status, json: await res.json() };
  };
  const store = await loginAs(site, { username: 'store' });
  return { site, admin, key, send, store };
}

test('الإدارة تصحح رقم العميل في فسح بياناته ناقصة، والتصحيح ينسجل', async () => {
  const w = await world();
  try {
    const { json } = await w.send(fakePdf('missing'), { customer_number: null, customer_name: null, meta_problems: ['customer_number_missing'] });
    const id = json.id;
    let page = await w.admin.html(`/documents/${id}`);
    assert.match(page, /بيانات ناقصة/);
    assert.match(page, new RegExp(`action="/documents/${id}/customer"`), 'نموذج التصحيح للإدارة');
    // مسؤول المستودع: يشوف التنبيه بس بدون نموذج، وما يقدر يصحح
    const storePage = await w.store.html(`/documents/${id}`);
    assert.match(storePage, /بيانات ناقصة/);
    assert.doesNotMatch(storePage, /بلّغ الإدارة|افتح ملف الـ PDF/, 'بدون جمل شرح');
    assert.doesNotMatch(storePage, /\/customer"/);
    const csrf = await w.store.csrf(`/documents/${id}`);
    assert.equal((await w.store.postRaw(`/documents/${id}/customer`, { _csrf: csrf, customer_number: '1001' })).status, 403);

    // رقم غلط
    let r = await w.admin.postAndFollow(`/documents/${id}/customer`, { customer_number: '10a1' }, `/documents/${id}`);
    assert.match(r.html, /رقم العميل لازم يكون أرقام بس/);
    // صحيح (أرقام عربية تتحول)
    r = await w.admin.postAndFollow(`/documents/${id}/customer`, { customer_number: '١٠٠١', customer_name: 'مؤسسة النخبة' }, `/documents/${id}`);
    assert.match(r.html, /تم تصحيح العميل: مؤسسة النخبة — 1001/);
    assert.doesNotMatch(r.html, /بيانات ناقصة/);
    assert.match(r.html, /الإدارة صحّحت العميل: من غير معروف إلى مؤسسة النخبة — 1001/, 'في السجل');
    const row = w.site.db.prepare('SELECT customer_number, customer_name, meta_problems FROM documents WHERE id = ?').get(id);
    assert.deepEqual([row.customer_number, row.customer_name, row.meta_problems], ['1001', 'مؤسسة النخبة', '[]']);
    // يقدر يصحح بعدها كمان (من بطاقة بيانات الفسح)
    page = await w.admin.html(`/documents/${id}`);
    assert.match(page, /تصحيح العميل/);
  } finally { await w.site.close(); }
});

test('مسؤول المستودع: البحث يقول له إن الفسح انسلّم بدل "ما لقيت شيء"', async () => {
  const w = await world();
  try {
    const { json } = await w.send(fakePdf('handed'), { customer_number: '4242', customer_name: 'شركة الأمل' });
    const id = json.id;
    await w.store.post(`/documents/${id}/advance`, { expected_status: 'received', worker_name_new: 'سالم' }, `/documents/${id}`);
    await w.store.post(`/documents/${id}/advance`, { expected_status: 'preparing' }, `/documents/${id}`);
    await w.store.post('/handover', { doc_ids: id, courier_name: 'ناصر' }, `/documents/${id}`);

    const res = await w.store.html('/documents?q=4242');
    assert.match(res, /انسلّمت للموصل \(1\)/);
    assert.match(res, /للموصل ناصر/);
    assert.match(res, /جهّزه سالم/);
    assert.match(res, /ما لقيت شيء مفتوح/);
    assert.doesNotMatch(res, new RegExp(`href="/documents/${id}"`), 'بدون رابط يفتح تفاصيله');
    // الإدارة تلقاه عادي في النتائج
    const adminRes = await w.admin.html('/documents?q=4242');
    assert.match(adminRes, new RegExp(`href="/documents/${id}"`));
    assert.doesNotMatch(adminRes, /انسلّمت للموصل \(/);
  } finally { await w.site.close(); }
});

test('الرقم الداخلي بعلامة #: "#7" يجيب الفسح 7 بس، والرقم العادي يطلع المطابق بالضبط أول', async () => {
  const w = await world();
  try {
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push((await w.send(fakePdf(`n${i}`), { customer_number: i === 7 ? '1742' : `90${i}` })).json.id);
    const seven = ids[6]; // id 7
    assert.equal(seven, 7);
    let html = await w.admin.html('/documents?q=%237');
    assert.match(html, /فسح #7/);
    assert.match(html, /نتائج البحث عن "<strong>#7<\/strong>": 1/);
    // "7" العادي: الفسح #7 أول (مطابق بالضبط)، وبعده عميل 1742 (فيه 7)
    html = await w.admin.html('/documents?q=7');
    const first = html.indexOf('فسح #7');
    const second = html.indexOf('1742');
    assert.ok(first > 0 && second > first, 'المطابق بالضبط أول');
    // "#17" ما يجيب شي (ما فيه فسح 17)
    assert.match(await w.admin.html('/documents?q=%2317'), /ما لقيت شيء/);
  } finally { await w.site.close(); }
});

test('مقارنة النسخ: النسخة المعدّلة جنب القديمة', async () => {
  const w = await world();
  try {
    const v1 = fakePdf('v1');
    const { json } = await w.send(v1, { doc_no: '55501' });
    const id = json.id;
    assert.equal((await w.admin.get(`/documents/${id}/compare`)).status, 302, 'نسخة وحدة: يرجع للفسح');
    // المحاسب عدّل الفسح وطبعه من جديد (نفس رقم الفسح، ملف مختلف)
    const v2 = fakePdf('v2');
    const second = await w.send(v2, { doc_no: '55501' });
    assert.equal(second.json.id, id, 'نفس الفسح');
    const page = await w.store.html(`/documents/${id}`);
    assert.match(page, /وش تغيّر؟/);
    const cmp = await w.store.html(`/documents/${id}/compare`);
    assert.match(cmp, /data-src="\/documents\/\d+\/pdf-data\?v=1"/);
    assert.match(cmp, /data-src="\/documents\/\d+\/pdf-data\?v=2"/);
    assert.match(cmp, /\(القديمة/);
    assert.match(cmp, /\(الأحدث/);
  } finally { await w.site.close(); }
});

test('نقطة حمراء على واتساب لما واتساب الشركة منقطع', async () => {
  const notifications = require('../src/services/notifications');
  const w = await world();
  try {
    // بدون نظام مدمج ما فيه صفحة واتساب بالقائمة، بس الحالة تنحسب
    await notifications.saveHeartbeat(w.site.db, { whatsapp: 'down', outboxPending: 0, version: '' });
    const html = await w.admin.html('/documents');
    const i = html.indexOf('href="/admin/whatsapp" class="side-link');
    assert.ok(i >= 0 && html.slice(i, html.indexOf('</a>', i)).includes('nav-dot'), 'نقطة حمراء على واتساب');
  } finally { await w.site.close(); }
});
