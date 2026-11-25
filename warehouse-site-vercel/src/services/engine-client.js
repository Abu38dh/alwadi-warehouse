/**
 * نفس واجهة engine-client في الموقع المحلي (get/post/call + EngineDown)، بس على RemoteEngine:
 * القراءة من آخر حالة أرسلها برنامج الواتساب، والأوامر تنتظر البرنامج ينفذها.
 */
const { EngineDown } = require('./remote-engine');

const call = (engine, method, pathname, body, opts = {}) => engine.call(method, pathname, body, opts);
const get = (engine, pathname, opts) => call(engine, 'GET', pathname, undefined, opts);
const post = (engine, pathname, body = {}, opts) => call(engine, 'POST', pathname, body, opts);

module.exports = { EngineDown, call, get, post };
