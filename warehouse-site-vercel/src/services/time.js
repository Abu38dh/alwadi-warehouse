/**
 * عرض الأوقات: التخزين UTC، والعرض بتوقيت الرياض وبأرقام إنجليزية.
 */
const TZ = 'Asia/Riyadh';

const riyadhFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

const longDayFormat = new Intl.DateTimeFormat('ar-u-ca-gregory-nu-latn', {
  timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
});

function parts(t) {
  return Object.fromEntries(riyadhFormat.formatToParts(t).map(x => [x.type, x.value]));
}

function toDate(iso) {
  if (!iso) return null;
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : t;
}

/** "2026-11-18 10:05" بتوقيت الرياض */
function formatRiyadh(iso) {
  const t = toDate(iso);
  if (!t) return '';
  const p = parts(t);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function riyadhDay(t) {
  const p = parts(t);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "اليوم 10:05" / "أمس 18:30" / "2026-11-15 09:12" */
function formatWhen(iso, now = Date.now()) {
  const t = toDate(iso);
  if (!t) return '';
  const [day, time] = formatRiyadh(iso).split(' ');
  if (day === riyadhDay(new Date(now))) return `اليوم ${time}`;
  if (day === riyadhDay(new Date(now - 24 * 60 * 60 * 1000))) return `أمس ${time}`;
  return `${day} ${time}`;
}

/** وقت قصير لمراحل الفسح في القائمة: "اليوم 10:05" / "أمس 18:30" / "15/11 09:12" */
function formatStep(iso, now = Date.now()) {
  const w = formatWhen(iso, now);
  const m = /^(\d{4})-(\d{2})-(\d{2}) (.+)$/.exec(w);
  return m ? `${Number(m[3])}/${Number(m[2])} ${m[4]}` : w;
}

/** "صباح الخير" قبل الظهر بتوقيت الرياض، وإلا "مساء الخير" */
function greeting(now = Date.now()) {
  return Number(parts(new Date(now)).hour) < 12 ? 'صباح الخير' : 'مساء الخير';
}

/** "10:05" بتوقيت الرياض */
function formatTime(iso) {
  const full = formatRiyadh(iso);
  return full ? full.split(' ')[1] : '';
}

/** "الأربعاء، 18 نوفمبر 2026" */
function formatLongDay(now = Date.now()) {
  return longDayFormat.format(new Date(now));
}

/** العدد مع المعدود بالعربي: 1 دقيقة، 2 دقيقتين، 3-10 دقائق، 11+ دقيقة */
function countAr(n, [one, two, few, many]) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}

const M = (n) => countAr(n, ['دقيقة', 'دقيقتين', 'دقائق', 'دقيقة']);
const H = (n) => countAr(n, ['ساعة', 'ساعتين', 'ساعات', 'ساعة']);
const D = (n) => countAr(n, ['يوم', 'يومين', 'أيام', 'يوماً']);

/** مدة بالعربي: "12 دقيقة"، "ساعتين و5 دقائق"، "3 أيام وساعة" */
function durationAr(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return 'أقل من دقيقة';
  if (minutes < 60) return M(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const m = minutes % 60;
    return m ? `${H(hours)} و${M(m)}` : H(hours);
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${D(days)} و${H(h)}` : D(days);
}

/** المدة من وقت معيّن حتى الآن */
function durationSince(iso, now = Date.now()) {
  const t = toDate(iso);
  return t ? durationAr(now - t.getTime()) : '';
}

/** متوسط بالدقائق كنص ("—" إذا لا يوجد) */
function minutesText(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  return durationAr(Math.round(minutes) * 60000);
}

/** "منذ 5 دقائق" */
function timeAgoAr(iso, now = Date.now()) {
  const t = toDate(iso);
  if (!t) return '';
  const minutes = Math.floor(Math.max(0, now - t.getTime()) / 60000);
  if (minutes < 1) return 'الآن';
  return `منذ ${durationAr(minutes * 60000).split(' و')[0]}`;
}

/** بداية اليوم الحالي بتوقيت الرياض (UTC+3 بدون توقيت صيفي) كنص ISO */
function startOfRiyadhDayIso(now = Date.now()) {
  const offset = 3 * 60 * 60 * 1000;
  const shifted = new Date(now + offset);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offset).toISOString();
}

module.exports = { greeting, formatTime, formatRiyadh, formatWhen, formatStep, formatLongDay, timeAgoAr, countAr, durationAr, durationSince, minutesText, startOfRiyadhDayIso };
