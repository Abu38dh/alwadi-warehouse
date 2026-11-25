/**
 * مفتاح الربط مع برنامج الإرسال.
 * المفتاح نفسه لا يُحفظ في الموقع (بصمته فقط)، ويظهر للإدارة مرة واحدة عند إنشائه.
 */
const crypto = require('crypto');
const { getSetting, setSetting } = require('../db');

const KEY_SETTING = 'integration_key';
const SEEN_SETTING = 'integration_last_seen';

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

/**
 * إنشاء مفتاح جديد (القديم يتوقف فوراً). يعيد المفتاح ليُعرض مرة واحدة.
 * internal = المفتاح أنشأه الموقع لبرنامج الإرسال اللي يشغّله بنفسه (النظام المدمج) — ما يحتاج أحد ينسخه.
 */
async function rotateKey(db, userId, { internal = false } = {}) {
  const key = `wh_${crypto.randomBytes(32).toString('base64url')}`;
  await setSetting(db, KEY_SETTING, { hash: hashKey(key), created_at: new Date().toISOString(), created_by: userId || null, internal });
  return key;
}

const NEXT_KEY_SETTING = 'integration_key_next';

function sameHash(presented, hash) {
  if (!hash || !presented) return false;
  const a = Buffer.from(hashKey(presented), 'hex');
  const b = Buffer.from(String(hash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * مفتاح لجهاز جديد (ملف تثبيت برنامج الواتساب): ما يوقف المفتاح الحالي.
 * أول ما يتصل الجهاز الجديد بهذا المفتاح يصير هو المفتاح، والقديم يتوقف — فما ينقطع الإرسال
 * لو انحمّل الملف وما انثبّت، وما يشتغل برنامجين مع بعض.
 */
async function prepareNextKey(db, userId) {
  const key = `wh_${crypto.randomBytes(32).toString('base64url')}`;
  await setSetting(db, NEXT_KEY_SETTING, { hash: hashKey(key), created_at: new Date().toISOString(), created_by: userId || null });
  return key;
}

async function verifyKey(db, presented) {
  if (!presented) return false;
  const saved = await getSetting(db, KEY_SETTING);
  if (saved && sameHash(presented, saved.hash)) return true;
  const next = await getSetting(db, NEXT_KEY_SETTING);
  if (next && sameHash(presented, next.hash)) {
    // الجهاز الجديد اتصل: مفتاحه يصير المفتاح الحالي
    await setSetting(db, KEY_SETTING, { hash: next.hash, created_at: next.created_at, created_by: next.created_by || null, internal: true });
    await setSetting(db, NEXT_KEY_SETTING, null);
    return true;
  }
  return false;
}

async function touchLastSeen(db, ip) {
  await setSetting(db, SEEN_SETTING, { at: new Date().toISOString(), ip: ip || null });
}

async function getInfo(db) {
  const key = await getSetting(db, KEY_SETTING);
  const seen = await getSetting(db, SEEN_SETTING);
  return {
    exists: !!(key && key.hash),
    internal: !!(key && key.internal),
    createdAt: key ? key.created_at : null,
    lastSeenAt: seen ? seen.at : null
  };
}

module.exports = { rotateKey, prepareNextKey, verifyKey, touchLastSeen, getInfo };
