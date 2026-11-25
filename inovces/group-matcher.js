/**
 * group-matcher.js
 *
 * منطق مطابقة رقم العميل مع اسم قروب واتساب (دوال نقية بدون أي اعتماد على واتساب).
 *
 * القواعد (صارمة — الإرسال لقروب خاطئ أسوأ بكثير من عدم الإرسال):
 *  - توحيد اسم القروب: NFKC + تحويل الأرقام العربية (٠-٩) والفارسية (۰-۹) إلى أرقام لاتينية.
 *  - استخراج الأرقام المستقلة بالنمط (?<!\d)\d{1,12}(?!\d).
 *  - القروب صالح فقط إذا احتوى اسمه على رقم واحد بالضبط.
 *  - المقارنة نصية تامة بعد حذف الأصفار البادئة من الطرفين (لا مطابقة جزئية أبداً).
 *  - قروب صالح واحد مطابق => إرسال. صفر => لا إرسال. أكثر من واحد => لا إرسال (غموض).
 */

const DIGIT_MAP = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
};

// رقم مستقل فقط: لا يلتصق برقم آخر ولا بحرف إنجليزي.
// "DMK2-OXSA" أو "4G" أو "B2B" أكواد وليست أرقام عملاء => تُتجاهل.
const NUMBER_REGEX = /(?<![\dA-Za-z])\d{1,12}(?![\dA-Za-z])/g;

function normalizeGroupName(name) {
  if (name == null) return '';
  return String(name).normalize('NFKC').replace(/[٠-٩۰-۹]/g, d => DIGIT_MAP[d]);
}

function stripLeadingZeros(digits) {
  return String(digits).replace(/^0+(?=\d)/, '');
}

function extractNumbers(name) {
  return normalizeGroupName(name).match(NUMBER_REGEX) || [];
}

/**
 * توحيد رقم العميل المستخرج من الفاتورة للمقارنة. يعيد null إذا لم يكن أرقاماً فقط.
 */
function canonicalCustomerNumber(customerNumber) {
  const normalized = normalizeGroupName(customerNumber).trim();
  if (!/^\d+$/.test(normalized)) return null;
  return stripLeadingZeros(normalized);
}

/**
 * تصنيف قروب واحد.
 * @param {{id: string, name: string}} group
 */
function classifyGroup(group, minDigits = 1) {
  const id = group && group.id ? String(group.id) : '';
  const name = group && group.name != null ? String(group.name) : '';
  const numbers = extractNumbers(name);

  if (numbers.length === 0) {
    return { id, name, numbers, valid: false, number: null, reason: 'لا يحتوي اسمه على أي رقم' };
  }
  if (numbers.length > 1) {
    return { id, name, numbers, valid: false, number: null, reason: `يحتوي اسمه على أكثر من رقم (${numbers.join('، ')})` };
  }
  // الرقم يجب أن يكون رقم عميل كامل (مثلاً 4 خانات أو أكثر) — "11" أو "2" ليست أرقام عملاء
  if (numbers[0].length < minDigits) {
    return { id, name, numbers, valid: false, number: null, reason: `الرقم (${numbers[0]}) أقل من ${minDigits} خانات فليس رقم عميل` };
  }
  return { id, name, numbers, valid: true, number: stripLeadingZeros(numbers[0]), reason: null };
}

/**
 * بناء فهرس القروبات: الصالحة، غير الصالحة، والفهرسة حسب رقم العميل الموحد.
 * القروبات المكررة بنفس المعرّف تُحسب مرة واحدة.
 * @param {Array<{id: string, name: string}>} groups
 */
function buildGroupIndex(groups, { minDigits = 1, excludeIds = [] } = {}) {
  const seen = new Set();
  const valid = [];
  const invalid = [];
  const byNumber = new Map();
  // قروبات داخلية (مثل قروب المستودع): ليست قروبات عملاء أبداً — لا تُطابَق ولا يظهر لها تحذير
  const excluded = new Set((excludeIds || []).filter(Boolean).map(String));

  for (const g of Array.isArray(groups) ? groups : []) {
    if (g && g.id && excluded.has(String(g.id))) continue;
    const item = classifyGroup(g, minDigits);
    if (item.id) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
    }
    if (item.valid) {
      valid.push(item);
      if (!byNumber.has(item.number)) byNumber.set(item.number, []);
      byNumber.get(item.number).push(item);
    } else {
      invalid.push(item);
    }
  }

  return { valid, invalid, byNumber, minDigits };
}

/**
 * البحث عن قروب العميل في الفهرس.
 * @returns {{status: 'match', group} | {status: 'none'} | {status: 'ambiguous', groups}}
 */
