/**
 * wa-baileys.js
 *
 * اتصال واتساب عبر مكتبة Baileys (اتصال مباشر بخوادم واتساب بدون متصفح Chrome).
 * لا يتأثر بتغييرات موقع واتساب ويب التي كانت توقف مكتبة whatsapp-web.js.
 *
 * يوفر نفس الواجهة التي يستخدمها البرنامج من whatsapp-web.js:
 *   الأحداث: qr, authenticated, ready, disconnected
 *   الدوال: initialize, getChats, getChatById, getNumberId, sendMessage, logout, destroy
 *   MessageMedia.fromFilePath
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const DEFAULT_AUTH_DIR = path.join(__dirname, '.baileys_auth');

// حالات الرسالة في واتساب: 0 خطأ، 1 قيد الإرسال، 2 وصلت لخوادم واتساب، 3 وصلت للجهاز، 4 قُرئت
const STATUS_ERROR = 0;
const SERVER_ACK = 2;

// سجل صامت (Baileys يطبع رسائل تقنية كثيرة)
const silentLogger = {
  level: 'silent',
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger; }
};

/** خطأ "واتساب غير متصل": يصدر قبل أي إرسال، فالمستند لم يخرج ويمكن إعادة محاولته بأمان لاحقاً */
class WhatsAppNotReadyError extends Error {
  constructor(message = 'واتساب غير متصل حالياً') {
    super(message);
    this.code = 'WA_NOT_READY';
  }
}

let baileysPromise = null;
function loadBaileys() {
  if (!baileysPromise) baileysPromise = import('@whiskeysockets/baileys');
  return baileysPromise;
}

/** تحويل معرّفات whatsapp-web.js (@c.us) إلى صيغة Baileys (@s.whatsapp.net) */
function toJid(id) {
  const s = String(id || '').trim();
  if (s.endsWith('@c.us')) return s.slice(0, -'@c.us'.length) + '@s.whatsapp.net';
  return s;
}

