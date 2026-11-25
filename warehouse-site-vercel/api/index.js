/**
 * مدخل فيرسيل: كل الطلبات تمر من هنا (vercel.json يحوّلها).
 * القاعدة تنفتح مرة وحدة لكل نسخة تشغيل (cold start) وتنعاد بعدها.
 */
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

let ready = null;

function init() {
  if (!ready) {
    ready = (async () => {
      const config = loadConfig();
      if (!config.databaseUrl) throw new Error('DATABASE_URL مطلوب في إعدادات فيرسيل');
      const db = await openDb({ url: config.databaseUrl, authToken: config.databaseAuthToken });
      return createApp({ config, db });
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

// فيرسيل يضيف دوال جاهزة على الطلب والرد (redirect بـ 307، وقراءة الجسم، ...) تغطي على دوال Express.
// 307 بعد نموذج يخلي المتصفح يعيد إرسال النموذج للصفحة الجاية — فنشيلها ونخلي Express يشتغل زي ما هو.
const VERCEL_RES_HELPERS = ['redirect', 'status', 'json', 'send'];
const VERCEL_REQ_HELPERS = ['query', 'body', 'cookies'];

function stripHelpers(req, res) {
  for (const k of VERCEL_RES_HELPERS) if (Object.prototype.hasOwnProperty.call(res, k)) delete res[k];
  for (const k of VERCEL_REQ_HELPERS) if (Object.prototype.hasOwnProperty.call(req, k)) delete req[k];
}

module.exports = async (req, res) => {
  stripHelpers(req, res);
  let app;
  try {
    app = await init();
  } catch (err) {
    console.error('تعذر تشغيل الموقع:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('الموقع ما اشتغل: ' + err.message);
  }
  return app(req, res);
};
