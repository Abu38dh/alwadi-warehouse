/**
 * اختبارات طبقة اتصال واتساب (Baileys) باستخدام اتصال وهمي — بدون حساب واتساب حقيقي.
 * التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { BaileysClient, MessageMedia, toJid, userFromJid, mapGroups } = require('./wa-baileys');

const R = { loggedOut: 401, connectionReplaced: 440, restartRequired: 515, connectionLost: 408 };
const B = { DisconnectReason: R };

function fakeSock(overrides = {}) {
  const sent = [];
  const EventEmitter = require('events');
  const ev = new EventEmitter();
  const ws = new EventEmitter();
  let n = 0;
  return {
    sent,
    ev,
    ws,
    ackMode: 'after', // after | before | none | error | update
    user: { id: '966500000001:7@s.whatsapp.net' },
    async groupFetchAllParticipating() {
      return {
        'g1@g.us': { id: 'g1@g.us', subject: 'مؤسسة النخبة 1001' },
        'g2@g.us': { id: 'g2@g.us', subject: 'شركة الأمل ١٠٠٢' }
      };
    },
    async groupMetadata(jid) {
      if (jid === 'gone@g.us') throw new Error('item-not-found');
      return { id: jid, subject: 'مؤسسة النخبة 1001' };
    },
    async onWhatsApp(n) { return [{ exists: n === '966500000002', jid: `${n}@s.whatsapp.net` }]; },
    async sendMessage(jid, content) {
      sent.push({ jid, content });
      const id = `MSG${++n}`;
      // مثل واتساب الحقيقي: الخادم يرد بـ <ack class="message" id=".."/> (وفيه error عند الرفض)
      const serverAck = (error) => ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { id, class: 'message', from: jid, ...(error ? { error } : {}) } });
      if (this.ackMode === 'before') serverAck();
      else if (this.ackMode === 'after') setTimeout(() => serverAck(), 20);
      else if (this.ackMode === 'error') setTimeout(() => { serverAck('479'); ev.emit('messages.update', [{ key: { id }, update: { status: 0 } }]); }, 20);
      else if (this.ackMode === 'update') setTimeout(() => ev.emit('messages.update', [{ key: { id }, update: { status: 2 } }]), 20);
      return { key: { id } };
    },
    end() {},
    ...overrides
  };
}

function readyClient(sock = fakeSock()) {
  const c = new BaileysClient({ authDir: path.join(__dirname, '.baileys_test_unused') });
  c.sock = sock;
  c._onConnectionUpdate(sock, { connection: 'open' }, B);
  return c;
}

test('تحويل المعرّفات وأسماء القروبات', () => {
  assert.equal(toJid('966500000002@c.us'), '966500000002@s.whatsapp.net');
  assert.equal(toJid('g1@g.us'), 'g1@g.us');
  assert.equal(userFromJid('966500000001:7@s.whatsapp.net'), '966500000001');
  assert.deepEqual(mapGroups({ 'a@g.us': { id: 'a@g.us', subject: 'محل 5' }, 'x@s.whatsapp.net': { id: 'x@s.whatsapp.net' } }),
    [{ isGroup: true, id: { _serialized: 'a@g.us' }, name: 'محل 5' }]);
});

test('الباركود ثم الاتصال: qr ثم authenticated مرة واحدة ثم ready', () => {
  const c = new BaileysClient();
  const sock = fakeSock();
  c.sock = sock;
  const events = [];
  for (const e of ['qr', 'authenticated', 'ready']) c.on(e, () => events.push(e));
  c._onConnectionUpdate(sock, { qr: 'QRDATA' }, B);
  c._onConnectionUpdate(sock, { connection: 'open' }, B);
  c._onConnectionUpdate(sock, { connection: 'open' }, B); // إعادة اتصال
  assert.deepEqual(events, ['qr', 'authenticated', 'ready', 'ready']);
  assert.equal(c.info.wid.user, '966500000001');
});

test('تسجيل الخروج من الجوال => disconnected LOGOUT بدون إعادة اتصال', () => {
  const c = readyClient();
  let reason = null;
  c.on('disconnected', r => { reason = r; });
  c._connect = async () => { throw new Error('should not reconnect'); };
  c._onConnectionUpdate(c.sock, { connection: 'close', lastDisconnect: { error: { output: { statusCode: R.loggedOut } } } }, B);
  assert.equal(reason, 'LOGOUT');
  assert.equal(c.isReady, false);
  assert.equal(c.reconnectTimer, null);
});

test('بعد مسح الباركود (restartRequired) أو انقطاع النت => إعادة اتصال تلقائية', async () => {
  const c = readyClient();
  c.reconnectBaseMs = 10;
  let reconnects = 0;
  c._connect = async () => { reconnects++; };
  c._onConnectionUpdate(c.sock, { connection: 'close', lastDisconnect: { error: { output: { statusCode: R.restartRequired } } } }, B);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(reconnects, 1);
  c._onConnectionUpdate(c.sock, { connection: 'close', lastDisconnect: { error: { output: { statusCode: R.connectionLost } } } }, B);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(reconnects, 2);
  await c.destroy();
});

test('تحديثات اتصال قديم تُتجاهل', () => {
  const c = readyClient();
  const old = fakeSock();
  let fired = false;
  c.on('disconnected', () => { fired = true; });
  c._onConnectionUpdate(old, { connection: 'close', lastDisconnect: { error: { output: { statusCode: R.loggedOut } } } }, B);
  assert.equal(fired, false);
  assert.equal(c.isReady, true);
});

test('جلب القروبات والتأكد من قروب بالاسم الحالي', async () => {
  const c = readyClient();
  const chats = await c.getChats();
  assert.deepEqual(chats.map(x => x.name), ['مؤسسة النخبة 1001', 'شركة الأمل ١٠٠٢']);
  assert.ok(chats.every(x => x.isGroup));
  const chat = await c.getChatById('g1@g.us');
  assert.equal(chat.name, 'مؤسسة النخبة 1001');
  await assert.rejects(() => c.getChatById('gone@g.us'));
});

test('إرسال PDF كمستند مع النص المرافق (للقروب ولرقم التجربة)', async () => {
  const sock = fakeSock();
  const c = readyClient(sock);
  const pdf = path.join(__dirname, 'samples', 'invoice_1001.pdf');
  await c.sendMessage('g1@g.us', MessageMedia.fromFilePath(pdf), { caption: 'مرفق فاتورتكم' });
  await c.sendMessage('966500000002@c.us', MessageMedia.fromFilePath(pdf), { caption: 'تجربة' });
  assert.equal(sock.sent[0].jid, 'g1@g.us');
  assert.equal(sock.sent[0].content.mimetype, 'application/pdf');
  assert.equal(sock.sent[0].content.fileName, 'invoice_1001.pdf');
  assert.equal(sock.sent[0].content.caption, 'مرفق فاتورتكم');
  assert.ok(Buffer.isBuffer(sock.sent[0].content.document) && sock.sent[0].content.document.length > 1000);
  assert.equal(sock.sent[1].jid, '966500000002@s.whatsapp.net');
});

test('تأكيد الاستلام من خوادم واتساب قبل اعتبار المستند مُرسلاً', async () => {
  const sock = fakeSock();
  const c = readyClient(sock);
  const pdf = MessageMedia.fromFilePath(path.join(__dirname, 'samples', 'invoice_1001.pdf'));

  sock.ackMode = 'after';
  assert.equal((await c.sendMessage('g1@g.us', pdf, { waitForAck: true, ackTimeoutMs: 1000 })).ack, true);

  sock.ackMode = 'before'; // التأكيد وصل حتى قبل انتهاء دالة الإرسال
  assert.equal((await c.sendMessage('g1@g.us', pdf, { waitForAck: true, ackTimeoutMs: 1000 })).ack, true);

  sock.ackMode = 'none'; // لا تأكيد => لا يُعتبر مؤكداً (لا يُحذف الملف)
  assert.equal((await c.sendMessage('g1@g.us', pdf, { waitForAck: true, ackTimeoutMs: 150 })).ack, false);

  sock.ackMode = 'error'; // الخادم رفض الرسالة
  assert.equal((await c.sendMessage('g1@g.us', pdf, { waitForAck: true, ackTimeoutMs: 1000 })).ack, false);

  sock.ackMode = 'update'; // تأكيد عبر تحديث الحالة (المحادثات الفردية)
  assert.equal((await c.sendMessage('966500000002@c.us', pdf, { waitForAck: true, ackTimeoutMs: 1000 })).ack, true);

  // تأكيد رسالة أخرى لا يُحسب لرسالتنا
  sock.ackMode = 'none';
  const p = c.sendMessage('g1@g.us', pdf, { waitForAck: true, ackTimeoutMs: 200 });
  setTimeout(() => sock.ws.emit('CB:ack,class:message', { attrs: { id: 'SOMEONE-ELSE', class: 'message' } }), 20);
  assert.equal((await p).ack, false);

  assert.equal(sock.ev.listenerCount('messages.update'), 0, 'لا تبقى مستمعات معلقة');
  assert.equal(sock.ws.listenerCount('CB:ack,class:message'), 0, 'لا تبقى مستمعات معلقة');
});

test('رقم التجربة: فحص وجود واتساب على الرقم', async () => {
  const c = readyClient();
  assert.deepEqual(await c.getNumberId('966500000002'), { _serialized: '966500000002@s.whatsapp.net' });
  assert.equal(await c.getNumberId('966500000009'), null);
});

test('الإرسال أثناء انقطاع قصير ينتظر عودة الاتصال، وإذا لم يعد يفشل بدون إرسال', async () => {
  const sock = fakeSock();
  const c = readyClient(sock);
  c.isReady = false;
  const p = c.sendMessage('g1@g.us', 'نص');
  setTimeout(() => c._onConnectionUpdate(sock, { connection: 'open' }, B), 30);
  await p;
  assert.equal(sock.sent.length, 1);

  c.isReady = false;
  await assert.rejects(() => c._ensureReady(50), (e) => /غير متصل/.test(e.message) && e.code === 'WA_NOT_READY');
});

test('انقطاع نت قصير => حدث reconnecting (حتى يعرف البرنامج أن الاتصال انقطع ولا يحاول الإرسال)', async () => {
  const c = readyClient();
  c.reconnectBaseMs = 10;
  c._connect = async () => {};
  const events = [];
  c.on('reconnecting', () => events.push('reconnecting'));
  c.on('disconnected', () => events.push('disconnected'));
  c._onConnectionUpdate(c.sock, { connection: 'close', lastDisconnect: { error: { output: { statusCode: R.connectionLost } } } }, B);
  assert.deepEqual(events, ['reconnecting']);
  assert.equal(c.isReady, false);
  await c.destroy();
});

test('إرسال أثناء الانقطاع: الخطأ يوضح أنه لم يُرسل شيء (WA_NOT_READY) ولم يخرج أي شيء', async () => {
  const sock = fakeSock();
  const c = readyClient(sock);
  c.isReady = false;
  c._ensureReady = (ms = 50) => BaileysClient.prototype._ensureReady.call(c, 50);
  await assert.rejects(() => c.sendMessage('g1@g.us', MessageMedia.fromFilePath(path.join(__dirname, 'samples', 'word_print_invoice_1001.pdf')), { waitForAck: true }), (e) => e.code === 'WA_NOT_READY');
  assert.equal(sock.sent.length, 0);
});

test('اسم الملف عند العميل: يُرسل بالاسم المحدد (مثل "فاتورة 1094.pdf") بدل اسم ملف الطباعة', async () => {
  const sock = fakeSock();
  const c = readyClient(sock);
  const media = MessageMedia.fromFilePath(path.join(__dirname, 'samples', 'invoice_1001.pdf'));
  media.filename = 'فاتورة 1094.pdf';
  await c.sendMessage('g1@g.us', media, { caption: 'x' });
  assert.equal(sock.sent[0].content.fileName, 'فاتورة 1094.pdf');
});

test('الإرسال علق (رفع الملف ما خلص) => يرجع "بدون تأكيد" بعد المهلة بدل ما يوقف الطابور للأبد', async () => {
  const sock = fakeSock({ sendMessage: () => new Promise(() => {}) }); // ما يرجع أبداً
  const c = readyClient(sock);
  const pdf = MessageMedia.fromFilePath(path.join(__dirname, 'samples', 'invoice_1001.pdf'));
  const t0 = Date.now();
  const r = await c.sendMessage('g1@g.us', pdf, { waitForAck: true, ackTimeoutMs: 1000, sendTimeoutMs: 150 });
  assert.equal(r.ack, false);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(sock.ev.listenerCount('messages.update'), 0, 'لا تبقى مستمعات معلقة');
});

test('سند التسليم من الذاكرة: الصورة تنرسل كصورة مع النص، والـ PDF كملف', async () => {
  const sock = fakeSock();
  const c = readyClient(sock);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20, 1)]);
  await c.sendMessage('g1@g.us', MessageMedia.fromBuffer(jpg, 'image/jpeg', 'سند.jpg'), { caption: 'تم شحن طلبكم' });
  await c.sendMessage('g1@g.us', MessageMedia.fromBuffer(Buffer.from('%PDF-1.4'), 'application/pdf', 'سند.pdf'));
  assert.ok(Buffer.isBuffer(sock.sent[0].content.image));
  assert.equal(sock.sent[0].content.caption, 'تم شحن طلبكم');
  assert.equal(sock.sent[0].content.document, undefined);
  assert.ok(Buffer.isBuffer(sock.sent[1].content.document));
  assert.equal(sock.sent[1].content.fileName, 'سند.pdf');
  assert.equal(sock.sent[1].content.mimetype, 'application/pdf');
});