/** رقم الحساب المتصل من معرّف Baileys مثل 966500000000:12@s.whatsapp.net */
function userFromJid(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

/** تحويل نتيجة groupFetchAllParticipating إلى نفس شكل محادثات whatsapp-web.js */
function mapGroups(groupsById) {
  return Object.values(groupsById || {})
    .filter(g => g && g.id && String(g.id).endsWith('@g.us'))
    .map(g => ({ isGroup: true, id: { _serialized: g.id }, name: g.subject || '' }));
}

class MessageMedia {
  constructor(filePath, mimetype, filename) {
    this.filePath = filePath;
    this.mimetype = mimetype;
    this.filename = filename;
  }

  static fromFilePath(filePath) {
    const isPdf = String(filePath).toLowerCase().endsWith('.pdf');
    return new MessageMedia(filePath, isPdf ? 'application/pdf' : 'application/octet-stream', path.basename(filePath));
  }

  /** ملف من الذاكرة (مثل سند التسليم اللي ينحمّل من الموقع) */
  static fromBuffer(data, mimetype, filename) {
    const m = new MessageMedia(null, mimetype, filename);
    m.data = data;
    return m;
  }
}

class BaileysClient extends EventEmitter {
  constructor({ authDir = DEFAULT_AUTH_DIR, reconnectBaseMs = 2000 } = {}) {
    super();
    this.authDir = authDir;
    this.reconnectBaseMs = reconnectBaseMs;
    this.sock = null;
    this.info = null;
    this.isReady = false;
    this.destroyed = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.hasAuthenticated = false;
  }

  async initialize() {
    this.destroyed = false;
    await this._connect();
  }

  async _connect() {
    const B = await loadBaileys();
    const makeWASocket = B.default || B.makeWASocket;
    // إغلاق أي اتصال سابق حتى لا يبقى اتصالان بنفس الحساب
    if (this.sock) {
      const old = this.sock;
      this.sock = null;
      try { old.end(undefined); } catch (_) {}
    }
    const { state, saveCreds } = await B.useMultiFileAuthState(this.authDir);

    let version;
    try {
      ({ version } = await B.fetchLatestBaileysVersion());
    } catch (_) { /* يستخدم الإصدار المدمج في المكتبة */ }

    if (this.destroyed) return;

    const sock = makeWASocket({
      auth: state,
      logger: silentLogger,
      ...(version ? { version } : {}),
      browser: B.Browsers && typeof B.Browsers.windows === 'function' ? B.Browsers.windows('Desktop') : ['Windows', 'Desktop', '10.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => this._onConnectionUpdate(sock, update, B));
  }

  _onConnectionUpdate(sock, update, B) {
    if (sock !== this.sock) return; // تحديث من اتصال قديم

    if (update.qr) {
      this.emit('qr', update.qr);
    }

    if (update.connection === 'open') {
      this.isReady = true;
      this.reconnectAttempts = 0;
      this.info = { wid: { user: userFromJid(sock.user && sock.user.id) } };
      if (!this.hasAuthenticated) {
        this.hasAuthenticated = true;
        this.emit('authenticated');
      }
      this.emit('ready');
      return;
    }

    if (update.connection === 'close') {
      this.isReady = false;
      if (this.destroyed) return;

      const err = update.lastDisconnect && update.lastDisconnect.error;
      const code = err && err.output && err.output.statusCode;
      const R = B.DisconnectReason || {};

      if (code === R.loggedOut) {
        // تم تسجيل الخروج من الجوال => يلزم باركود جديد
        this.emit('disconnected', 'LOGOUT');
        return;
      }
      if (code === R.connectionReplaced) {
        // تم فتح نفس الحساب في نسخة أخرى من البرنامج
        this.emit('disconnected', 'CONFLICT');
        return;
      }

      // إعادة اتصال تلقائية (بعد مسح الباركود يطلب واتساب إعادة الاتصال، أو انقطاع الإنترنت، أو انتهاء صلاحية الباركود)
      // يُبلَّغ البرنامج أن الاتصال انقطع مؤقتاً حتى لا يحاول الإرسال الآن
      this.emit('reconnecting', code);
      this.reconnectAttempts++;
      const delay = code === R.restartRequired ? 0 : Math.min(this.reconnectBaseMs * this.reconnectAttempts, 30000);
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        if (this.destroyed) return;
        this._connect().catch((e) => {
          this.emit('disconnected', `RECONNECT_FAILED: ${e.message}`);
        });
      }, delay);
    }
  }

  /** انتظار الاتصال (مثلاً أثناء إعادة اتصال قصيرة) قبل الإرسال */
  _ensureReady(timeoutMs = 30000) {
    if (this.isReady && this.sock) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onReady = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this.removeListener('ready', onReady);
        reject(new WhatsAppNotReadyError());
      }, timeoutMs);
      this.once('ready', onReady);
    });
  }

  async getChats() {
    await this._ensureReady();
    return mapGroups(await this.sock.groupFetchAllParticipating());
  }

  /**
   * بيانات القروب من خوادم واتساب مباشرة (اسمه الحالي). يفشل إذا لم يعد القروب موجوداً أو الحساب ليس عضواً.
   */
  async getChatById(id) {
    await this._ensureReady();
    const jid = toJid(id);
    if (jid.endsWith('@g.us')) {
      const meta = await this.sock.groupMetadata(jid);
      if (!meta || !meta.id) return null;
      return { isGroup: true, id: { _serialized: meta.id }, name: meta.subject || '' };
    }
    return { isGroup: false, id: { _serialized: jid }, name: '' };
  }

  async getNumberId(phone) {
    await this._ensureReady();
    const digits = String(phone || '').replace(/\D/g, '');
    const result = await this.sock.onWhatsApp(digits);
    const first = Array.isArray(result) ? result[0] : null;
    return first && first.exists ? { _serialized: first.jid } : null;
  }

  /**
   * إرسال رسالة. مع waitForAck: ينتظر تأكيد خوادم واتساب (SERVER_ACK) ويعيد {ack, message}.
   */
  async sendMessage(chatId, content, options = {}) {
    await this._ensureReady();
    const jid = toJid(chatId);
    let payload;
    if (content && (content.filePath || content.data)) {
      const data = content.data || fs.readFileSync(content.filePath);
      const mimetype = content.mimetype || 'application/pdf';
      // الصور تنرسل كصورة (تطلع في المحادثة)، والباقي كملف
      payload = /^image\/(jpeg|png|webp)$/.test(mimetype)
        ? { image: data, mimetype, caption: options.caption || undefined }
        : { document: data, mimetype, fileName: content.filename || (content.filePath ? path.basename(content.filePath) : 'file.pdf'), caption: options.caption || undefined };
    } else {
      payload = { text: String(content) };
    }

    if (!options.waitForAck) return this.sock.sendMessage(jid, payload);

    const sock = this.sock;
    const statuses = new Map(); // معرّف الرسالة => أعلى حالة وصلت
    let wantedId = null;
    let settle = null;
    const ackPromise = new Promise((resolve) => { settle = resolve; });
    const record = (id, st) => {
      if (st === STATUS_ERROR) statuses.set(id, STATUS_ERROR);
      else if (statuses.get(id) !== STATUS_ERROR) statuses.set(id, Math.max(statuses.get(id) || 0, st));
      if (id === wantedId) {
        if (st === STATUS_ERROR) settle(false);
        else if (st >= SERVER_ACK) settle(true);
      }
    };
    // تحديثات حالة الرسالة (الخطأ، أو الوصول في المحادثات الفردية)
    const onUpdate = (updates) => {
      for (const u of updates || []) {
        const id = u && u.key && u.key.id;
        const st = u && u.update && u.update.status;
        if (id && typeof st === 'number') record(id, st);
      }
    };
    // رد خادم واتساب على كل رسالة نرسلها (يشمل القروبات): <ack class="message" id="..."/> وبدون error = استلمها الخادم
    const onServerAck = (node) => {
      const attrs = (node && node.attrs) || {};
      if (attrs.id) record(attrs.id, attrs.error ? STATUS_ERROR : SERVER_ACK);
    };
    sock.ev.on('messages.update', onUpdate);
    if (sock.ws && typeof sock.ws.on === 'function') sock.ws.on('CB:ack,class:message', onServerAck);
    let timer = null;
    let hardTimer = null;
    try {
      // حد أعلى للإرسال نفسه: لو علق رفع الملف ما يوقف طابور الإرسال كله للأبد.
      // النتيجة "بدون تأكيد" => المستند يروح للمراجعة وما ينعاد تلقائياً (ما ندري هل طلع أو لا).
      const message = await Promise.race([
        sock.sendMessage(jid, payload),
        new Promise((resolve) => { hardTimer = setTimeout(() => resolve(null), options.sendTimeoutMs || 180000); })
      ]);
      clearTimeout(hardTimer);
      if (!message) return { ack: false, message: null, timedOut: true };
      wantedId = message && message.key && message.key.id;
      if (!wantedId) return { ack: false, message };
      if (statuses.get(wantedId) === STATUS_ERROR) return { ack: false, message };
      if ((statuses.get(wantedId) || 0) >= SERVER_ACK) return { ack: true, message };
      const ack = await Promise.race([
        ackPromise,
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), options.ackTimeoutMs || 60000); })
      ]);
      return { ack, message };
    } finally {
      clearTimeout(timer);
      clearTimeout(hardTimer);
      try { sock.ev.off('messages.update', onUpdate); } catch (_) {}
      try { if (sock.ws && typeof sock.ws.off === 'function') sock.ws.off('CB:ack,class:message', onServerAck); } catch (_) {}
    }
  }

  async logout() {
    try { if (this.sock) await this.sock.logout(); } catch (_) {}
  }

  async destroy() {
    this.destroyed = true;
    this.isReady = false;
    clearTimeout(this.reconnectTimer);
    try { if (this.sock) this.sock.end(undefined); } catch (_) {}
    this.sock = null;
  }
}

module.exports = {
  BaileysClient,
  MessageMedia,
  WhatsAppNotReadyError,
  DEFAULT_AUTH_DIR,
  toJid,
  userFromJid,
  mapGroups
};