function findGroupForCustomer(index, customerNumber) {
  const key = canonicalCustomerNumber(customerNumber);
  if (key === null || !index || !index.byNumber) return { status: 'none' };
  // رقم العميل في المستند أقصر من رقم عميل حقيقي => لا إرسال (غالباً قراءة خاطئة)
  const raw = normalizeGroupName(customerNumber).trim();
  if (index.minDigits && raw.length < index.minDigits) return { status: 'invalid_customer', minDigits: index.minDigits };
  const matches = index.byNumber.get(key) || [];
  if (matches.length === 1) return { status: 'match', group: matches[0] };
  if (matches.length > 1) return { status: 'ambiguous', groups: matches.slice() };
  return { status: 'none' };
}

/**
 * البحث مع تحديث قائمة القروبات مرة واحدة فقط عند عدم وجود تطابق.
 * @param {() => object|null} getIndex   يعيد الفهرس الحالي
 * @param {() => Promise<boolean>} refresh يحدّث القائمة ويعيد true عند النجاح
 */
async function resolveWithRefresh(getIndex, refresh, customerNumber) {
  let index = getIndex();
  let refreshed = false;

  if (!index) {
    refreshed = true;
    await refresh();
    index = getIndex();
    if (!index) return { status: 'unavailable', refreshed };
  }

  let result = findGroupForCustomer(index, customerNumber);
  if (result.status === 'invalid_customer') return { ...result, refreshed };
  if (result.status === 'none' && !refreshed) {
    refreshed = true;
    await refresh();
    index = getIndex();
    if (!index) return { status: 'unavailable', refreshed };
    result = findGroupForCustomer(index, customerNumber);
  }
  return { ...result, refreshed };
}

/**
 * نص عربي يوضح سبب عدم الإرسال (أو null عند وجود تطابق).
 */
function describeResolution(result, customerNumber) {
  if (!result) return 'تعذر تحديد قروب العميل';
  switch (result.status) {
    case 'match':
      return null;
    case 'invalid_customer':
      return `رقم العميل [${customerNumber}] أقل من ${result.minDigits} خانات — ليس رقم عميل صحيح، لم يتم الإرسال`;
    case 'ambiguous':
      return `يوجد أكثر من قروب يطابق رقم العميل [${customerNumber}]: ${result.groups.map(g => `"${g.name}"`).join('، ')} — لم يتم الإرسال`;
    case 'unavailable':
      return `تعذر تحميل قائمة قروبات واتساب، لم يتم الإرسال للعميل [${customerNumber}]`;
    default:
      return `لا يوجد قروب واتساب صالح يحتوي اسمه على رقم العميل [${customerNumber}] (حتى بعد تحديث قائمة القروبات)`;
  }
}

/**
 * اسم العميل من اسم قروبه: الاسم بدون رقم العميل وبدون الفواصل حوله.
 * "مؤسسة النخبة - 1001" => "مؤسسة النخبة". يعيد '' إذا لم يبقَ اسم.
 */
// كلمات عامة في أسماء القروبات (مو اسم عميل): "عميل رقم 0004" => ما فيه اسم
const GENERIC_GROUP_WORDS = new Set(['عميل', 'العميل', 'عملاء', 'رقم', 'قروب', 'جروب', 'مجموعة', 'group', 'customer', 'client', 'no', 'no.', 'رقم:']);

function customerNameFromGroupName(name) {
  const cleaned = normalizeGroupName(name)
    .replace(NUMBER_REGEX, ' ')
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .replace(/\(\s*\)|\[\s*\]/g, ' ') // أقواس كانت حول الرقم
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—_|/\\:.،,#]+|[\s\-–—_|/\\:.،,#]+$/g, '')
    .trim();
  // الكلمات العامة والفواصل في أول الاسم وآخره تنشال ("عميل - شركة الأمل" => "شركة الأمل")،
  // ولو ما بقى شي ("عميل رقم") => ما نعرف الاسم
  const words = cleaned.split(/\s+/).filter(Boolean);
  const skip = (w) => GENERIC_GROUP_WORDS.has(w.toLowerCase()) || /^[\-–—_|/\\:.،,#]+$/.test(w);
  while (words.length && skip(words[0])) words.shift();
  while (words.length && skip(words[words.length - 1])) words.pop();
  return words.join(' ');
}

module.exports = {
  customerNameFromGroupName,
  normalizeGroupName,
  stripLeadingZeros,
  extractNumbers,
  canonicalCustomerNumber,
  classifyGroup,
  buildGroupIndex,
  findGroupForCustomer,
  resolveWithRefresh,
  describeResolution
};
