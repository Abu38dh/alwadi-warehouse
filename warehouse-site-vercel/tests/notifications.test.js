/**
 * المرحلة 3: رسائل العميل في واتساب (الموقع يجهّزها، البرنامج يسحبها ويرسلها ويرد بالنتيجة).
 * التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePdf, startSite, setupAdmin, loginAs, newKey, upload, clearanceMeta } = require('./helpers');
const notifications = require('../src/services/notifications');

async function world({ docs = 2, withoutCustomer = false } = {}) {
  const site = await startSite();
  const admin = await setupAdmin(site);
  const key = await newKey(admin);
  for (let i = 1; i <= docs; i++) {
    const pdf = fakePdf(`notify-${i}`);
    const extra = withoutCustomer && i === docs
      ? { customer_number: null, customer_name: null, meta_problems: ['customer_number_missing'] }
      : { customer_number: String(4000 + i), customer_name: `مؤسسة ${i}` };
    assert.equal((await upload(site, key, pdf, clearanceMeta(pdf, extra))).status, 201);
  }
  const store = await loginAs(site, { username: 'store', fullName: 'جوال المستودع' });
  const api = async (method, path, body) => {
    const res = await fetch(site.base + '/api/integration' + path, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  };
  const rows = () => site.db.prepare('SELECT * FROM wa_notifications ORDER BY id').all();
  const start = (id, worker = 'محمد') => store.post(`/documents/${id}/advance`, { expected_status: 'received', worker_name_new: worker }, `/documents/${id}`);
  const finish = (id) => store.post(`/documents/${id}/advance`, { expected_status: 'preparing' }, `/documents/${id}`);
  const hand = (id, courier = 'سالم') => store.post('/handover', { courier_name: courier, doc_ids: [id] }, `/documents/${id}`);
  return { site, admin, store, key, api, rows, start, finish, hand };
}

test('الافتراضي: رسالتين للعميل فقط ("قيد التجهيز" و"تم الشحن")، بدون أي اسم موظف أو موصل', async () => {
  const w = await world({ docs: 1 });
  try {
    assert.equal(w.rows().length, 0, 'وصول الفسح ما يرسل شيء افتراضياً');
    await w.start(1, 'محمد');
    await w.finish(1);
    await w.hand(1, 'سالم');

    const r = w.rows();
    assert.deepEqual(r.map(n => n.event_type), ['preparing', 'handed_to_courier']);
    assert.ok(r.every(n => n.target === 'customer_group' && n.customer_number === '4001'));
    assert.equal(r[0].text, 'السلام عليكم، طلبكم قيد التجهيز في المستودع.');
    assert.equal(r[1].text, 'السلام عليكم، تم شحن طلبكم. شكراً لتعاملكم معنا.');
    for (const n of r) {
      assert.doesNotMatch(n.text, /محمد|سالم|جوال المستودع|مدير التجربة/, 'ما فيه أسماء');
    }
    // الأولى انلغت لأن الثانية أحدث (ما انسحبت للحين)
    assert.equal(r[0].state, 'skipped');
    assert.equal(r[1].state, 'pending');
  } finally { await w.site.close(); }
});

test('البرنامج يسحب الرسائل المنتظرة ويرد بالنتيجة — مرة وحدة بس', async () => {
  const w = await world({ docs: 2 });
  try {
    await w.start(1);
    await w.start(2);
    let r = await w.api('GET', '/notifications?limit=5');
    assert.equal(r.status, 200);
    assert.equal(r.json.max_age_minutes, 60);
    assert.equal(r.json.notifications.length, 2);
    const [a, b] = r.json.notifications;
    assert.deepEqual(Object.keys(a).sort(), ['created_at', 'customer_number', 'id', 'target', 'text']);
    assert.equal(a.customer_number, '4001');
    assert.equal(b.customer_number, '4002');

    r = await w.api('POST', `/notifications/${a.id}/ack`, { result: 'sent', reason: 'قروب: مؤسسة 1 4001' });
    assert.deepEqual(r.json, { ok: true, state: 'sent' });
    r = await w.api('POST', `/notifications/${a.id}/ack`, { result: 'failed', reason: 'متأخر' });
    assert.equal(r.json.already, true, 'النتيجة الثانية ما تغيّر شيء');
    assert.equal(w.rows().find(n => n.id === a.id).state, 'sent');
    assert.ok(w.rows().find(n => n.id === a.id).sent_at);

    await w.api('POST', `/notifications/${b.id}/ack`, { result: 'failed', reason: 'لا يوجد قروب واتساب صالح' });
    r = await w.api('GET', '/notifications');
    assert.equal(r.json.notifications.length, 0, 'ما يرجع شيء انرد عليه');

    assert.equal((await w.api('POST', `/notifications/${a.id}/ack`, { result: 'whatever' })).status, 400);
    assert.equal((await w.api('POST', '/notifications/99999/ack', { result: 'sent' })).status, 404);
  } finally { await w.site.close(); }
});

test('بدون مفتاح ربط صحيح: لا رسائل ولا نبضة', async () => {
  const w = await world({ docs: 1 });
  try {
    await w.start(1);
    for (const [method, path] of [['GET', '/notifications'], ['POST', '/notifications/1/ack'], ['POST', '/heartbeat']]) {
      const res = await fetch(w.site.base + '/api/integration' + path, { method, headers: { authorization: 'Bearer wh_wrong', 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    assert.equal(w.rows()[0].state, 'pending');
  } finally { await w.site.close(); }
});

test('الرسالة القديمة تنلغي ولا تنرسل، والتصحيح يلغي رسالة المرحلة اللي انلغت', async () => {
  const w = await world({ docs: 2 });
  try {
    await w.start(1);
    // رسالة عمرها ساعتين
    w.site.db.prepare("UPDATE wa_notifications SET created_at = ? WHERE document_id = 1").run(new Date(Date.now() - 2 * 3600 * 1000).toISOString());
    const r = await w.api('GET', '/notifications');
    assert.equal(r.json.notifications.length, 0);
    assert.equal(w.rows()[0].state, 'expired');
    assert.match(w.rows()[0].last_error, /60 دقيقة/);

    // التصحيح: الطلب رجع لـ"وصل" => رسالة "قيد التجهيز" اللي ما انرسلت تنلغي
    await w.start(2);
    assert.equal(w.rows().find(n => n.document_id === 2).state, 'pending');
    await w.admin.post('/documents/2/correct', { expected_status: 'preparing', reason: 'بالغلط' }, '/documents/2');
    const n2 = w.rows().find(n => n.document_id === 2);
    assert.equal(n2.state, 'skipped');
    assert.match(n2.last_error, /صحّحت/);
  } finally { await w.site.close(); }
});

test('نفس الرسالة ما تتكرر للعميل حتى لو تصحّحت الحالة ورجعت', async () => {
  const w = await world({ docs: 1 });
  try {
    await w.start(1);
    const first = (await w.api('GET', '/notifications')).json.notifications[0];
    await w.api('POST', `/notifications/${first.id}/ack`, { result: 'sent' });
    // تصحيح ثم بدء التجهيز من جديد
    await w.admin.post('/documents/1/correct', { expected_status: 'preparing', reason: 'غيّرنا الموظف' }, '/documents/1');
    await w.start(1, 'فهد');
    assert.equal(w.rows().filter(n => n.event_type === 'preparing').length, 1, 'ما انضافت رسالة ثانية');
  } finally { await w.site.close(); }
});

test('فسح بدون رقم عميل: ما تنجهّز له رسالة (ما نعرف قروبه)', async () => {
  const w = await world({ docs: 1, withoutCustomer: true });
  try {
    await w.start(1);
    await w.finish(1);
    await w.hand(1);
    assert.equal(w.rows().length, 0);
  } finally { await w.site.close(); }
});

test('صفحة رسائل العملاء: تشغيل/إيقاف كل رسالة وتعديل نصها، والخانات المسموحة فقط', async () => {
  const w = await world({ docs: 2 });
  try {
    let page = await w.admin.html('/admin/whatsapp/messages');
    assert.match(page, /رسائل حالة الطلب/);
    assert.match(page, /name="enabled_preparing" value="1" checked/);
    assert.doesNotMatch(page, /name="enabled_received" value="1" checked/);
    assert.match(page, /برنامج الواتساب على جهاز الشركة ما يرد/);
    assert.equal((await w.store.get('/admin/whatsapp/messages')).status, 403, 'للإدارة فقط');
    assert.equal((await w.admin.get('/admin/messages')).headers.get('location'), '/admin/whatsapp/messages', 'الصفحة القديمة تحوّل');

    const form = {
      max_age_minutes: '30',
      enabled_received: '1', text_received: 'وصل طلبكم رقم {رقم_المستند} يا {اسم_العميل}.',
      enabled_preparing: '1', text_preparing: 'طلبكم قيد التجهيز ({التاريخ}).',
      text_prepared: 'تم التجهيز.',
      enabled_handed_to_courier: '1', text_handed_to_courier: 'تم شحن طلبكم.'
    };

    // خانة غير مسموحة
    let res = await w.admin.post('/admin/whatsapp/messages/status', { ...form, text_preparing: 'يجهّزه {اسم_الموظف}' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /الخانة \{اسم_الموظف\} غير مسموحة/);
    // اسم موظف أو موصل مكتوب في النص
    await w.start(1, 'خالد');
    res = await w.admin.post('/admin/whatsapp/messages/status', { ...form, text_handed_to_courier: 'سلّمه خالد للموصل.' });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /النص فيه اسم (&#34;|")خالد(&#34;|")/);
    assert.match(html, /سلّمه خالد للموصل/, 'النص اللي كتبه ما يضيع');
    // كلمة فيها نفس الحروف لكنها مو الاسم: مقبولة ("عليكم" مو "علي")
    await w.admin.post('/admin/couriers', { name: 'علي' }, '/admin/couriers');
    res = await w.admin.post('/admin/whatsapp/messages/status', { ...form, text_handed_to_courier: 'السلام عليكم، تم شحن طلبكم.' });
    assert.equal(res.status, 302);

    const cfg = await notifications.getConfig(w.site.db);
    assert.equal(cfg.max_age_minutes, 30);
    assert.equal(cfg.events.received.enabled, true);
    assert.equal(cfg.events.prepared.enabled, false);

    // الرسائل الجديدة بالنص الجديد (والخانة الفاضية تنشال)
    const pdf = fakePdf('notify-new');
    await upload(w.site, w.key, pdf, clearanceMeta(pdf, { customer_number: '4999', customer_name: 'شركة الأمل' }));
    const n = w.rows().find(r => r.event_type === 'received');
    assert.equal(n.text, 'وصل طلبكم يا شركة الأمل.');
    page = await w.admin.html('/admin/whatsapp/messages');
    assert.match(page, /وصل طلبكم رقم 1911020 يا مؤسسة النخبة\./, 'مثال بقيم تجريبية');
  } finally { await w.site.close(); }
});

test('نبضة البرنامج: الإدارة تشوف هل واتساب متصل أو منقطع ومن متى', async () => {
  const w = await world({ docs: 1 });
  try {
    assert.equal((await w.api('POST', '/heartbeat', { whatsapp: 'maybe' })).status, 400);
    const beat = await w.api('POST', '/heartbeat', { whatsapp: 'connected', outbox_pending: 0 });
    assert.equal(beat.status, 200);
    // الرد يحمل أسماء الفروع (البرنامج يعرض لكل فرع خانة قروب مستودعه)
    assert.equal(beat.json.main_branch, 'جدة');
    assert.ok(beat.json.branches.includes('جدة'));
    const hasDot = (html) => { const i = html.indexOf('href="/admin/whatsapp" class="side-link'); return i >= 0 && html.slice(i, html.indexOf('</a>', i)).includes('nav-dot'); };
    assert.equal(hasDot(await w.admin.html('/documents')), false, 'متصل: بدون نقطة حمراء');

    await w.api('POST', '/heartbeat', { whatsapp: 'down', outbox_pending: 2 });
    const firstDown = (await notifications.programStatus(w.site.db)).since;
    await w.api('POST', '/heartbeat', { whatsapp: 'down', outbox_pending: 2 });
    assert.equal((await notifications.programStatus(w.site.db)).since, firstDown, 'وقت الانقطاع ما يتغير مع كل نبضة');
    assert.equal(hasDot(await w.admin.html('/documents')), true, 'منقطع: نقطة حمراء');

    // البرنامج ساكت أكثر من 3 دقائق
    const hb = JSON.parse(w.site.db.prepare("SELECT value_json FROM settings WHERE key = 'program_heartbeat'").get().value_json);
    hb.at = new Date(Date.now() - 10 * 60000).toISOString();
    w.site.db.prepare("UPDATE settings SET value_json = ? WHERE key = 'program_heartbeat'").run(JSON.stringify(hb));
    assert.equal(hasDot(await w.admin.html('/documents')), true, 'البرنامج ساكت: نقطة حمراء');
  } finally { await w.site.close(); }
});

test('الإدارة تشوف رسائل العميل في صفحة الفسح، والمسؤول ما يشوفها', async () => {
  const w = await world({ docs: 1 });
  try {
    await w.start(1);
    assert.match(await w.admin.html('/documents/1'), /رسائل العميل في واتساب[\s\S]*طلبكم قيد التجهيز[\s\S]*بانتظار الإرسال/);
    assert.doesNotMatch(await w.store.html('/documents/1'), /رسائل العميل في واتساب/);
  } finally { await w.site.close(); }
});

test('فحص الأسماء: كلمات كاملة فقط', () => {
  assert.equal(notifications.findName('السلام عليكم', ['علي', 'سالم']), null);
  assert.equal(notifications.findName('سلّمه علي للموصل', ['علي']), 'علي');
  assert.equal(notifications.findName('مع محمد أحمد', ['محمد أحمد']), 'محمد أحمد');
  assert.equal(notifications.findName('مع محمد', ['محمد أحمد']), null);
  assert.equal(notifications.render('طلبكم رقم {رقم_المستند} ، شكراً', {}), 'طلبكم، شكراً');
});
