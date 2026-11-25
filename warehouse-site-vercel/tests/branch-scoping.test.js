/**
 * كل فرع له مستودعه: مسؤول مستودع الرياض يشوف فسوحات الرياض بس، والإدارة تشوف الكل وتفلتر.  التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePdf, startSite, setupAdmin, loginAs, newKey, upload, clearanceMeta } = require('./helpers');
const people = require('../src/services/people');

async function world() {
  const site = await startSite();
  const admin = await setupAdmin(site);
  const key = await newKey(admin);
  // فسح 1 من جدة (الفرع الرئيسي) وفسح 2 من الرياض
  const send = async (label, branch) => {
    const pdf = fakePdf(label);
    const res = await upload(site, key, pdf, clearanceMeta(pdf, { branch, customer_name: `عميل ${label}` }));
    assert.equal(res.status, 201, await res.clone().text());
    return (await res.json()).id;
  };
  const jeddahDoc = await send('jeddah-1', 'جدة');
  const riyadhDoc = await send('riyadh-1', 'الرياض');
  const riyadh = await loginAs(site, { username: 'riyadh', branch: 'الرياض', fullName: 'مستودع الرياض' });
  const jeddah = await loginAs(site, { username: 'jeddah', branch: 'جدة', fullName: 'مستودع جدة' });
  return { site, admin, key, send, jeddahDoc, riyadhDoc, riyadh, jeddah };
}

test('مسؤول مستودع الرياض يشوف فسوحات الرياض بس', async () => {
  const w = await world();
  try {
    const list = await w.riyadh.html('/documents?status=received');
    assert.match(list, /عميل riyadh-1/);
    assert.doesNotMatch(list, /عميل jeddah-1/);
    assert.match(list, /<h1>الفسوحات — فرع الرياض<\/h1>/);
    assert.doesNotMatch(list, /class="chips"/, 'ما يقدر يغيّر الفرع');

    // حتى لو طلب فرع ثاني في الرابط
    const forced = await w.riyadh.html('/documents?status=received&branch=%D8%AC%D8%AF%D8%A9');
    assert.doesNotMatch(forced, /عميل jeddah-1/);

    // البحث والتحديث التلقائي بنفس الشي
    assert.doesNotMatch(await w.riyadh.html('/documents?q=jeddah'), /عميل jeddah-1/);
    const cards = await (await w.riyadh.get('/documents/cards?status=received', { headers: { accept: 'application/json' } })).json();
    assert.equal(cards.counts.received, 1);
    assert.doesNotMatch(cards.html, /عميل jeddah-1/);

    // فتح فسح جدة مباشرة = غير موجود
    assert.equal((await w.riyadh.get(`/documents/${w.jeddahDoc}`)).status, 404);
    assert.equal((await w.riyadh.get(`/documents/${w.jeddahDoc}/pdf-data`)).status, 404);
    assert.equal((await w.riyadh.get(`/documents/${w.riyadhDoc}`)).status, 200);
    assert.match(await w.riyadh.html('/documents'), /مسؤول المستودع · فرع الرياض/);
  } finally { await w.site.close(); }
});

test('مسؤول الرياض ما يقدر يجهّز أو يسلّم فسح جدة', async () => {
  const w = await world();
  try {
    let res = await w.riyadh.post(`/documents/${w.jeddahDoc}/advance`, { expected_status: 'received', worker_name_new: 'سالم' }, '/documents');
    assert.equal(res.status, 404);
    assert.equal(w.site.db.prepare('SELECT status FROM documents WHERE id = ?').get(w.jeddahDoc).status, 'received');

    // جدة تجهّزه، والرياض تحاول تسلّمه
    await w.jeddah.post(`/documents/${w.jeddahDoc}/advance`, { expected_status: 'received', worker_name_new: 'سالم' }, `/documents/${w.jeddahDoc}`);
    await w.jeddah.post(`/documents/${w.jeddahDoc}/advance`, { expected_status: 'preparing' }, `/documents/${w.jeddahDoc}`);
    res = await w.riyadh.post('/handover', { doc_ids: w.jeddahDoc, courier_name: 'موصل' }, '/documents');
    assert.equal(res.status, 302);
    assert.equal(w.site.db.prepare('SELECT status FROM documents WHERE id = ?').get(w.jeddahDoc).status, 'prepared', 'ما انسلّم');

    res = await w.jeddah.post('/handover', { doc_ids: w.jeddahDoc, courier_name: 'موصل جدة' }, `/documents/${w.jeddahDoc}`);
    assert.equal(w.site.db.prepare('SELECT status FROM documents WHERE id = ?').get(w.jeddahDoc).status, 'handed_to_courier');
  } finally { await w.site.close(); }
});

test('أسماء الموظفين والموصلين لكل فرع، ونفس الاسم مسموح في فرعين', async () => {
  const w = await world();
  try {
    await w.jeddah.post(`/documents/${w.jeddahDoc}/advance`, { expected_status: 'received', worker_name_new: 'محمد' }, `/documents/${w.jeddahDoc}`);
    await w.riyadh.post(`/documents/${w.riyadhDoc}/advance`, { expected_status: 'received', worker_name_new: 'محمد' }, `/documents/${w.riyadhDoc}`);
    const rows = w.site.db.prepare('SELECT name, branch FROM workers ORDER BY branch').all();
    assert.deepEqual(rows.map(r => `${r.name}/${r.branch}`).sort(), ['محمد/الرياض', 'محمد/جدة']);

    // موظف خاص بالرياض ما يطلع في قائمة جدة، والاسم العام يطلع للكل
    await people.createWorker(w.site.db, { name: 'فهد', branch: 'الرياض' });
    await people.createWorker(w.site.db, { name: 'عام', branch: '' });
    const doc3 = await w.send('jeddah-2', 'جدة');
    const page = await w.jeddah.html(`/documents/${doc3}`);
    assert.doesNotMatch(page, /value="فهد"/);
    assert.match(page, /value="عام"/);
    assert.match(page, /value="محمد"/);

    await assert.rejects(() => people.createWorker(w.site.db, { name: 'فهد', branch: 'الرياض' }), /موجود في القائمة في فرع الرياض/);
    await assert.doesNotReject(() => people.createWorker(w.site.db, { name: 'فهد', branch: 'جدة' }));

    // الموصل المكتوب وقت التسليم ينحفظ لفرع الفسح
    const id = w.riyadhDoc;
    await w.riyadh.post(`/documents/${id}/advance`, { expected_status: 'preparing' }, `/documents/${id}`);
    await w.riyadh.post('/handover', { doc_ids: id, courier_name: 'ناصر' }, `/documents/${id}`);
    assert.equal(w.site.db.prepare("SELECT branch FROM couriers WHERE name = 'ناصر'").get().branch, 'الرياض');
  } finally { await w.site.close(); }
});

test('الإدارة تشوف كل الفروع وتفلتر، وتربط حساب المسؤول بفرعه', async () => {
  const w = await world();
  try {
    let list = await w.admin.html('/documents?status=received');
    assert.match(list, /عميل riyadh-1/);
    assert.match(list, /عميل jeddah-1/);
    assert.match(list, /class="chips"/);
    list = await w.admin.html('/documents?status=received&branch=' + encodeURIComponent('الرياض'));
    assert.match(list, /عميل riyadh-1/);
    assert.doesNotMatch(list, /عميل jeddah-1/);
    assert.match(list, /class="chip active" href="\/documents\?branch=/, 'فلتر الفرع مختار');
    assert.doesNotMatch(list, /class="tabs"/, 'بدون تبويبات المراحل');

    // حساب جديد مربوط بفرع
    const usersPage = await w.admin.html('/admin/users');
    assert.match(usersPage, /<option value="الرياض">/);
    const res = await w.admin.post('/admin/users', { full_name: 'مستودع الدمام', username: 'dammam', role: 'warehouse', branch: 'الرياض', password: 'dammam-pass-1', password2: 'dammam-pass-1' });
    assert.equal(res.status, 302);
    assert.equal(w.site.db.prepare("SELECT branch FROM users WHERE username = 'dammam'").get().branch, 'الرياض');
    // الإدارة دائماً بدون فرع
    await w.admin.post('/admin/users', { full_name: 'مدير 2', username: 'boss2', role: 'admin', branch: 'الرياض', password: 'boss2-pass-12', password2: 'boss2-pass-12' });
    assert.equal(w.site.db.prepare("SELECT branch FROM users WHERE username = 'boss2'").get().branch, null);
    // تعديل الفرع
    const uid = w.site.db.prepare("SELECT id FROM users WHERE username = 'dammam'").get().id;
    await w.admin.post(`/admin/users/${uid}`, { full_name: 'مستودع الدمام', role: 'warehouse', active: '1', branch: 'جدة' }, '/admin/users');
    assert.equal(w.site.db.prepare('SELECT branch FROM users WHERE id = ?').get(uid).branch, 'جدة');
  } finally { await w.site.close(); }
});

test('الفسح بدون فرع ينحسب على الفرع الرئيسي، والمسؤول بدون فرع يشوف الكل', async () => {
  const w = await world();
  try {
    const id = await w.send('nobranch', undefined);
    assert.equal(w.site.db.prepare('SELECT branch FROM documents WHERE id = ?').get(id).branch, 'جدة');
    const all = await loginAs(w.site, { username: 'everyone' });
    const list = await all.html('/documents?status=received');
    assert.match(list, /عميل riyadh-1/);
    assert.match(list, /عميل jeddah-1/);
  } finally { await w.site.close(); }
});
