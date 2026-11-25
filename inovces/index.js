/**
 * invoice-sender
 * 
 * نظام ذكي لإرسال الفواتير، الفسوحات، والمرتجعات تلقائياً عبر واتساب
 * مع واجهة مستخدم (Desktop Window) ولوحة تحكم للأدمن لإدارة بيانات العملاء
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const childProcess = require('child_process');

// كل أوامر ويندوز التي يشغّلها البرنامج تعمل بدون إظهار نوافذ سوداء (windowsHide)،
// ولا يُكتب أي نص (اسم ملف أو قروب) داخل نص الأمر — يُمرَّر كمعامل أو متغير بيئة فقط.

// ==========================================
// سجل البرنامج في ملف (الجهاز الرئيسي يعمل بدون نافذة سوداء، فالتفاصيل تُحفظ هنا للفحص عند الحاجة)
// ==========================================
(function setupFileLogging() {
  const logFile = process.env.ALWADY_LOG_FILE;
  if (!logFile) return;
  const util = require('util');
  const MAX_BYTES = 5 * 1024 * 1024;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_BYTES) fs.renameSync(logFile, logFile.replace(/\.log$/, '.old.log'));
  } catch (_) {}
  let writes = 0;
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      try {
        fs.appendFileSync(logFile, `${new Date().toLocaleString('en-GB')}  ${util.format(...args)}\n`, 'utf8');
        if (++writes % 500 === 0 && fs.statSync(logFile).size > MAX_BYTES) fs.renameSync(logFile, logFile.replace(/\.log$/, '.old.log'));
      } catch (_) {}
    };
  }
})();
const chokidar = require('chokidar');
const pdfParse = require('pdf-parse');
const groupMatcher = require('./group-matcher');
const printCapture = require('./print-capture');
const notifier = require('./notify');
const { CustomerReport, parseCustomerListFromItems, parseCustomerListFromCsv } = require('./customer-report');
const { WarehouseSync, validateSiteUrl } = require('./warehouse-sync');
const { WarehouseNotifier, ATTEMPTED_REASON } = require('./warehouse-notify');
const { SiteRelayInbox } = require('./site-relay-inbox');

// مكان ملفات بيانات البرنامج (سجل المستندات، سجل العملاء). الاختبارات تحوّله لمجلد مؤقت حتى لا تلمس البيانات الحقيقية.
const DATA_DIR = process.env.ALWADY_DATA_DIR || __dirname;

/**
 * وضع السيرفر (النظام المدمج): البرنامج يشتغل داخل موقع المستودع على السيرفر، والموقع هو اللي يشغّله.
 *  - لا طابعة ولا ربط شبكة محلية ولا نوافذ أو تنبيهات ويندوز (كل الأجهزة ترسل عن طريق الموقع).
 *  - الإعدادات وجلسة واتساب في مجلد البيانات (ALWADY_DATA_DIR) بدل مجلد البرنامج.
 *  - الشاشة تفتح من الموقع فقط (بعد دخول الإدارة)، والربط مع الموقع تلقائي.
 */
const HOSTED = process.env.ALWADY_HOSTED === '1';
if (HOSTED) process.env.ALWADY_NO_WINDOW = '1';
const HOSTED_UNAVAILABLE = 'غير متاح في النظام على السيرفر';
// وين يلقى المستخدم الباركود
const WHERE_QR = HOSTED ? 'صفحة "واتساب والإرسال" في موقع المستودع' : 'نافذة البرنامج';

// سجل العملاء وتقاريرهم (الجهاز الرئيسي فقط)
let customerReportStore = null;
function customerReports() {
  if (!customerReportStore) {
    const listFile = path.join(DATA_DIR, 'customers-list.json');
    const defaultList = path.join(__dirname, 'customers-list.default.json');
    // أول تشغيل: قائمة العملاء المرفقة مع البرنامج
    if (!fs.existsSync(listFile) && fs.existsSync(defaultList)) {
      try { fs.copyFileSync(defaultList, listFile); } catch (_) {}
    }
    customerReportStore = new CustomerReport({ dataDir: DATA_DIR });
  }
  return customerReportStore;
}

// حماية السيرفر من أي إغلاق مفاجئ
process.on('uncaughtException', (err) => {
  console.error('❌ خطأ غير متوقع تم التقاطه وتفاديه:', err ? (err.message || err) : 'Unknown');
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ استثناء تم التقاطه وتفاديه:', reason ? (reason.message || reason) : 'Unknown');
});

// ==========================================
// إعدادات البرنامج (CONFIG)
// ==========================================
// ==========================================
// إعدادات البرنامج وحفظها في settings.json
// ==========================================
const SETTINGS_FILE = path.join(HOSTED ? DATA_DIR : __dirname, 'settings.json');
const BAILEYS_AUTH_DIR = path.join(HOSTED ? DATA_DIR : __dirname, '.baileys_auth');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (_) {}
  return {
    delayMs: 5000,
    testPhone: '',
    captions: {
      invoice: 'السلام عليكم، مرفق فاتورتكم. شكراً لتعاملكم معنا.',
      clearance: 'السلام عليكم، مرفق بيان الفسح الخاص بكم. شكراً لتعاملكم معنا.',
      return: 'السلام عليكم، مرفق إشعار المرتجع الخاص بكم. شكراً لتعاملكم معنا.',
      statement: 'السلام عليكم، مرفق كشف حسابكم. شكراً لتعاملكم معنا.'
    }
  };
}

const currentSettings = loadSettings();

/** اسم فرع نظيف (نفس تنظيف الموقع) */
function cleanBranchName(value) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** رقم قروب المستودع: أرقام فقط (العربية تتحول)، بدون أصفار بادئة. غير صالح => '' */
function cleanWarehouseNumber(value) {
  const n = groupMatcher.canonicalCustomerNumber(String(value == null ? '' : value).replace(/\s+/g, ''));
  return n && n.length <= 12 ? n : '';
}

/** أرقام قروبات مستودعات الفروع البعيدة من الإعدادات: {فرع: رقم} — القيم غير الصالحة تُتجاهل */
function cleanBranchNumbers(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    const name = cleanBranchName(k);
    const num = cleanWarehouseNumber(v);
    if (name && num) out[name] = num;
  }
  return out;
}

function saveSettingsFile(newSettings) {
  try {
    Object.assign(currentSettings, newSettings);
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(currentSettings, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save settings:', e.message);
  }
}

const CONFIG = {
  // المجلد الرئيسي لمراقبة الملفات
  // مكان حفظ الفواتير: يختاره المستخدم من الإعدادات في الواجهة
  invoicesDir: process.env.INVOICES_DIR || currentSettings.invoicesDir || (fs.existsSync(path.join(__dirname, 'pdfssssssssss')) ? path.join(__dirname, 'pdfssssssssss') : 'C:\\Invoices'),

  // حذف المستند تلقائياً بعد تأكيد واتساب أنه استلم الرسالة (لا يبقى أي ملف للمستندات المرسلة)
  deleteAfterSend: currentSettings.deleteAfterSend !== false,

  // رقم التجربة: إذا تم تعيينه تُرسل كل المستندات إليه بدلاً من قروب العميل (مع تسجيل القروب المستهدف)
  testPhone: process.env.TEST_PHONE || currentSettings.testPhone || '',

  // التشغيل التجريبي: لا يُرسل أي شيء ولا تُنقل الملفات، فقط يُسجّل القروب الذي كان سيُرسل إليه
  dryRun: ['1', 'true'].includes(String(process.env.DRY_RUN || '').toLowerCase()) || currentSettings.dryRun === true,

  // أقل عدد خانات لرقم العميل: الأرقام الأقصر (مثل 2 أو 11) لا تُعتبر أرقام عملاء لا في الفاتورة ولا في اسم القروب
  minCustomerDigits: Number(currentSettings.minCustomerDigits) || 4,

  // كود حسابات العملاء في كشوف الحساب: "رقم الحساب : 112110-3226" => رقم العميل 3226
  statementAccountPrefix: String(currentSettings.statementAccountPrefix || '112110').trim(),

  // دور الجهاز: 'server' = الجهاز الرئيسي (واتساب + الإرسال)، 'client' = جهاز فرعي (طباعة ورفع للجهاز الرئيسي فقط)
  mode: String(process.env.APP_MODE || currentSettings.mode || 'server').trim().toLowerCase(),
  deviceName: String(currentSettings.deviceName || require('os').hostname()).trim(),
  // على السيرفر ما فيه شبكة محلية: الأجهزة تتربط عن طريق الموقع
  relayEnabled: !HOSTED && currentSettings.relayEnabled !== false,
  relayPort: Number(currentSettings.relayPort) || 3501,
  relayHost: String(currentSettings.relayHost || '0.0.0.0').trim(),
  discoveryPort: Number(currentSettings.discoveryPort) || 3502,
  serverAddress: String(currentSettings.serverAddress || '').trim(),
  clientOutboxDir: currentSettings.clientOutboxDir || path.join(__dirname, 'outbox'),
  clientUiPort: Number(process.env.CLIENT_UI_PORT) || Number(currentSettings.clientUiPort) || 3510,
  dashboardHost: HOSTED ? '127.0.0.1' : String(currentSettings.dashboardHost || '127.0.0.1').trim(),


  // طابعة البرنامج: أي مستند يُطبع عليها يصل مباشرة إلى مجلد المراقبة (بدون PDF Creator)
  printerName: String(currentSettings.printerName || 'WhatsApp Sender').trim(),
  // على السيرفر ما فيه طابعة. ALWADY_PRINT_CAPTURE=1: البرنامج تابع لموقع على الإنترنت لكنه على جهاز الشركة نفسه
  // (فيه طابعة "WhatsApp Sender") فيلتقط المطبوع مباشرة
  printCaptureEnabled: (!HOSTED || process.env.ALWADY_PRINT_CAPTURE === '1') && currentSettings.printCaptureEnabled !== false,

  // مدة تحديث قائمة القروبات بالدقائق
  groupsRefreshMinutes: Number(process.env.GROUPS_REFRESH_MINUTES) || Number(currentSettings.groupsRefreshMinutes) || 10,

  // مهلة الانتظار بين الرسائل
  delayMs: currentSettings.delayMs || 5000,
  // أنواع المستندات التي تُرسل (الفسوحات موقوفة افتراضياً بطلب الإدارة)
  sendDocTypes: Object.assign({ invoice: true, clearance: false, return: true, statement: true }, currentSettings.sendDocTypes || {}),
  // أرقام العملاء النقدية: لا تُرسل لأي قروب، تُحفظ في مجلد "نقدي" ليطبعها موظف يدوياً
  cashCustomerNumbers: (Array.isArray(currentSettings.cashCustomerNumbers) ? currentSettings.cashCustomerNumbers : ['9999']).map(n => String(n).trim()).filter(Boolean),

  // المستودع: الفسح يُرسل لقروب المستودع (يُختار بمعرّفه من الإعدادات، وليس بمطابقة رقم في الاسم) ويُرفع لموقع المستودع.
  // إذا لم يُحدَّد قروب ولا موقع، يبقى الفسح على سلوكه السابق (حسب "إرسال الفسوحات").
  // كل فرع له قروب مستودع في اسمه رقم خاص فيه (مثل "مستودع جدة 95123698")، ويُلقى بالرقم مثل قروبات العملاء.
  // warehouseNumber = مستودع فرع الجهاز الرئيسي، warehouseBranchNumbers = {"الرياض": "95123699"} لباقي الفروع.
  warehouseNumber: cleanWarehouseNumber(currentSettings.warehouseNumber),
  warehouseBranchNumbers: cleanBranchNumbers(currentSettings.warehouseBranchNumbers),
  warehouseSiteUrl: String(process.env.WAREHOUSE_SITE_URL || currentSettings.warehouseSiteUrl || '').trim(),
  warehouseApiKey: String(process.env.WAREHOUSE_API_KEY || currentSettings.warehouseApiKey || '').trim(),
  warehouseOutboxDir: process.env.WAREHOUSE_OUTBOX_DIR || currentSettings.warehouseOutboxDir || path.join(HOSTED ? DATA_DIR : __dirname, 'warehouse-outbox'),

  // منفذ خادم لوحة التحكم وصفحة الأدمن
  port: process.env.PORT || 3500,

  // نصوص الرسائل المصاحبة لكل نوع مستند
  captions: currentSettings.captions,

  // وضع التصحيح في الطرفية
  // عرض نص المستند الخام في السجل (للفحص فقط — معطّل افتراضياً)
  debug: currentSettings.debug === true
};

// ==========================================
// تصنيف أنواع المستندات (فواتير، فسوحات، مرتجعات)
// ==========================================
const DOC_TYPES = {
  STATEMENT: {
    id: 'statement',
    name: 'كشف حساب',
    label: 'كشف حساب',
    subfolder: 'كشوفات',
    class: 'statement',
    defaultCaption: 'السلام عليكم، مرفق كشف حسابكم. شكراً لتعاملكم معنا.'
  },
  RETURN: {
    id: 'return',
    name: 'مرتجع',
    label: 'مرتجع مبيعات',
    subfolder: 'مرتجعات',
    class: 'return',
    defaultCaption: 'السلام عليكم، مرفق إشعار المرتجع الخاص بكم. شكراً لتعاملكم معنا.'
  },
  CLEARANCE: {
    id: 'clearance',
    name: 'فسح',
    label: 'فسح جمركي',
    subfolder: 'فسوحات',
    class: 'clearance',
    defaultCaption: 'السلام عليكم، مرفق بيان الفسح الخاص بكم. شكراً لتعاملكم معنا.'
  },
  INVOICE: {
    id: 'invoice',
    name: 'فاتورة',
    label: 'فاتورة مبيعات',
    subfolder: 'فواتير',
    class: 'invoice',
    defaultCaption: 'السلام عليكم، مرفق فاتورتكم. شكراً لتعاملكم معنا.'
  }
};

/**
 * التعرف الذكي على نوع المستند:
 * 1. إذا كان يحتوي على رقم حساب عميل (112110-xxxx) أو "كشف حساب" -> كشف حساب (Sent/كشوفات)
 *    (يُفحص أولاً لأن كشف الحساب قد يحتوي على كلمات مثل "مرتجع" في حركاته)
 * 2. إذا كان يحتوي على "مرتجع" -> مرتجع (Sent/مرتجعات)
 * 3. إذا كان يحتوي على "فسح" أو "فسخ" -> فسح (Sent/فسوحات)
 * 4. ما دون ذلك -> فاتورة (Sent/فواتير)
 */
// كلمة الفسح بكل أشكالها (العادية والمقلوبة الحروف)
// "قائمة الفسوحات" (الجمع) + المقلوبة "تاحوسفلا"
const CLEARANCE_WORDS = /فسح|فسخ|حسف|خسف|فسوح|حوسف/;

/** نص عنوان المستند: أعلى ربع الصفحة الأولى (كما تراه العين) */
function titleAreaText(layoutItems) {
  const page1 = (layoutItems || []).filter(i => i.page === 1);
  if (page1.length === 0) return '';
  const ys = page1.map(i => i.y);
  const top = Math.max(...ys), bottom = Math.min(...ys);
  const limit = top - 0.25 * Math.max(top - bottom, 1);
  return buildVisualLines(page1.filter(i => i.y >= limit)).map(l => l.text).join(' ');
}

function detectDocumentType(normalizedText, layoutItems = null) {
  if (!normalizedText) return DOC_TYPES.INVOICE;
  const lower = normalizedText.toLowerCase();

  const clean = normalizeArabicText(normalizedText).replace(BIDI_MARKS, '');

  // 1. عنوان المستند فيه "فسح" => فسح (حتى لو فيه كلمات مرتجع أو كشف حساب في مكان ثاني)
  if (layoutItems && CLEARANCE_WORDS.test(titleAreaText(layoutItems))) {
    return DOC_TYPES.CLEARANCE;
  }

  // 2. كشف حساب (برقم الحساب أو عنوانه) — قبل الفسح حتى لا يُوقف كشف فيه حركة "رسوم فسح"
  if (/كشف\s*(?:ال)?حساب|باسح(?:لا)?\s*فشك/.test(clean) || extractAccountCustomerNumbers(clean).length > 0) {
    return DOC_TYPES.STATEMENT;
  }

  // 3. الفسح في أي مكان — قبل المرتجع، حتى لا يُرسل فسح فيه كلمة "مرتجع" وهو موقوف
  // يُفحص النص بعد توحيده (الحروف بأشكالها الخاصة تتحول للعادية)، وبالشكل المعكوس أيضاً
  // لأن بعض ملفات PDF تخرج فيها الكلمات العربية مقلوبة الحروف (مثل "حسف" بدل "فسح")
  if (lower.includes('فسح') || lower.includes('فسخ') || CLEARANCE_WORDS.test(clean)) {
    return DOC_TYPES.CLEARANCE;
  }

  if (lower.includes('مرتجع') || /مرتجع|عجترم/.test(clean)) {
    return DOC_TYPES.RETURN;
  }

  return DOC_TYPES.INVOICE;
}

// ==========================================
// البث اللحظي الفوري عبر Server-Sent Events (SSE)
// ==========================================
const sseClients = new Set();

function broadcastSseEvent(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

// ==========================================
// فتح مجلدات وملفات ويندوز مع دعم المسارات العربية وجلب النافذة للأمام
// ==========================================
/**
 * تشغيل أمر PowerShell ثابت، والمسار يُمرَّر كمتغير بيئة (ALWADY_PATH) وليس داخل نص الأمر،
 * حتى لا يمكن لاسم ملف فيه رموز خاصة أن يتحول إلى أمر.
 */
function runPsWithPath(psScript, targetPath, cb) {
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  return childProcess.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, env: { ...process.env, ALWADY_PATH: targetPath } }, cb || (() => {}));
}

const BRING_EXPLORER_FRONT = `
    Start-Sleep -Milliseconds 250;
    $ws = New-Object -ComObject WScript.Shell;
    $null = $ws.AppActivate('File Explorer');
    $null = $ws.AppActivate('مستكشف الملفات');`;

function openFolderInExplorer(folderPath) {
  const resolved = path.resolve(folderPath || CONFIG.invoicesDir);
  console.log(`📂 تشغيل مستكشف الملفات للمجلد: "${resolved}"`);
  runPsWithPath(`
    Start-Process explorer.exe -ArgumentList ('"' + $env:ALWADY_PATH + '"');${BRING_EXPLORER_FRONT}
  `, resolved, (err) => {
    if (err) {
      console.warn(`تعذر عبر PowerShell، المحاولة مباشرة: ${err.message}`);
      childProcess.execFile('explorer.exe', [resolved], { windowsHide: true }, () => {});
    }
  });
}

function selectFileInExplorer(filePath) {
  const resolved = path.resolve(filePath);
  console.log(`📂 تشغيل مستكشف الملفات وتحديد الملف: "${resolved}"`);
  runPsWithPath(`
    Start-Process explorer.exe -ArgumentList ('/select,"' + $env:ALWADY_PATH + '"');${BRING_EXPLORER_FRONT}
  `, resolved, (err) => {
    if (err) {
      console.warn(`تعذر تحديد الملف، جاري فتح المجلد: ${err.message}`);
      openFolderInExplorer(path.dirname(resolved));
    }
  });
}

// ==========================================
// سجل العمليات الحي (Activity Logs)
// ==========================================
const activityLogs = [];

function addActivityLog(log) {
  const timeStr = new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = {
    id: Date.now() + Math.random().toString(36).substring(2, 5),
    time: timeStr,
    ...log
  };
  activityLogs.unshift(entry);
  if (activityLogs.length > 200) activityLogs.pop();

  // بث التحديث فورا للمتصفح بالملي ثانية دون الحاجة لتحديث الصفحة
  broadcastSseEvent('log_entry', entry);

  return entry;
}

// ==========================================
// توحيد النصوص العربية وقراءة الـ PDF
// ==========================================

function normalizeArabicText(text) {
  if (!text || typeof text !== 'string') return '';

  let normalized = text.normalize('NFKC');
  normalized = normalized.replace(/[\u064B-\u065F\u0670\u0640]/g, '');

  const easternDigitsMap = {
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
    '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
    '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
  };
  normalized = normalized.replace(/[٠-٩۰-۹]/g, digit => easternDigitsMap[digit]);
  normalized = normalized.replace(/[\u0649\u06CC]/g, '\u064A');

  return normalized;
}

// علامات الاتجاه غير المرئية (LRM/RLM/ALM وغيرها) التي قد تفصل الأرقام في نصوص PDF
const BIDI_MARKS = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;
const ACCOUNT_DASH = '[-\\u2010-\\u2015\\u2212]';

/**
 * كشف الحساب: "رقم الحساب : 112110-3226" => رقم العميل 3226
 * يبحث عن كل زوج أرقام مفصول بشرطة أحد طرفيه كود حسابات العملاء (112110)،
 * ويقبل الترتيب المعكوس (3226-112110) لأن بعض ملفات PDF تعكس اتجاه النص.
 * @returns {string[]} أرقام العملاء المكتشفة (قد تتكرر)
 */
function extractAccountCustomerNumbers(text, prefix = CONFIG.statementAccountPrefix) {
  const p = String(prefix || '').trim();
  if (!/^\d+$/.test(p) || !text) return [];
  // مطابقات متداخلة: كل رقم يليه شرطة ثم رقم
  const re = new RegExp(`(?<!\\d)(\\d+)(?=\\s*${ACCOUNT_DASH}\\s*(\\d+)(?!\\d))`, 'g');
  const found = [];
  for (const m of String(text).matchAll(re)) {
    const [, left, right] = m;
    if (left === p && right !== p) found.push(right);
    else if (right === p && left !== p) found.push(left);
  }
  return found;
}

function maskAccountNumbers(text, prefix = CONFIG.statementAccountPrefix) {
  const p = String(prefix || '').trim();
  if (!/^\d+$/.test(p)) return text;
  const re = new RegExp(`(?<!\\d)(?:${p}\\s*${ACCOUNT_DASH}\\s*\\d+|\\d+\\s*${ACCOUNT_DASH}\\s*${p})(?!\\d)`, 'g');
  return text.replace(re, ' ');
}

const DIGITS = '0-9\\u0660-\\u0669\\u06F0-\\u06F9';
const HAS_DIGIT = new RegExp(`[${DIGITS}]`);
const HAS_ARABIC_LETTER = /[ء-ي]/;
// أجزاء المربع العربي: رقم كامل (مع فواصله مثل 17-11-2026 أو 11:30)، أو نقطتين/فاصلة، أو كلمة
const RTL_TOKEN = new RegExp(`[${DIGITS}]+(?:[.,/:\\-][${DIGITS}]+)*|[:：،,]|[^\\s${DIGITS}:：،,]+`, 'g');

/**
 * مربع نص عربي محفوظ بترتيب القراءة (من اليمين) => بترتيب الشكل (من اليسار).
 * لو الرقم لاصق بالكلام بدون مسافة (مثل "١٠٠١رقم العميل :" أو "رقم العميل:1001")
 * نفصل الرقم والنقطتين عن الكلام أولاً، وإلا يجي الرقم بين كلمتي "رقم" و"العميل" ويضيع.
 */
function rtlPieceInVisualOrder(s, original) {
  if (HAS_DIGIT.test(s) && HAS_ARABIC_LETTER.test(s)) {
    const tokens = s.match(RTL_TOKEN) || [];
    if (tokens.length > 1) return ` ${tokens.reverse().join(' ')} `;
  }
  return /\s/.test(s) ? ` ${s.split(/\s+/).reverse().join(' ')} ` : original;
}

/**
 * إعادة بناء أسطر الصفحة كما تراها العين (من مواضع مربعات النص)، من اليسار لليمين.
 * المسافة الكبيرة بين مربعين تُكتب " | " (خانة أخرى)، والكبيرة جداً " || " (لا تُعبر أبداً).
 */
function buildVisualLines(layoutItems) {
  const lines = [];
  const sorted = [...(layoutItems || [])].sort((a, b) => a.page - b.page || b.y - a.y);
  for (const it of sorted) {
    let line = null;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 8; k--) {
      const l = lines[k];
      if (l.page === it.page && Math.abs(l.y - it.y) <= 0.45 * Math.max(l.h, it.h)) { line = l; break; }
    }
    if (line) { line.items.push(it); line.h = Math.max(line.h, it.h); }
    else lines.push({ page: it.page, y: it.y, h: it.h, items: [it] });
  }
  return lines.map(l => {
    const its = l.items.sort((a, b) => a.x - b.x);
    let text = '';
    // الخانات: كل مجموعة مربعات متقاربة (بدون فراغ واسع) = خانة واحدة، مع مكانها الأفقي
    const cells = [];
    let cell = null;
    its.forEach((it, i) => {
      // مربع عربي بعدة كلمات محفوظ بترتيب القراءة (من اليمين): نقلب ترتيب كلماته ليصير بترتيب الشكل (من اليسار)
      // مثال: "بيانات الشحن - رقم العميل : 2002" => "2002 : العميل رقم - الشحن بيانات"
      const s = it.str.trim();
      const piece = it.dir === 'rtl' ? rtlPieceInVisualOrder(s, it.str) : it.str;
      let sep = '';
      if (i > 0) {
        const prev = its[i - 1];
        const gap = it.x - (prev.x + prev.w);
        const hh = Math.max(prev.h, it.h);
        sep = gap > 25 * hh ? ' || ' : gap > 6 * hh ? ' | ' : gap > 0.15 * hh ? ' ' : '';
      }
      text += sep + piece;
      if (!cell || sep.includes('|')) { cell = { text: '', x0: it.x, x1: it.x + it.w }; cells.push(cell); }
      else if (sep) cell.text += sep;
      cell.text += piece;
      cell.x0 = Math.min(cell.x0, it.x);
      cell.x1 = Math.max(cell.x1, it.x + it.w);
    });
    const norm = (t) => normalizeArabicText(t).replace(BIDI_MARKS, '');
    return { page: l.page, y: l.y, h: l.h, text: norm(text), cells: cells.map(c => ({ ...c, text: norm(c.text).trim() })) };
  });
}

// وسم "رقم العميل" كما قد يظهر في السطر المرئي (الكلمتان بأي ترتيب، وكل كلمة قد تكون معكوسة الحروف)
const LAYOUT_LABEL_AR = '(?:(?:رقم|مقر)\\s*(?:العميل|ليمعلا)|(?:العميل|ليمعلا)\\s*(?:رقم|مقر))';
const LAYOUT_LABEL_EN = '\\b(?:Customer|Cust)\\.?\\s*(?:No|Number|ID|Code|#)\\.?|\\bAccount\\s*No\\.?|\\bCustomer(?=\\s*[:：])';

/**
 * رقم العميل من شكل الصفحة: يدور حول كلمة "رقم العميل" في كل الجهات (يسار، يمين، وتحت في نفس العمود).
 *  - يؤخذ فقط الرقم الملاصق للكلمة: بينهما مسافات أو نقطتان فقط، ولا يعبر فراغاً واسعاً (خانة أخرى).
 *  - إذا كان بجانب نفس الكلمة أكثر من رقم مختلف (مثلاً رقم يمينها ورقم يسارها) => يُرجع الرقمين => لا إرسال.
 *  - "تحت" فقط إذا ما فيه رقم بجانب الكلمة في نفس السطر، والرقم تحتها مباشرة وفي نفس العمود ووحده في خانته.
 * @returns {string[]} أرقام العملاء المختلفة الموجودة (فارغة = لم يُعثر على شيء)
 */
function extractCustomerNumbersByLayout(layoutItems, { maskAccounts = false } = {}) {
  if (!layoutItems || layoutItems.length === 0) return [];
  const found = new Map();
  const add = (n) => { const key = groupMatcher.stripLeadingZeros(n); if (!found.has(key)) found.set(key, n); };
  const mask = (t) => {
    let x = String(t || '')
      .replace(/\d{1,4}[-/]\d{1,2}[-/]\d{1,4}(?:[-/]\d+)*/g, '#')
      .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, '#');
    if (maskAccounts) x = maskAccountNumbers(x);
    return x;
  };
  const labelRe = new RegExp(`${LAYOUT_LABEL_AR}|${LAYOUT_LABEL_EN}`, 'gi');
  const leftNum = /(?<![\d#\-/.,])(\d+)\s*[:：]?\s*$/;
  const rightNum = /^\s*[:：.]?\s*(\d+)(?![\d#\-/.,])/;
  const lines = buildVisualLines(layoutItems);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (const cell of line.cells) {
      const t = mask(cell.text);
      for (const m of t.matchAll(labelRe)) {
        const before = t.slice(0, m.index);
        const after = t.slice(m.index + m[0].length);
        const near = [];
        const L = before.match(leftNum);
        const R = after.match(rightNum);
        if (L) near.push(L[1]);
        if (R) near.push(R[1]);
        if (near.length === 0) {
          // تحت الكلمة مباشرة (جدول: العنوان فوق والرقم تحته)، في نفس العمود، والخانة فيها الرقم وحده
          const below = lines.find(b => b.page === line.page && b.y < line.y && line.y - b.y <= 2.5 * Math.max(b.h, line.h));
          if (below) {
            for (const c of below.cells) {
              const overlap = Math.min(c.x1, cell.x1) - Math.max(c.x0, cell.x0);
              const v = mask(c.text).replace(/\s/g, '');
              if (overlap > 0 && /^\d+$/.test(v)) near.push(v);
            }
          }
        }
        near.forEach(add);
      }
    }
  }
  return [...found.values()];
}

/** هل الرقم موجود في سطر فيه وسم "رقم العميل" أو في السطر الذي تحته مباشرة (كما تراه العين)؟ */
function isNumberNearCustomerLabel(layoutItems, number) {
  const lines = buildVisualLines(layoutItems);
  const labelRe = new RegExp(`${LAYOUT_LABEL_AR}|${LAYOUT_LABEL_EN}`, 'i');
  const numRe = new RegExp(`(?<!\\d)0*${groupMatcher.stripLeadingZeros(number)}(?!\\d)`);
  const onlyNum = new RegExp(`^0*${groupMatcher.stripLeadingZeros(number)}$`);
  for (const line of lines) {
    for (const cell of line.cells) {
      if (!labelRe.test(cell.text)) continue;
      // في نفس خانة الكلمة
      if (numRe.test(cell.text)) return true;
      // أو وحده في الخانة اللي تحت الكلمة مباشرة (نفس العمود)
      const below = lines.find(b => b.page === line.page && b.y < line.y && line.y - b.y <= 2.5 * Math.max(b.h, line.h));
      if (below && below.cells.some(c => Math.min(c.x1, cell.x1) - Math.max(c.x0, cell.x0) > 0 && onlyNum.test(c.text.replace(/\s/g, '')))) return true;
    }
  }
  return false;
}

/**
 * نموذج فيه "رقم العميل" بخانة والرقم بخانة جنبها في نفس السطر، بينهم فراغ أوسع من المعتاد.
 * يُستخدم فقط كتأكيد لرقم لقيناه أصلاً بجانب الوسم في ترتيب نص الملف (دليلين متفقين)، وبشروط:
 *  - خانة الوسم ما فيها أي رقم،
 *  - الخانة الملاصقة (بدون خانة بينهم، وبدون فراغ واسع جداً) فيها الرقم وحده،
 *  - ما فيه رقم ثاني في الجهة الثانية من الوسم (وإلا ما ندري أيهم).
 */
function isNumberInCellBesideLabel(layoutItems, number) {
  const labelRe = new RegExp(`${LAYOUT_LABEL_AR}|${LAYOUT_LABEL_EN}`, 'i');
  const key = groupMatcher.stripLeadingZeros(number);
  const onlyNum = (t) => { const v = String(t || '').replace(/[\s:：]/g, ''); return /^\d+$/.test(v) ? groupMatcher.stripLeadingZeros(v) : null; };
  for (const line of buildVisualLines(layoutItems)) {
    const cells = line.cells;
    for (let i = 0; i < cells.length; i++) {
      if (!labelRe.test(cells[i].text) || /\d/.test(cells[i].text)) continue;
      const near = [];
      if (i > 0 && cells[i].x0 - cells[i - 1].x1 <= 25 * line.h) near.push(onlyNum(cells[i - 1].text));
      if (i < cells.length - 1 && cells[i + 1].x0 - cells[i].x1 <= 25 * line.h) near.push(onlyNum(cells[i + 1].text));
      const nums = [...new Set(near.filter(Boolean))];
      if (nums.length === 1 && nums[0] === key) return true;
    }
  }
  return false;
}

/**
 * رقم بجانب وسم في أعلى الصفحة الأولى (للفسح).
 * يُقرأ من الأسطر كما تراها العين: في الصفحة العربية الرقم يكون يسار الوسم.
 * الوسم يطلع بأشكال حسب البرنامج اللي طبع الـ PDF: عادي، كلماته مقلوبة، أو حروفه مقلوبة.
 * الوسم بشكله المرئي (السطر مرتب يسار => يمين): الرقم قبله. بشكله العادي (ترتيب القراءة): الرقم بعده.
 * كل شكل له اتجاهه بس، عشان ما ناخذ رقم الحقل اللي جنبه.
 * الأرقام المركّبة (2026/11/17/101698 أو 9507-5019) ما تنأخذ. رقمين مختلفين = ما نعرف => فاضي.
 * @returns {string} الرقم أو '' لو ما انقرأ بوضوح
 */
function numberBesideLabel(rawText, layoutItems, VISUAL, LOGICAL, minDigits = 3) {
  const NUM = `(?<![\\d/\\-])(\\d{${minDigits},12})(?![\\d/\\-])`;
  const before = new RegExp(`${NUM}\\s*[:：]?\\s*${VISUAL}`, 'g');
  const after = new RegExp(`${LOGICAL}\\s*[:：]?\\s*${NUM}`, 'g');
  const lines = [];
  if (Array.isArray(layoutItems) && layoutItems.length) {
    const pages = [...new Set(layoutItems.map(i => i.page))].sort((a, b) => a - b);
    for (const p of pages.slice(0, 1)) for (const l of buildVisualLines(layoutItems.filter(i => i.page === p))) lines.push(l.text);
  }
  // فواصل الأعمدة (|) تبقى: رقم من عمود ثاني ما يلتصق بالوسم لو خانة الوسم فاضية
  const clean = (s) => normalizeArabicText(String(s || '')).replace(BIDI_MARKS, '');
  const collect = (texts, re) => {
    const found = new Set();
    for (const t of texts) for (const m of clean(t).matchAll(re)) found.add(m[1]);
    return found;
  };
  // الأسطر المرئية: الرقم قبل الوسم بس. النص الخام (ترتيب القراءة): الرقم بعد الوسم بس.
  // (الاتجاه الثاني في الأسطر المرئية ممكن ياخذ رقم الحقل اللي بعده لو خانة الوسم فاضية)
  for (const [texts, re] of [[lines, before], [String(rawText || '').split(/\r?\n/), after]]) {
    const found = collect(texts, re);
    if (found.size === 1) return [...found][0];
    if (found.size > 1) return '';
  }
  return '';
}

/**
 * رقم الطلب في الفسح (اللي يعرفه العميل): "رقم أمر الشراء" في قائمة الفسوحات، أو "أمر بيع" في الشكل الثاني.
 * أشكاله المقلوبة: "الشراء أمر" / "ءارشلا رمأ" و "بيع أمر" / "عيب رمأ".
 */
function extractSalesOrderNumber(rawText, layoutItems = null) {
  // النقطتين ممكن تطلع بين كلمتين الوسم في السطر المقلوب ("1911620 الشراء: أمر رقم")
  const VISUAL = '(?:(?:ال)?شراء\\s*[:：]?\\s*أمر|[:：]?\\s*ءارش(?:لا)?\\s*رمأ|(?:ال)?بيع\\s*[:：]?\\s*أمر|[:：]?\\s*عيب(?:لا)?\\s*رمأ)';
  const LOGICAL = '(?:أمر\\s*(?:ال)?شراء|أمر\\s*(?:ال)?بيع)';
  return numberBesideLabel(rawText, layoutItems, VISUAL, LOGICAL);
}

/**
 * رقم العميل في قائمة الفسوحات: مكتوب "العميل : 9999" (بدون كلمة "رقم").
 * يُستخدم للفسح بس، ولو القراءة العادية ما لقت رقم — الفواتير والكشوفات ما تتغير قواعدها.
 */
function extractClearanceCustomerNumber(rawText, layoutItems = null) {
  const VISUAL = '(?:(?<![\\u0600-\\u06FF])العميل(?![\\u0600-\\u06FF])|(?<![\\u0600-\\u06FF])ليمعلا(?![\\u0600-\\u06FF]))';
  const LOGICAL = '(?:(?<![\\u0600-\\u06FF])العميل(?![\\u0600-\\u06FF]))';
  return numberBesideLabel(rawText, layoutItems, VISUAL, LOGICAL, 1);
}

/**
 * أصناف الفسح وكمياتها: عدد الأسطر في جدول الأصناف ومجموع عمود "الكمية".
 *  - يدوّر سطر العناوين اللي فيه "الكمية" مع "رقم القطعة" أو "رقم الصنف" (بأي اتجاه للحروف).
 *  - مكان عمود الكمية = مكان كلمة "الكمية" في سطر العناوين. كل سطر تحته فيه رقم في نفس المكان = صنف.
 *  - يوقف عند نهاية الجدول (الإجمالي / قام بالمراجعة / ملاحظة...) أو سطر عناوين جديد (صفحة ثانية).
 * @returns {{count: number, qty: number} | null} null = ما لقينا جدول أصناف واضح
 */
function extractClearanceItems(layoutItems) {
  if (!Array.isArray(layoutItems) || !layoutItems.length) return null;
  const norm = (s) => normalizeArabicText(String(s || '')).replace(BIDI_MARKS, '').replace(/[أإآ]/g, 'ا');
  const QTY = /(?:^|[^؀-ۿ])(?:ال)?كمي[هة](?![؀-ۿ])|[هة]يمك(?:لا)?(?![؀-ۿ])/;
  const PART = /القطع[هة]|[هة]عطقلا|الصنف|فنصلا/;
  const STOP = /الاجمالي|يلامجالا|يلامجلاا|المجموع|عومجملا|قام\s*بال|مقا|ملاحظ|ظحالم|التجهيز\s*:|التوقيع|عيقوتلا/;
  // كلمات السطر من مواضع الحروف/القطع (الحروف المتلاصقة = كلمة وحدة)
  const wordsOf = (items) => {
    const sorted = items.slice().sort((a, b) => a.x - b.x);
    const words = [];
    for (const it of sorted) {
      const s = String(it.str || '');
      if (!s.trim()) continue;
      const last = words[words.length - 1];
      const gap = last ? it.x - last.x1 : Infinity;
      if (last && gap <= Math.max(1.6, (it.h || 8) * 0.22)) { last.text += s; last.x1 = Math.max(last.x1, it.x + (it.w || 0)); }
      else words.push({ text: s, x0: it.x, x1: it.x + (it.w || 0) });
    }
    return words.map(w => ({ ...w, text: w.text.trim() })).filter(w => w.text);
  };
  const pages = [...new Set(layoutItems.map(i => i.page))].sort((a, b) => a - b);
  let count = 0;
  let qty = 0;
  let sawHeader = false;
  for (const p of pages) {
    const items = layoutItems.filter(i => i.page === p);
    const lines = buildVisualLines(items);
    let col = null;
    for (const line of lines) {
      const tol = Math.max(2, (line.h || 8) * 0.6);
      const lineItems = items.filter(i => Math.abs(i.y - line.y) <= tol);
      const words = wordsOf(lineItems);
      const text = norm(line.text);
      const qtyWord = words.find(w => QTY.test(norm(w.text)) || QTY.test(norm(w.text.split('').reverse().join(''))));
      if (qtyWord && PART.test(text)) {
        sawHeader = true;
        col = { x0: qtyWord.x0 - 12, x1: qtyWord.x1 + 12 };
        continue;
      }
      if (!col) continue;
      if (STOP.test(text)) { col = null; continue; }
      const cell = words.find(w => {
        const c = (w.x0 + w.x1) / 2;
        return c >= col.x0 && c <= col.x1 && /^\d+(?:[.,]\d+)?$/.test(normalizeArabicText(w.text));
      });
      if (!cell) continue;
      const n = Number(normalizeArabicText(cell.text).replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0 || n > 100000) continue;
      count += 1;
      qty += n;
    }
  }
  if (!sawHeader || count === 0) return null;
  return { count, qty: Math.round(qty * 100) / 100 };
}

/** كل اللي نحتاجه من الفسح: رقم العميل (بالقواعد العادية، ثم "العميل :") ورقم الطلب */
function extractClearanceData(rawText, layoutItems = null) {
  let extraction = extractCustomerNumber(rawText, layoutItems);
  const conflict = !extraction.success && (extraction.uniqueNumbers || []).length > 1;
  if (!extraction.success && !conflict) {
    const c = extractClearanceCustomerNumber(rawText, layoutItems);
    if (c) extraction = { success: true, customerNumber: c, pattern: 'العميل في قائمة الفسوحات' };
  }
  return { ...extraction, salesOrderNo: extractSalesOrderNumber(rawText, layoutItems), items: extractClearanceItems(layoutItems) };
}

function extractCustomerNumber(rawText, layoutItems = null) {
  const normalized = normalizeArabicText(rawText);
  const cleanText = normalized.replace(BIDI_MARKS, '');

  // 1. كشف الحساب: رقم العميل بعد كود الحساب (112110-xxxx)
  const accountNumbers = [...new Set(extractAccountCustomerNumbers(cleanText))];
  const prefix = CONFIG.statementAccountPrefix;

  // 2. وسم "رقم العميل": من شكل الصفحة أولاً (الرقم الملاصق للوسم كما تراه العين)، وإلا من ترتيب النص
  let labelResult;
  const layoutNumbers = extractCustomerNumbersByLayout(layoutItems, { maskAccounts: accountNumbers.length > 0 });
  if (layoutNumbers.length === 1) {
    labelResult = { success: true, customerNumber: layoutNumbers[0], pattern: 'رقم العميل بجانب الوسم في الصفحة', normalized };
  } else if (layoutNumbers.length > 1) {
    labelResult = {
      success: false,
      reason: `تم العثور على أكثر من رقم عميل مختلف (${layoutNumbers.join(', ')})`,
      uniqueNumbers: layoutNumbers,
      pattern: 'رقم العميل بجانب الوسم في الصفحة',
      normalized
    };
  } else {
    labelResult = extractCustomerNumberByLabel(accountNumbers.length ? maskAccountNumbers(cleanText) : cleanText, normalized);
    // احتياط: ترتيب النص داخل الملف قد يضع بجانب الوسم رقماً من خانة أخرى.
    // نقبل الرقم فقط إذا كان فعلاً في سطر "رقم العميل" (أو السطر الذي تحته مباشرة) في شكل الصفحة.
    const equalsAccount = accountNumbers.length === 1 && labelResult.success && groupMatcher.stripLeadingZeros(labelResult.customerNumber) === groupMatcher.stripLeadingZeros(accountNumbers[0]);
    if (labelResult.success && !equalsAccount && layoutItems && layoutItems.length > 0 && !isNumberNearCustomerLabel(layoutItems, labelResult.customerNumber)) {
      if (isNumberInCellBesideLabel(layoutItems, labelResult.customerNumber)) {
        labelResult = { ...labelResult, pattern: 'رقم العميل في الخانة المجاورة للوسم' };
      } else {
        labelResult = {
          success: false,
          reason: `الرقم [${labelResult.customerNumber}] ليس بجانب "رقم العميل" في شكل المستند — لم يتم الإرسال للتأكد`,
          uniqueNumbers: [labelResult.customerNumber],
          pattern: labelResult.pattern,
          normalized
        };
      }
    }
  }

  if (accountNumbers.length === 0) return labelResult;

  if (accountNumbers.length > 1) {
    return {
      success: false,
      reason: `تم العثور على أكثر من رقم حساب مختلف (${accountNumbers.map(n => `${prefix}-${n}`).join(', ')})`,
      uniqueNumbers: accountNumbers,
      pattern: 'رقم الحساب',
      normalized
    };
  }

  const accountCustomer = accountNumbers[0];
  if (labelResult.success && groupMatcher.stripLeadingZeros(labelResult.customerNumber) !== groupMatcher.stripLeadingZeros(accountCustomer)) {
    return {
      success: false,
      reason: `تعارض: رقم العميل [${labelResult.customerNumber}] لا يطابق رقم الحساب [${prefix}-${accountCustomer}]`,
      uniqueNumbers: [labelResult.customerNumber, accountCustomer],
      pattern: 'رقم الحساب',
      normalized
    };
  }
  if (!labelResult.success && labelResult.uniqueNumbers && labelResult.uniqueNumbers.length > 0) {
    return labelResult; // أرقام عملاء متضاربة في المستند => لا إرسال
  }

  return {
    success: true,
    customerNumber: accountCustomer,
    pattern: `رقم الحساب (${prefix}-رقم العميل)`,
    normalized
  };
}

function extractCustomerNumberByLabel(text, normalized) {
  // إخفاء التواريخ والأوقات وأرقام الفواتير المركبة حتى لا تلتقط بالخطأ كرقم عميل
  // مثل: 2026-11-15 أو 2026/11/15 أو 15/11/2026 أو 2026/11/15/101450 أو 10:20:05
  const textWithoutDates = text
    .replace(/\b\d{1,4}[-/]\d{1,2}[-/]\d{1,4}(?:[-/]\d+)*\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/\b\d+(?:[/]\d+)+\b/g, ' ');

  const patternSets = [
    // البحث أولاً في نفس السطر (نفضل الرقم الذي يسبق الوسم في نصوص PDF المعكوسة)
    [
      { name: 'رقم يليه وسم', regex: /(?<!\d)(\d+)(?!\d)[^\d\r\n]{0,25}?(?:رقم\s*العميل|(?:Customer|Cust(?!om))(?:\s*(?:No|Number|ID|Code|#))?|Account\s*No)/gi },
      { name: 'وسم يليه رقم', regex: /(?:رقم\s*العميل|(?:Customer|Cust(?!om))(?:\s*(?:No|Number|ID|Code|#))?|Account\s*No)[^\d\r\n]{0,25}?(?<!\d)(\d+)(?!\d)/gi },
      { name: 'رقم يليه وسم معكوس', regex: /(?<!\d)(\d+)(?!\d)[^\d\r\n]{0,25}?(?:ليمعلا\s*مقر|مقر\s*العميل|رقم\s*ليمعلا)/g },
      { name: 'وسم معكوس يليه رقم', regex: /(?:ليمعلا\s*مقر|مقر\s*العميل|رقم\s*ليمعلا)[^\d\r\n]{0,25}?(?<!\d)(\d+)(?!\d)/g }
    ],
    // البحث في متعدد الأسطر إن لم يجد في نفس السطر
    [
      { name: 'رقم يليه وسم (متعدد الأسطر)', regex: /(?<!\d)(\d+)(?!\d)\D{0,25}?(?:رقم\s*العميل|(?:Customer|Cust(?!om))(?:\s*(?:No|Number|ID|Code|#))?|Account\s*No)/gi },
      { name: 'وسم يليه رقم (متعدد الأسطر)', regex: /(?:رقم\s*العميل|(?:Customer|Cust(?!om))(?:\s*(?:No|Number|ID|Code|#))?|Account\s*No)\D{0,25}?(?<!\d)(\d+)(?!\d)/gi },
      { name: 'رقم يليه وسم معكوس (متعدد الأسطر)', regex: /(?<!\d)(\d+)(?!\d)\D{0,25}?(?:ليمعلا\s*مقر|مقر\s*العميل|رقم\s*ليمعلا)/g },
      { name: 'وسم معكوس يليه رقم (متعدد الأسطر)', regex: /(?:ليمعلا\s*مقر|مقر\s*العميل|رقم\s*ليمعلا)\D{0,25}?(?<!\d)(\d+)(?!\d)/g }
    ]
  ];

  // كل الاتجاهات في نفس المجموعة يجب أن تتفق على نفس الرقم.
  // مثال: "رقم الفاتورة: 101 رقم العميل: 3226" => الرقم قبل الوسم 101 وبعده 3226 => تعارض => لا إرسال (أفضل من إرسال لقروب خاطئ)
  for (const group of patternSets) {
    const found = new Map(); // الرقم الموحد => الرقم كما ورد
    const names = [];
    for (const { name, regex } of group) {
      const matches = [...textWithoutDates.matchAll(regex)];
      if (matches.length === 0) continue;
      names.push(name);
      for (const m of matches) {
        const key = groupMatcher.stripLeadingZeros(m[1]);
        if (!found.has(key)) found.set(key, m[1]);
      }
    }
    if (found.size === 0) continue;

    const uniqueNumbers = [...found.values()];
    if (uniqueNumbers.length === 1) {
      return { success: true, customerNumber: uniqueNumbers[0], pattern: names.join(' + '), normalized };
    }
    return {
      success: false,
      reason: `تم العثور على أكثر من رقم عميل مختلف (${uniqueNumbers.join(', ')})`,
      uniqueNumbers,
      pattern: names.join(' + '),
      normalized
    };
  }

  return {
    success: false,
    reason: 'لم يتم العثور على وسم رقم العميل أو رقمه في نص المستند',
    normalized
  };
}

function normalizePhone(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return null;

  let cleaned = rawPhone.replace(/\D/g, '');

  if (cleaned.startsWith('00')) {
    cleaned = cleaned.slice(2);
  }

  if (cleaned.startsWith('05') && cleaned.length === 10) {
    cleaned = '966' + cleaned.slice(1);
  } else if (cleaned.startsWith('5') && cleaned.length === 9) {
    cleaned = '966' + cleaned;
  }

  if (cleaned.length < 8) {
    return null;
  }

  return cleaned;
}

/**
 * قراءة نص PDF (بنفس طريقة المكتبة تماماً) + موضع كل مربع نص في الصفحة (layoutItems).
 * المواضع تُستخدم لمعرفة الرقم المكتوب فعلاً بجانب "رقم العميل" كما تراه العين،
 * لأن بعض برامج المحاسبة تحفظ مربعات النص داخل الملف بترتيب مختلف عن شكلها.
 */
async function parsePdf(dataBuffer) {
  const layoutItems = [];
  let pageNo = 0;
  const pagerender = (pageData) => {
    const page = ++pageNo;
    return pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }).then((textContent) => {
      let lastY, text = '';
      for (const item of textContent.items) {
        if (lastY == item.transform[5] || !lastY) text += item.str;
        else text += '\n' + item.str;
        lastY = item.transform[5];
        if (item.str && item.str.trim() && !item.transform[1] && !item.transform[2]) {
          const h = Math.max(Math.abs(item.transform[3]) || 0, item.height || 0) || 10;
          layoutItems.push({ page, str: item.str, dir: item.dir, x: item.transform[4], y: item.transform[5], w: item.width || 0, h });
        }
      }
      return text;
    });
  };
  // أول كم قراءة بعد تشغيل البرنامج تفشل مع ملفات جدولها الداخلي فيه خلل بسيط ("bad XRef entry")
  // — خلل في مكتبة القراءة نفسها (أول 3 مرات بالضبط) — وبعدها تنجح. كل محاولة فاشلة تاخذ ملي ثواني،
  // فنعيد على طول بدل ما ينتظر المستند أو يروح للمراجعة.
  const attempts = [...Array(5).fill({ version: 'v2.0.550' }), {}];
  let lastErr;
  for (const opts of attempts) {
    layoutItems.length = 0;
    pageNo = 0;
    try {
      const data = await pdfParse(dataBuffer, { ...opts, pagerender });
      data.layoutItems = layoutItems;
      return data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ==========================================
// إدارة المجلدات والتنظيم التلقائي
// ==========================================

function ensureDirectories() {
  const dirs = [
    CONFIG.invoicesDir,
    path.join(CONFIG.invoicesDir, 'Sent'),
    path.join(CONFIG.invoicesDir, 'Sent', 'فواتير'),
    path.join(CONFIG.invoicesDir, 'Sent', 'فسوحات'),
    path.join(CONFIG.invoicesDir, 'Sent', 'مرتجعات'),
    path.join(CONFIG.invoicesDir, 'Sent', 'كشوفات'),
    path.join(CONFIG.invoicesDir, 'Review'),
    path.join(CONFIG.invoicesDir, 'Review', 'فواتير'),
    path.join(CONFIG.invoicesDir, 'Review', 'فسوحات'),
    path.join(CONFIG.invoicesDir, 'Review', 'مرتجعات'),
    path.join(CONFIG.invoicesDir, 'Review', 'كشوفات')
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {}
    }
  }
}

// ==========================================
// إدارة سجل الملفات المعالجة لمنع تكرار الإرسال
// ==========================================
const PROCESSED_REGISTRY_FILE = path.join(DATA_DIR, 'processed_history.json');

function loadProcessedRegistry() {
  try {
    if (fs.existsSync(PROCESSED_REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(PROCESSED_REGISTRY_FILE, 'utf8'));
    }
  } catch (err) {
    // الملف تالف: نحتفظ بنسخة منه للفحص ولا نكتب فوقه
    const backup = `${PROCESSED_REGISTRY_FILE}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(PROCESSED_REGISTRY_FILE, backup); } catch (_) {}
    console.error(`❌ سجل المستندات المعالجة تالف، حُفظت نسخة منه في ${path.basename(backup)}`);
  }
  return {};
}

const processedRegistry = loadProcessedRegistry();

/** حفظ السجل بأمان: كتابة ملف مؤقت ثم استبدال (لا يتلف الملف إذا انطفأ الجهاز أثناء الكتابة) */
function saveProcessedRegistry() {
  const tmp = `${PROCESSED_REGISTRY_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(processedRegistry, null, 2), 'utf8');
  fs.renameSync(tmp, PROCESSED_REGISTRY_FILE);
}

function markFileAsProcessed(filePath, status, details = {}) {
  try {
    const fileName = path.basename(filePath);
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = fs.statSync(filePath);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch (_) {}
    processedRegistry[fileName] = {
      size,
      mtimeMs,
      processedAt: new Date().toISOString(),
      status,
      ...details
    };
    saveProcessedRegistry();
    // سجل العميل: كل مستند وصل لنتيجة (أُرسل / مراجعة / نقدي / موقوف)
    if (CONFIG.mode !== 'client' && !details.noReport && ['sent', 'review', 'skipped'].includes(status)) {
      try {
        // التقارير تنسب المستند لعميل بس لو رقمه مؤكد (reportCustomer). الرقم "المشتبه" يبقى للعرض بس
        const reportCustomer = details.reportCustomer !== undefined ? details.reportCustomer : details.customerNumber;
        customerReports().record({ file: fileName, size: details.size || size, customerNumber: reportCustomer, docSubfolder: details.docType, status, reason: details.reason, destination: details.destination, kind: details.kind });
      } catch (e) { console.warn('تحذير: تعذر تسجيل المستند في سجل العملاء:', e.message); }
    }
  } catch (e) {
    console.error('Failed to save processed registry:', e.message);
  }
}

function isFileAlreadyProcessed(filePath) {
  const fileName = path.basename(filePath);
  const entry = processedRegistry[fileName];
  if (!entry) return false;
  try {
    const st = fs.statSync(filePath);
    return st.size === entry.size;
  } catch (_) {
    return false;
  }
}

async function safeArchiveFile(sourcePath, targetFolder) {
  if (!fs.existsSync(sourcePath)) {
    return sourcePath;
  }

  fs.mkdirSync(targetFolder, { recursive: true });

  const fileName = path.basename(sourcePath);
  let targetPath = path.join(targetFolder, fileName);

  if (fs.existsSync(targetPath)) {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    targetPath = path.join(targetFolder, `${base}_${timestamp}${ext}`);
  }

  // نسخ الملف إلى مجلد الأرشيف مع الإبقاء التام على الملف الأصلي
  // حتى يتمكن PDF Architect والموظفون من فتحه دون أي خطأ مسار
  try {
    fs.copyFileSync(sourcePath, targetPath);
    return targetPath;
  } catch (err) {
    console.warn(`⚠ تعذر نسخ الملف (${fileName}) إلى الأرشيف: ${err.message}`);
    return sourcePath;
  }
}

const safeMoveFile = safeArchiveFile;

async function moveToSent(filePath, docType, details = {}) {
  const sub = (docType && docType.subfolder) ? docType.subfolder : 'فواتير';
  const sentDir = path.join(CONFIG.invoicesDir, 'Sent', sub);
  const archivedPath = await safeArchiveFile(filePath, sentDir);
  markFileAsProcessed(filePath, 'sent', { docType: sub, archivedPath, ...details });
  return archivedPath;
}

// ==========================================
// نتيجة معالجة كل ملف (للرد على الجهاز الفرعي الذي أرسله)
// ==========================================
const fileOutcomes = new Map();

function recordOutcome(fileName, outcome) {
  fileOutcomes.set(fileName, { ...outcome, at: new Date().toISOString() });
  if (fileOutcomes.size > 5000) fileOutcomes.delete(fileOutcomes.keys().next().value);
}

function getOutcome(fileName) {
  const live = fileOutcomes.get(fileName);
  if (live) return live;
  const r = processedRegistry[fileName];
  if (r && r.status === 'sent') return { status: 'sent', customerNumber: r.customerNumber || '', destination: r.destination || r.phone || '' };
  if (r && r.status === 'test') return { status: 'sent', customerNumber: r.customerNumber || '', destination: `${r.destination || ''} (تجربة — لم يُرسل للعميل)` };
  if (r && r.status === 'review') return { status: 'review', customerNumber: r.customerNumber || '', message: r.reason || '' };
  if (r && r.status === 'skipped') return { status: 'skipped', customerNumber: r.customerNumber || '', message: r.reason || '' };
  return null;
}

/**
 * نقل ملف (وليس نسخه) إلى مجلد، حتى لا تبقى نسختان من نفس المستند.
 * إذا كان الملف موجوداً أصلاً في نفس المجلد (مثل إعادة محاولة من Review) يبقى مكانه.
 */
function safeRelocateFile(sourcePath, targetFolder) {
  if (!fs.existsSync(sourcePath)) return sourcePath;
  if (path.resolve(path.dirname(sourcePath)).toLowerCase() === path.resolve(targetFolder).toLowerCase()) return sourcePath;
  fs.mkdirSync(targetFolder, { recursive: true });
  const fileName = path.basename(sourcePath);
  let targetPath = path.join(targetFolder, fileName);
  if (fs.existsSync(targetPath)) {
    const ext = path.extname(fileName);
    targetPath = path.join(targetFolder, `${path.basename(fileName, ext)}_${new Date().toISOString().replace(/[:.]/g, '-')}${ext}`);
  }
  try {
    fs.renameSync(sourcePath, targetPath);
  } catch (_) {
    try {
      fs.copyFileSync(sourcePath, targetPath);
      try { fs.unlinkSync(sourcePath); } catch (_) {}
    } catch (err) {
      console.warn(`⚠ تعذر نقل الملف (${fileName}): ${err.message}`);
      return sourcePath;
    }
  }
  return targetPath;
}

function fileStatDetails(filePath) {
  try { const st = fs.statSync(filePath); return { size: st.size, mtimeMs: st.mtimeMs }; } catch (_) { return {}; }
}

/** حذف ملف مع إعادة المحاولة (قد يكون مفتوحاً لحظياً من برنامج آخر) */
async function deleteFileWithRetry(filePath) {
  for (let i = 0; i < 5; i++) {
    try {
      if (!fs.existsSync(filePath)) return true;
      fs.unlinkSync(filePath);
      return true;
    } catch (_) {
      await new Promise(r => setTimeout(r, 400));
    }
  }
  return !fs.existsSync(filePath);
}

/**
 * بعد تأكيد واتساب استلام الرسالة: حذف المستند نهائياً (الافتراضي)، أو أرشفته في Sent إذا كان الحذف معطلاً.
 * @returns {Promise<string|null>} مسار النسخة المؤرشفة أو null عند الحذف
 */
async function finalizeSent(filePath, docType, details = {}) {
  if (!CONFIG.deleteAfterSend) return moveToSent(filePath, docType, details);
  const sub = (docType && docType.subfolder) ? docType.subfolder : 'فواتير';
  markFileAsProcessed(filePath, 'sent', { docType: sub, deleted: true, ...details });
  const ok = await deleteFileWithRetry(filePath);
  if (ok) console.log(`🗑 تم حذف (${path.basename(filePath)}) بعد تأكيد الإرسال.`);
  else console.warn(`⚠ تم الإرسال لكن تعذر حذف الملف (${path.basename(filePath)}) لأنه مفتوح في برنامج آخر.`);
  return null;
}

/**
 * إرسال المستند وانتظار تأكيد خوادم واتساب أنها استلمته.
 * @returns {Promise<boolean>} true = مؤكد، false = أُرسل لكن لم يصل التأكيد خلال المهلة
 */
/**
 * اسم الملف كما يظهر للعميل في واتساب: نوع المستند + رقم العميل (مثل "فاتورة 1094.pdf")
 * بدل اسم ملف الطباعة (DESKTOP-...__Print_...pdf). الملف على الجهاز لا يتغير اسمه.
 */
function customerFileName(docType, customerNumber) {
  const type = (docType && docType.name) || 'مستند';
  const num = normalizeArabicText(String(customerNumber || '')).replace(/[^0-9A-Za-z]/g, '');
  return num ? `${type} ${num}.pdf` : `${type}.pdf`;
}

async function sendDocumentConfirmed(chatId, filePath, caption, sendAsName = null) {
  const media = MessageMedia.fromFilePath(filePath);
  if (sendAsName) media.filename = sendAsName;
  const r = await client.sendMessage(chatId, media, { caption, waitForAck: true, ackTimeoutMs: 60000 });
  return !!(r && r.ack);
}

const UNCONFIRMED_REASON = 'أُرسل لكن لم يصل تأكيد استلام من واتساب خلال دقيقة — تأكد من القروب قبل إعادة الإرسال حتى لا يتكرر';
const INTERRUPTED_REASON = 'كان قيد الإرسال عندما أُغلق البرنامج — ربما وصل للقروب، تأكد من القروب قبل إعادة الإرسال حتى لا يتكرر';

/** سبب فشل الإرسال: قد تكون الرسالة خرجت فعلاً قبل الخطأ (مثل انتهاء المهلة)، فننبه قبل إعادة الإرسال */
function sendFailureReason(err) {
  return `فشل الإرسال أو لم يتأكد (${err && err.message ? err.message : err}) — تأكد من القروب قبل إعادة الإرسال`;
}

/** وضع التجربة: المستند لم يُرسل للعميل، فلا يُحذف بل يُنقل إلى مجلد Test */
function finalizeTest(filePath, docType, details = {}) {
  const sub = (docType && docType.subfolder) ? docType.subfolder : 'فواتير';
  const stat = fileStatDetails(filePath);
  const dest = safeRelocateFile(filePath, path.join(CONFIG.invoicesDir, 'Test', sub));
  markFileAsProcessed(filePath, 'test', { ...stat, docType: sub, destination: details.destination, customerNumber: details.customerNumber, testCopy: dest });
  console.log(`🧪 (${path.basename(filePath)}) أُرسل لرقم التجربة فقط، والمستند محفوظ في: Test/${sub}`);
  return dest;
}

/**
 * عند التشغيل: مستندات كانت "قيد الإرسال" عند إغلاق البرنامج => للمراجعة (لا يُعاد إرسالها تلقائياً حتى لا تتكرر)
 */
async function recoverInterruptedSends() {
  for (const [name, entry] of Object.entries(processedRegistry)) {
    if (!entry || entry.status !== 'sending') continue;
    const filePath = path.join(CONFIG.invoicesDir, name);
    const docType = Object.values(DOC_TYPES).find(d => d.subfolder === entry.docType) || DOC_TYPES.INVOICE;
    if (fs.existsSync(filePath)) {
      console.warn(`⚠ (${name}) ${INTERRUPTED_REASON}`);
      await moveToReview(filePath, INTERRUPTED_REASON, docType, entry.customerNumber || '-', entry.destination || '-');
    } else {
      entry.status = 'review';
      entry.reason = INTERRUPTED_REASON;
      try { saveProcessedRegistry(); } catch (_) {}
    }
  }
}

async function moveToReview(filePath, reason, docType, customerNumber = '-', phone = '-', reportCustomer = undefined) {
  const sub = (docType && docType.subfolder) ? docType.subfolder : 'فواتير';
  const reviewDir = path.join(CONFIG.invoicesDir, 'Review', sub);
  const stat = fileStatDetails(filePath);
  // عند تفعيل الحذف التلقائي يُنقل الملف (نسخة واحدة فقط)، وإلا يُنسخ كما في السابق
  const destination = CONFIG.deleteAfterSend ? safeRelocateFile(filePath, reviewDir) : await safeArchiveFile(filePath, reviewDir);
  markFileAsProcessed(filePath, 'review', { ...stat, reason, docType: sub, destination, customerNumber, phone, ...(reportCustomer !== undefined ? { reportCustomer } : {}) });
  console.warn(`⚠ للمراجعة: تم نقل (${path.basename(filePath)}) إلى Review/${sub}.`);
  console.warn(`   السبب: ${reason}`);
  notifier.notifyReview(path.basename(filePath), reason);
  return destination;
}

/**
 * البحث عن المسار الفعلي لأي مستند (يفضل الملف الأصلي في مجلد المراقبة ثم مجلدات الأرشيف)
 */
/** هل المسار داخل مجلد الفواتير؟ (البرنامج ما يفتح ولا يقرأ أي ملف برا مجلد الفواتير) */
function isInsideInvoicesDir(p) {
  try {
    const root = fs.realpathSync.native(path.resolve(CONFIG.invoicesDir));
    const full = fs.realpathSync.native(path.resolve(String(p)));
    const rel = path.relative(root, full);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch (_) { return false; }
}

function findDocumentPath(fileName, givenPath) {
  if (givenPath && fs.existsSync(givenPath) && isInsideInvoicesDir(givenPath) && /\.pdf$/i.test(String(givenPath))) {
    return path.resolve(givenPath);
  }
  if (!fileName) return null;
  const safeName = path.basename(fileName);
  const candidates = [
    path.join(CONFIG.invoicesDir, safeName),
    path.join(CONFIG.invoicesDir, 'Review', 'فواتير', safeName),
    path.join(CONFIG.invoicesDir, 'Review', 'فسوحات', safeName),
    path.join(CONFIG.invoicesDir, 'Review', 'مرتجعات', safeName),
    path.join(CONFIG.invoicesDir, 'Review', 'كشوفات', safeName),
    path.join(CONFIG.invoicesDir, 'Review', safeName),
    path.join(CONFIG.invoicesDir, 'Sent', 'فواتير', safeName),
    path.join(CONFIG.invoicesDir, 'Sent', 'فسوحات', safeName),
    path.join(CONFIG.invoicesDir, 'Sent', 'مرتجعات', safeName),
    path.join(CONFIG.invoicesDir, 'Sent', 'كشوفات', safeName),
    path.join(CONFIG.invoicesDir, 'Sent', safeName)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.resolve(c);
  }
  return null;
}

// ==========================================
// عميل واتساب (اتصال مباشر عبر Baileys بدون متصفح)
// ==========================================

let client = null;
let MessageMedia = null;
let isWhatsAppReady = false;
let currentQrSvg = null;
let connectedPhone = null;
let loadingPercent = null;
let isReconnecting = false;
let reconnectTimer = null;
let warnedWhatsAppDown = false; // صدر تنبيه انقطاع => عند العودة يصدر تنبيه "تم الاتصال"
let whatsAppFailed = false;     // توقفت المحاولات التلقائية (يحتاج تدخل)
let whatsAppDownSince = Date.now(); // متى بدأ عدم الاتصال (من بداية التشغيل)
let downAlertTimer = null;

const MINUTES = 60 * 1000;
// لا يصدر تنبيه "واتساب غير متصل" إلا إذا استمر الانقطاع أكثر من هذه المدة (بداية التشغيل أو انقطاع نت قصير لا يزعج)
const DOWN_ALERT_AFTER_MS = Math.max(0, Number(process.env.ALWADY_DOWN_ALERT_MS) || 2 * MINUTES);

/** واتساب أصبح غير متصل (انقطاع مؤقت أو إعادة اتصال) */
function markWhatsAppDown() {
  if (isWhatsAppReady || !whatsAppDownSince) whatsAppDownSince = Date.now();
  isWhatsAppReady = false;
}

/** تنبيه مؤجل: يصدر فقط إذا بقي واتساب غير متصل أكثر من DOWN_ALERT_AFTER_MS وفيه مستندات تنتظر */
function armWhatsAppDownAlert() {
  if (downAlertTimer || isWhatsAppReady) return;
  const wait = Math.max(0, (whatsAppDownSince || Date.now()) + DOWN_ALERT_AFTER_MS - Date.now());
  downAlertTimer = setTimeout(() => {
    downAlertTimer = null;
    if (isWhatsAppReady || queue.length === 0) return;
    notifyWhatsAppDown('waiting', `يوجد ${queue.length} مستند بانتظار الإرسال وواتساب غير متصل. افتح البرنامج وتأكد أن واتساب متصل.`);
  }, wait);
  if (downAlertTimer.unref) downAlertTimer.unref();
}

/** تنبيه ويندوز: واتساب غير متصل (لا يتكرر أكثر من مرة كل نصف ساعة لنفس السبب) */
function notifyWhatsAppDown(key, text) {
  if (notifier.notify(`wa-${key}`, { title: 'واتساب غير متصل — لن تُرسل المستندات', text, level: 'error', minIntervalMs: 30 * MINUTES })) {
    warnedWhatsAppDown = true;
  }
}

function cleanSessionAuthDirectory() {
  try {
    if (fs.existsSync(BAILEYS_AUTH_DIR)) {
      fs.rmSync(BAILEYS_AUTH_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      console.log('🧹 تم مسح جلسة واتساب القديمة لبدء جلسة جديدة (باركود جديد).');
    }
  } catch (e) {
    console.warn('تحذير أثناء مسح جلسة واتساب:', e.message);
  }
}

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// إعادة تشغيل اتصال واتساب واحدة في كل مرة (زر "ربط جهاز جديد" وإعادة الاتصال التلقائية لا يفتحان اتصالين)
let waRestartChain = Promise.resolve();
function restartWhatsAppClient(cleanSession = false) {
  waRestartChain = waRestartChain.then(async () => {
    if (client) {
      const old = client;
      client = null;
      try { await old.destroy(); } catch (_) {}
    }
    if (cleanSession) cleanSessionAuthDirectory();
    await startWhatsAppClient();
  }).catch((err) => {
    console.error('❌ تعذر إعادة تشغيل اتصال واتساب:', err && err.message ? err.message : err);
  });
  return waRestartChain;
}

function scheduleWhatsAppReconnect(delayMs = 3000, forceCleanSession = false) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  markWhatsAppDown();
  isReconnecting = true;
  connectedPhone = null;
  reconnectAttempts++;

  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    // بعد المحاولات السريعة: يستمر بالمحاولة ببطء (كل دقيقتين) حتى يرجع الاتصال لحاله بدون تدخل
    if (!whatsAppFailed) {
      console.error(`❌ تعذر الاتصال بواتساب بعد ${MAX_RECONNECT_ATTEMPTS} محاولات. سيستمر بالمحاولة كل دقيقتين.`);
      whatsAppFailed = true;
      broadcastSseEvent('wa_status', { status: 'failed', message: 'تعذر الاتصال بواتساب بعد عدة محاولات.' });
      notifyWhatsAppDown('failed', 'تعذر الاتصال بواتساب بعد عدة محاولات. تأكد من الإنترنت — البرنامج يعيد المحاولة تلقائياً كل دقيقتين.');
    }
    isReconnecting = false;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      restartWhatsAppClient(false);
    }, 2 * MINUTES);
    if (reconnectTimer.unref) reconnectTimer.unref();
    return;
  }

  const actualDelay = Math.min(delayMs * Math.ceil(reconnectAttempts / 3), 15000);
  console.log(`🔄 محاولة إعادة الاتصال رقم ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} بعد ${actualDelay / 1000} ثوانٍ...`);
  broadcastSseEvent('wa_status', { status: 'reconnecting' });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    restartWhatsAppClient(forceCleanSession);
  }, actualDelay);
}

function generateQrSvg(text) {
  try {
    const QRCode = require('qrcode-terminal/vendor/QRCode');
    const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
    const qr = new QRCode(-1, QRErrorCorrectLevel.L);
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const size = 200;
    const cellSize = size / count;
    let rects = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          const x = (c * cellSize).toFixed(2);
          const y = (r * cellSize).toFixed(2);
          const w = (cellSize + 0.1).toFixed(2);
          const h = (cellSize + 0.1).toFixed(2);
          rects += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#0f172a"/>`;
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="#ffffff" rx="8"/>${rects}</svg>`;
  } catch (e) {
    return null;
  }
}

function getWhatsAppClient() {
  if (!client) {
    const wa = require('./wa-baileys');
    MessageMedia = wa.MessageMedia;
    const self = new wa.BaileysClient({ authDir: BAILEYS_AUTH_DIR });
    client = self;
    // أحداث من اتصال قديم (بعد استبداله) تُتجاهل
    const on = (ev, fn) => self.on(ev, (...args) => { if (client === self) return fn(...args); });

    on('qr', (qr) => {
      console.log(`📌 واتساب يحتاج مسح الباركود من الجوال (يظهر في ${WHERE_QR}).`);
      currentQrSvg = generateQrSvg(qr);
      isReconnecting = false;
      whatsAppFailed = false;
      reconnectAttempts = 0;
      broadcastSseEvent('wa_status', { status: 'qr_ready', qrSvg: currentQrSvg });
      notifyWhatsAppDown('qr', `افتح ${WHERE_QR} وامسح الباركود من جوالك: واتساب ← الأجهزة المرتبطة ← ربط جهاز.`);
    });

    on('authenticated', () => {
      console.log('🔐 تم توثيق جلسة واتساب بنجاح...');
      currentQrSvg = null;
      broadcastSseEvent('wa_status', { status: 'authenticated' });
    });

    on('ready', async () => {
      console.log('🚀 واتساب متصل وجاهز للإرسال.');
      isWhatsAppReady = true;
      whatsAppDownSince = null;
      whatsAppFailed = false;
      if (downAlertTimer) { clearTimeout(downAlertTimer); downAlertTimer = null; }
      isReconnecting = false;
      loadingPercent = null;
      currentQrSvg = null;
      reconnectAttempts = 0;
      if (self.info && self.info.wid) connectedPhone = self.info.wid.user;
      broadcastSseEvent('wa_status', { status: 'connected', phone: connectedPhone || '' });

      if (warnedWhatsAppDown) {
        warnedWhatsAppDown = false;
        for (const k of ['wa-qr', 'wa-logout', 'wa-down', 'wa-waiting', 'wa-failed']) notifier.forget(k);
        notifier.notify('wa-up', { title: 'واتساب متصل من جديد ✅', text: 'رجع الإرسال يعمل تلقائياً، والمستندات المنتظرة ستُرسل الآن.', level: 'info' });
      }

      console.log('🔄 جاري تحميل قائمة قروبات واتساب...');
      await loadGroups();
      startGroupsRefreshTimer();
      processQueue();
    });

    // انقطاع مؤقت (إنترنت مثلاً): الاتصال يعود تلقائياً، والمستندات تنتظر بدل أن تُحاول الإرسال الآن
    on('reconnecting', () => {
      if (isWhatsAppReady) console.warn('⚠ انقطع اتصال واتساب مؤقتاً، جاري إعادة الاتصال تلقائياً... (المستندات تنتظر ولن تضيع)');
      markWhatsAppDown();
      isReconnecting = true;
      broadcastSseEvent('wa_status', { status: 'reconnecting' });
      if (queue.length > 0) armWhatsAppDownAlert();
    });

    on('disconnected', (reason) => {
      console.warn('⚠ تم انقطاع اتصال واتساب:', reason);
      markWhatsAppDown();
      broadcastSseEvent('wa_status', { status: 'reconnecting' });
      if (reason === 'LOGOUT') {
        console.log('🚪 تم تسجيل الخروج من الجوال، جاري مسح الجلسة وتوليد باركود جديد...');
        notifyWhatsAppDown('logout', `تم تسجيل خروج البرنامج من واتساب. افتح ${WHERE_QR} وامسح الباركود من جديد.`);
        scheduleWhatsAppReconnect(1500, true);
      } else if (reason === 'CONFLICT') {
        notifyWhatsAppDown('down', 'نفس رقم واتساب مفتوح في برنامج آخر بنفس الطريقة. أغلقه حتى يعود الإرسال.');
        scheduleWhatsAppReconnect(10000, false);
      } else {
        scheduleWhatsAppReconnect(3000, false);
      }
    });
  }
  return client;
}

async function startWhatsAppClient() {
  const waClient = getWhatsAppClient();
  try {
    await waClient.initialize();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error('❌ تعذر تشغيل اتصال واتساب:', msg);
    if (client === waClient) client = null;
    try { await waClient.destroy(); } catch (_) {}
    scheduleWhatsAppReconnect(5000);
  }
}

// ==========================================
// قائمة قروبات واتساب في الذاكرة (تُحمّل بعد ready وتُحدّث دورياً)
// ==========================================

let groupIndex = null;          // ناتج groupMatcher.buildGroupIndex
let groupsLoadedAt = null;
let groupsLoadPromise = null;
let groupsRefreshTimer = null;
const warnedInvalidGroups = new Set();
let allGroups = [];             // كل القروبات كما هي
let fullGroupIndex = null;      // كل القروبات بأرقامها (منه تُلقى قروبات المستودعات بأرقامها)

/** أرقام كل قروبات المستودعات (الفرع الرئيسي + الفروع البعيدة) */
function warehouseNumbers() {
  return [...new Set([CONFIG.warehouseNumber, ...Object.values(CONFIG.warehouseBranchNumbers || {})].filter(Boolean))];
}

function isWarehouseNumber(number) {
  const key = groupMatcher.canonicalCustomerNumber(number);
  return !!key && warehouseNumbers().includes(key);
}

/**
 * فهرس قروبات العملاء: كل القروبات ما عدا قروبات المستودعات (اللي اسمها فيه رقم مستودع)
 * — قروب المستودع ما يُطابَق كقروب عميل أبداً.
 */
function rebuildGroupIndex() {
  fullGroupIndex = groupMatcher.buildGroupIndex(allGroups, { minDigits: CONFIG.minCustomerDigits });
  const whNumbers = new Set(warehouseNumbers());
  groupIndex = groupMatcher.buildGroupIndex(allGroups, {
    minDigits: CONFIG.minCustomerDigits,
    excludeIds: fullGroupIndex.valid.filter(g => whNumbers.has(g.number)).map(g => g.id)
  });
}

/**
 * تحميل القروبات عبر client.getChats() وبناء الفهرس. عند الفشل تبقى القائمة السابقة كما هي.
 * @returns {Promise<boolean>} true عند النجاح
 */
function loadGroups() {
  if (groupsLoadPromise) return groupsLoadPromise;

  groupsLoadPromise = (async () => {
    if (!isWhatsAppReady || !client) {
      console.warn('⚠ تعذر تحميل القروبات: خدمة واتساب غير متصلة حالياً');
      return false;
    }
    try {
      const chats = await Promise.race([
        client.getChats(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('مهلة جلب المحادثات تجاوزت 60 ثانية')), 60000))
      ]);
      const groups = (chats || [])
        .filter(c => c && c.isGroup && c.id && c.id._serialized)
        .map(c => ({ id: c.id._serialized, name: c.name || '' }));

      allGroups = groups;
      rebuildGroupIndex();
      groupsLoadedAt = new Date();

      for (const g of groupIndex.invalid) {
        const key = `${g.id}|${g.name}`;
        if (warnedInvalidGroups.has(key)) continue;
        warnedInvalidGroups.add(key);
        console.warn(`⚠ قروب متجاهَل "${g.name}": ${g.reason}`);
      }

      console.log(`👥 تم تحميل (${groupIndex.valid.length + groupIndex.invalid.length}) قروب: (${groupIndex.valid.length}) صالح برقم عميل واحد، (${groupIndex.invalid.length}) متجاهَل.`);
      broadcastSseEvent('stats_update', { customersCount: groupIndex.valid.length });
      broadcastSseEvent('customers_updated', {});
      return true;
    } catch (err) {
      console.warn(`⚠ تعذر تحميل قائمة القروبات: ${err.message}`);
      return false;
    }
  })();

  groupsLoadPromise.finally(() => { groupsLoadPromise = null; });
  return groupsLoadPromise;
}

function startGroupsRefreshTimer() {
  if (groupsRefreshTimer) clearInterval(groupsRefreshTimer);
  const minutes = Math.max(1, Number(CONFIG.groupsRefreshMinutes) || 10);
  groupsRefreshTimer = setInterval(() => {
    if (isWhatsAppReady) loadGroups().catch(() => {});
  }, minutes * 60 * 1000);
  if (groupsRefreshTimer.unref) groupsRefreshTimer.unref();
}

/**
 * تحديد قروب العميل من القائمة المحفوظة، مع تحديث واحد إجباري عند عدم وجود تطابق.
 */
async function resolveCustomerGroup(customerNumber) {
  return groupMatcher.resolveWithRefresh(() => groupIndex, loadGroups, customerNumber);
}

/**
 * التأكد عبر getChatById أن القروب ما زال موجوداً وأن اسمه الحالي ما زال يطابق رقم العميل.
 */
const NOT_READY_REASON = 'واتساب غير متصل حالياً — المستند ينتظر وسيُرسل تلقائياً عند عودة الاتصال';
function isNotReadyError(err) {
  return !!(err && err.code === 'WA_NOT_READY') || !isWhatsAppReady || !client;
}

async function confirmGroupChat(group, customerNumber, { warehouse = false } = {}) {
  // احتياط إضافي: قروب المستودع داخلي ولا يُرسل له أي شيء موجَّه للعميل
  if (!warehouse && (isWarehouseNumber(customerNumber) || (group && isWarehouseNumber(group.number)))) {
    return { ok: false, reason: `الرقم [${customerNumber}] رقم قروب مستودع وليس رقم عميل — لم يتم الإرسال` };
  }
  let chat = null;
  try {
    chat = await client.getChatById(group.id);
  } catch (err) {
    // واتساب انقطع أثناء التحقق: ليس معناه أن القروب غير موجود
    if (isNotReadyError(err)) return { ok: false, notReady: true, reason: NOT_READY_REASON };
  }

  if (!chat || !chat.isGroup || !chat.id || chat.id._serialized !== group.id) {
    return { ok: false, reason: `القروب "${group.name}" ${warehouse ? `(رقم ${customerNumber})` : `للعميل [${customerNumber}]`} لم يعد موجوداً أو الحساب ليس عضواً فيه` };
  }

  const fresh = groupMatcher.buildGroupIndex([{ id: chat.id._serialized, name: chat.name || '' }], { minDigits: CONFIG.minCustomerDigits });
  const recheck = groupMatcher.findGroupForCustomer(fresh, customerNumber);
  if (recheck.status !== 'match') {
    return { ok: false, reason: `اسم القروب تغيّر إلى "${chat.name || ''}" ولم يعد فيه ${warehouse ? 'رقم المستودع' : 'رقم العميل'} [${customerNumber}]` };
  }
  return { ok: true, chat };
}

/**
 * تحويل رقم هاتف (رقم التجربة) إلى معرّف محادثة واتساب
 */
async function resolvePhoneChatId(rawPhone) {
  const normalizedPhone = normalizePhone(String(rawPhone || ''));
  if (!normalizedPhone) {
    return { ok: false, phone: rawPhone, reason: `صيغة رقم التجربة (${rawPhone}) غير صالحة` };
  }
  let chatId = null;
  try {
    const numberDetails = await Promise.race([
      client.getNumberId(normalizedPhone),
      new Promise((_, reject) => setTimeout(() => reject(new Error('مهلة فحص الرقم تجاوزت الحد')), 6000))
    ]);
    if (numberDetails && numberDetails._serialized) chatId = numberDetails._serialized;
  } catch (checkErr) {
    console.warn(`⚠ تعذر الفحص المسبق للرقم (${normalizedPhone}): ${checkErr.message}، سيتم استخدام المعرف المباشر`);
  }
  if (!chatId && normalizedPhone.length >= 9) chatId = `${normalizedPhone}@c.us`;
  if (!chatId) {
    return { ok: false, phone: normalizedPhone, reason: `رقم التجربة (${normalizedPhone}) ليس لديه حساب واتساب مفعل` };
  }
  return { ok: true, phone: normalizedPhone, chatId };
}

/**
 * تحديد وجهة الإرسال لرقم العميل:
 *  - البحث عن قروب العميل والتأكد منه (يتم دائماً حتى في وضع التجربة للتسجيل)
 *  - إذا كان رقم التجربة مفعلاً تكون الوجهة رقم التجربة
 * @returns {Promise<{ok, chatId, destLabel, groupName, groupReason, reason, isTest}>}
 */
async function planDelivery(customerNumber) {
  // رقم قروب مستودع: ما يُعامل كعميل أبداً (حتى لو انكتب في فاتورة بالغلط)
  if (isWarehouseNumber(customerNumber)) {
    const reason = `الرقم [${customerNumber}] رقم قروب مستودع وليس رقم عميل — لم يتم الإرسال`;
    return { ok: false, groupName: null, groupReason: reason, reason, destLabel: '-', isTest: false };
  }
  const resolution = await resolveCustomerGroup(customerNumber);
  let groupReason = groupMatcher.describeResolution(resolution, customerNumber);
  let groupChat = null;

  // انقطع واتساب أثناء البحث (لم تُحدَّث القائمة): لا نحكم أن القروب غير موجود، المستند ينتظر
  if (!isWhatsAppReady && resolution.status !== 'match' && resolution.status !== 'invalid_customer') {
    return { ok: false, notReady: true, reason: NOT_READY_REASON, groupReason: NOT_READY_REASON, destLabel: '-', isTest: false };
  }

  if (resolution.status === 'match') {
    const confirmed = await confirmGroupChat(resolution.group, customerNumber);
    if (confirmed.notReady) {
      return { ok: false, notReady: true, reason: NOT_READY_REASON, groupReason: NOT_READY_REASON, destLabel: '-', isTest: false };
    }
    if (confirmed.ok) groupChat = confirmed.chat;
    else groupReason = confirmed.reason;
  }
  const groupName = groupChat ? (groupChat.name || '') : null;

  // في التشغيل التجريبي لا داعي لتحويل الوجهة لرقم التجربة لأنه لن يُرسل شيء
  const testPhone = CONFIG.dryRun ? '' : String(CONFIG.testPhone || '').trim();
  if (testPhone) {
    if (groupChat) {
      console.log(`🧪 [وضع التجربة]: العميل [${customerNumber}] كان سيُرسل إلى القروب "${groupName}"، وسيُرسل بدلاً من ذلك للرقم التجريبي (${testPhone})`);
    } else {
      console.log(`🧪 [وضع التجربة]: العميل [${customerNumber}] لن يُرسل لأي قروب في الوضع الفعلي (${groupReason})، وسيُرسل للرقم التجريبي (${testPhone})`);
    }
    const phoneTarget = await resolvePhoneChatId(testPhone);
    return {
      ok: phoneTarget.ok,
      chatId: phoneTarget.chatId,
      destLabel: `رقم التجربة: ${phoneTarget.phone}`,
      groupName,
      groupReason,
      reason: phoneTarget.reason,
      isTest: true
    };
  }

  if (!groupChat) {
    return { ok: false, groupName, groupReason, reason: groupReason, destLabel: '-', isTest: false };
  }
  return {
    ok: true,
    chatId: groupChat.id._serialized,
    destLabel: `قروب: ${groupName}`,
    groupName,
    groupReason: null,
    reason: null,
    isTest: false
  };
}

function getCaptionForDocType(docType) {
  if (CONFIG.captions && CONFIG.captions[docType.id]) return CONFIG.captions[docType.id];
  return docType.defaultCaption;
}

/**
 * سجل التشغيل التجريبي (dryRun): لا إرسال ولا نقل للملف
 */
function logDryRun(fileName, customerNumber, plan) {
  if (plan.groupName && !plan.groupReason) {
    console.log(`🧪 [تشغيل تجريبي]: كان سيُرسل الملف (${fileName}) للعميل [${customerNumber}] إلى القروب "${plan.groupName}"`);
    recordOutcome(fileName, { status: 'dry_run', customerNumber, message: `كان سيُرسل للعميل [${customerNumber}] إلى القروب "${plan.groupName}" (لم يُرسل شيء)` });
  } else {
    console.log(`🧪 [تشغيل تجريبي]: لن يُرسل الملف (${fileName}) للعميل [${customerNumber}] — ${plan.groupReason} (في الوضع الفعلي سيُنقل إلى Review)`);
    recordOutcome(fileName, { status: 'dry_run', customerNumber, message: `لن يُرسل: ${plan.groupReason}` });
  }
  console.log('🧪 [تشغيل تجريبي]: لم يتم إرسال أي شيء وبقي الملف في مكانه.');
}

/**
 * سجل نجاح الإرسال: يتضمن دائماً رقم العميل واسم القروب
 */
function logSendSuccess(fileName, customerNumber, plan) {
  if (plan.isTest) {
    const target = plan.groupName ? `القروب المستهدف: "${plan.groupName}"` : `لا يوجد قروب صالح: ${plan.groupReason}`;
    console.log(`✅ ${fileName}: انرسلت للعميل [${customerNumber}] إلى ${plan.destLabel} (${target})`);
  } else {
    console.log(`✅ ${fileName}: انرسلت للعميل [${customerNumber}] ← قروب: "${plan.groupName}"`);
  }
}

/**
 * ملخص القروبات للواجهة: رقم العميل => معرّف القروب (للأرقام التي لها قروب صالح واحد فقط)
 */
function getGroupsSummary() {
  const mapping = {};
  const names = {};
  let ambiguousCount = 0;
  if (groupIndex) {
    for (const g of [...groupIndex.valid, ...groupIndex.invalid]) names[g.id] = g.name;
    for (const [number, list] of groupIndex.byNumber) {
      if (list.length === 1) mapping[number] = list[0].id;
      else ambiguousCount += list.length;
    }
  }
  return {
    loaded: !!groupIndex,
    loadedAt: groupsLoadedAt ? groupsLoadedAt.toISOString() : null,
    totalGroups: groupIndex ? groupIndex.valid.length + groupIndex.invalid.length : 0,
    readyCount: Object.keys(mapping).length,
    reviewCount: groupIndex ? groupIndex.invalid.length + ambiguousCount : 0,
    mapping,
    names
  };
}

// ==========================================
// المستودع: الفسح يذهب لقروب المستودع + موقع المستودع (وليس لقروب العميل)
// ==========================================

let warehouseSyncInstance = null;
function warehouseSync() {
  if (!warehouseSyncInstance) {
    warehouseSyncInstance = new WarehouseSync({
      outboxDir: CONFIG.warehouseOutboxDir,
      getConfig: () => ({ siteUrl: CONFIG.warehouseSiteUrl, apiKey: CONFIG.warehouseApiKey }),
      onChange: (status) => broadcastSseEvent('warehouse_status', status)
    });
  }
  return warehouseSyncInstance;
}

function isWarehouseSiteConfigured() {
  return warehouseSync().isConfigured();
}

/** هل مسار المستودع مفعّل؟ (محدد قروب مستودع أو الربط مع الموقع). غير مفعّل => الفسح على سلوكه السابق */
function isWarehouseRouteActive() {
  return warehouseNumbers().length > 0 || isWarehouseSiteConfigured();
}

/** اسم فرع الجهاز الرئيسي كما في الموقع (يوصل مع النبضة)، أو نص فاضي إذا ما وصل بعد */
function mainBranchName() {
  try { return warehouseNotifier().siteBranches().main || ''; } catch (_) { return ''; }
}

/**
 * رقم قروب مستودع الفرع: كل فرع له مستودعه.
 *  - فسح الجهاز الرئيسي (أو فرع اسمه نفس الفرع الرئيسي) => رقم مستودع الفرع الرئيسي.
 *  - فسح فرع بعيد => رقم مستودع ذاك الفرع فقط. ما يروح لقروب فرع ثاني أبداً.
 * @param {string|null} branch
 * @returns {{number: string, label: string, branch: string|null}} number فاضي = ما تحدد رقم لهذا الفرع
 */
function warehouseGroupFor(branch) {
  const b = cleanBranchName(branch);
  if (!b || b === mainBranchName()) {
    const main = mainBranchName();
    return { number: CONFIG.warehouseNumber, label: main ? `قروب مستودع فرع ${main}` : 'قروب المستودع', branch: b || null };
  }
  return { number: (CONFIG.warehouseBranchNumbers || {})[b] || '', label: `قروب مستودع فرع ${b}`, branch: b };
}

/** القروب اللي اسمه فيه رقم المستودع (من القائمة الحالية بدون تحديث) — للعرض في الإعدادات */
function findWarehouseGroupNow(number) {
  if (!number || !fullGroupIndex) return { status: 'unavailable' };
  return groupMatcher.findGroupForCustomer(fullGroupIndex, number);
}

function isTestPhoneActive() {
  return !CONFIG.dryRun && !!String(CONFIG.testPhone || '').trim();
}

/** اسم العميل من اسم قروبه (إن وُجد له قروب صالح واحد)، وإلا نص فارغ */
function customerNameFor(customerNumber) {
  if (!customerNumber || !groupIndex) return '';
  const r = groupMatcher.findGroupForCustomer(groupIndex, customerNumber);
  return r.status === 'match' ? groupMatcher.customerNameFromGroupName(r.group.name) : '';
}

/** الجهاز الذي طبع المستند: ملفات الأجهزة الفرعية اسمها "اسم-الجهاز__اسم-الملف.pdf" */
function sourceDeviceOf(fileName) {
  const m = /^(.+?)__/.exec(String(fileName || ''));
  if (!m) return CONFIG.deviceName;
  // مستندات الفروع البعيدة: "الفرع~الجهاز__..."
  const i = m[1].indexOf('~');
  return i >= 0 ? m[1].slice(i + 1) : m[1];
}

/** فرع المستند: من اسم ملفات الفروع البعيدة ("الرياض~جهاز 1__...")، وإلا null (= فرع الجهاز الرئيسي) */
function branchOf(fileName) {
  const m = /^(.+?)__/.exec(String(fileName || ''));
  if (!m) return null;
  const i = m[1].indexOf('~');
  return i > 0 ? m[1].slice(0, i) : null;
}

/**
 * بيانات الفسح المرسلة لموقع المستودع.
 * رقم الفسح ورقم أمر البيع والتاريخ لا تُستخرج حالياً (تنتظر ملفات فسح حقيقية — لا تخمين)،
 * والموقع يعرّف المستند ببصمة الملف.
 */
function buildClearanceMeta(filePath, extraction) {
  const problems = [];
  let customerNumber = '';
  if (extraction && extraction.success) customerNumber = extraction.customerNumber;
  else if (extraction && extraction.uniqueNumbers && extraction.uniqueNumbers.length > 1) problems.push('customer_number_conflict');
  else problems.push('customer_number_missing');
  const fileName = path.basename(filePath);
  return {
    doc_type: 'clearance',
    doc_no: null,
    sales_order_no: (extraction && extraction.salesOrderNo) || null,
    // عدد الأصناف ومجموع الكميات (لتقرير الموظفين: كم صنف وكم قطعة جهّز)
    items_count: extraction && extraction.items ? extraction.items.count : null,
    items_qty: extraction && extraction.items ? extraction.items.qty : null,
    customer_number: customerNumber || null,
    customer_name: customerNameFor(customerNumber) || null,
    doc_date: null,
    sent_at: new Date().toISOString(),
    source_device: sourceDeviceOf(fileName),
    branch: branchOf(fileName),
    file_name: fileName,
    meta_problems: problems
  };
}

/**
 * وضع الفسح في مجلد انتظار الرفع لموقع المستودع (محلي وسريع، وآمن عند التكرار).
 * وضع التجربة (dryRun أو رقم التجربة): لا شيء يذهب للموقع.
 * @returns {object|null} null = لم يوضع (غير مفعّل، وضع تجربة، أو تعذر النسخ)
 */
function queueClearanceForSite(filePath, extraction) {
  if (CONFIG.dryRun || isTestPhoneActive() || !isWarehouseSiteConfigured()) return null;
  try {
    const r = warehouseSync().queueForWarehouse(filePath, buildClearanceMeta(filePath, extraction));
    if (r.queued) console.log(`🏬 ${path.basename(filePath)}: وُضع الفسح في انتظار الرفع لموقع المستودع.`);
    return r;
  } catch (err) {
    console.warn(`⚠ تعذر تجهيز الفسح (${path.basename(filePath)}) للرفع لموقع المستودع: ${err.message}`);
    return null;
  }
}

/**
 * إيجاد قروب المستودع برقمه (نفس قواعد قروبات العملاء الصارمة): قروب واحد اسمه فيه الرقم => إرسال،
 * صفر أو أكثر من قروب => لا إرسال. ثم التأكد أن القروب ما زال موجوداً واسمه ما زال فيه الرقم.
 * @returns {Promise<{ok: boolean, chatId?: string, name?: string, notReady?: boolean, reason?: string}>}
 */
async function confirmWarehouseGroup(number, label = 'قروب المستودع') {
  if (!isWhatsAppReady || !client) return { ok: false, notReady: true, reason: NOT_READY_REASON };
  const resolution = await groupMatcher.resolveWithRefresh(() => fullGroupIndex, loadGroups, number);
  if (!isWhatsAppReady && resolution.status !== 'match') return { ok: false, notReady: true, reason: NOT_READY_REASON };
  if (resolution.status === 'ambiguous') {
    return { ok: false, reason: `فيه أكثر من قروب اسمه فيه رقم ${label} [${number}]: ${resolution.groups.map(g => `"${g.name}"`).join('، ')} — لازم يكون الرقم في قروب واحد بس` };
  }
  if (resolution.status !== 'match') {
    return { ok: false, reason: `ما فيه قروب واتساب اسمه فيه رقم ${label} [${number}] — أنشئ القروب واكتب الرقم في اسمه (مثل "مستودع 95123698")` };
  }
  const confirmed = await confirmGroupChat(resolution.group, number, { warehouse: true });
  if (confirmed.notReady) return { ok: false, notReady: true, reason: NOT_READY_REASON };
  if (!confirmed.ok) return { ok: false, reason: `${label}: ${confirmed.reason}` };
  return { ok: true, chatId: confirmed.chat.id._serialized, name: confirmed.chat.name || '' };
}

/** نص الرسالة المرافقة للفسح في قروب المستودع (قروب داخلي) */
function warehouseCaption(customerNumber, customerName, branch = null, salesOrderNo = '') {
  const lines = ['فسح جديد للتجهيز'];
  if (customerNumber) lines.push(`العميل: ${customerName ? `${customerName} — ` : ''}${customerNumber}`);
  else lines.push('⚠ رقم العميل غير واضح في المستند');
  if (salesOrderNo) lines.push(`رقم أمر الشراء: ${salesOrderNo}`);
  if (branch) lines.push(`الفرع: ${branch}`);
  return lines.join('\n');
}

const SITE_QUEUE_FAILED_REASON = 'تعذر تجهيز الفسح للرفع لموقع المستودع (تأكد من مساحة القرص)';

/**
 * مسار الفسح: موقع المستودع (مجلد الانتظار) ثم قروب المستودع.
 *  - لا يذهب لقروب العميل أبداً، ولا يحتاج رقم عميل مقروءاً (النقدي والناقص يذهبان للمستودع أيضاً).
 *  - يوضع للرفع للموقع قبل واتساب، فلا يتأثر بانقطاع واتساب ولا بحذف الملف بعد الإرسال.
 * @param {{interactive?: boolean}} opts interactive = من زر إعادة الإرسال (الملف في مكانه، لا يُنقل قبل محاولة الإرسال)
 * @returns {Promise<{outcome: 'sent'|'test'|'site_only'|'unconfirmed'|'requeue'|'dry'|'review', reason?: string, sentPath?: string}>}
 */
async function deliverClearanceToWarehouse(filePath, docType, pdfData, opts = {}) {
  const fileName = path.basename(filePath);
  const extraction = extractClearanceData(pdfData.text || '', pdfData.layoutItems);
  const customerNumber = extraction.success ? extraction.customerNumber : '';
  const custDisplay = customerNumber || (extraction.uniqueNumbers || []).join(', ') || '-';
  const logBase = { fileName, docTypeLabel: docType.label, docTypeClass: docType.class, customerNumber: custDisplay };
  const siteOn = isWarehouseSiteConfigured();
  // كل فرع له مستودعه: فسح الفرع يروح لقروب مستودع فرعه هو
  const wh = warehouseGroupFor(branchOf(fileName));

  const review = async (reason, dest, { beforeSend = false } = {}) => {
    console.warn(`⚠ للمراجعة: ${reason}`);
    if (opts.interactive && beforeSend) return { outcome: 'review', reason };
    const destPath = await moveToReview(filePath, reason, docType, custDisplay, dest, customerNumber);
    addActivityLog({ ...logBase, filePath: destPath, phone: dest, status: 'review', reason });
    return { outcome: 'review', reason };
  };

  if (CONFIG.dryRun) {
    const targets = [wh.number ? `${wh.label} [${wh.number}]` : null, siteOn ? 'موقع المستودع' : null].filter(Boolean).join(' + ') || `لا شيء (رقم ${wh.label} غير محدد)`;
    const message = `كان سيذهب الفسح إلى ${targets} (لم يُرسل شيء)`;
    console.log(`🧪 [تشغيل تجريبي]: ${fileName} — ${message}`);
    recordOutcome(fileName, { status: 'dry_run', customerNumber: custDisplay, message });
    return { outcome: 'dry', reason: `تشغيل تجريبي: ${message}` };
  }

  let chatId = null;
  let destLabel = 'موقع المستودع';
  let isTest = false;
  let siteQueueFailed = false;

  if (isTestPhoneActive()) {
    // وضع التجربة: يُرسل لرقم التجربة فقط، ولا شيء يذهب للموقع ولا لقروب المستودع
    if (!isWhatsAppReady || !client) return { outcome: 'requeue', reason: NOT_READY_REASON };
    const target = await resolvePhoneChatId(CONFIG.testPhone);
    if (!target.ok) return review(target.reason, `رقم التجربة: ${target.phone}`, { beforeSend: true });
    console.log(`🧪 [وضع التجربة]: الفسح (${fileName}) كان سيذهب للمستودع، وسيُرسل بدلاً من ذلك للرقم التجريبي (${target.phone}) ولن يُرفع للموقع`);
    chatId = target.chatId;
    destLabel = `رقم التجربة: ${target.phone}`;
    isTest = true;
  } else {
    if (siteOn && !queueClearanceForSite(filePath, extraction)) siteQueueFailed = true;
    if (wh.number) {
      const group = await confirmWarehouseGroup(wh.number, wh.label);
      if (group.notReady) return { outcome: 'requeue', reason: NOT_READY_REASON };
      if (!group.ok) return review(group.reason, wh.label, { beforeSend: true });
      chatId = group.chatId;
      destLabel = `${wh.label}: ${group.name}`;
    }
  }

  // الموقع فقط (ما تحدد قروب مستودع لفرع هذا الفسح): لا شيء يُرسل عبر واتساب
  if (!chatId) {
    // لا قروب ولا موقع: ما نقدر نوصله لأي مستودع => مراجعة (ما يروح لقروب فرع ثاني)
    if (!siteOn) return review(`رقم ${wh.label} غير محدد في الإعدادات — اكتبه في الإعدادات ثم أعد الإرسال`, wh.label, { beforeSend: true });
    if (siteQueueFailed) return review(SITE_QUEUE_FAILED_REASON, destLabel, { beforeSend: true });
    const sentPath = await finalizeSent(filePath, docType, { customerNumber: custDisplay, destination: destLabel, reportCustomer: customerNumber });
    console.log(`🏬 ${fileName}: الفسح في طريقه لموقع المستودع (رقم ${wh.label} غير محدد في الإعدادات، فلم يُرسل عبر واتساب).`);
    addActivityLog({ ...logBase, filePath: sentPath || '', phone: destLabel, status: 'sent', reason: `وُضع للرفع لموقع المستودع — لم يُرسل عبر واتساب لأن رقم ${wh.label} غير محدد في الإعدادات` });
    return { outcome: 'site_only', sentPath };
  }

  // علامة "قيد الإرسال": إذا أُغلق البرنامج الآن لا يُعاد إرسال المستند تلقائياً بل يُنقل للمراجعة عند التشغيل
  markFileAsProcessed(filePath, 'sending', { customerNumber: custDisplay, destination: destLabel, docType: docType.subfolder, reportCustomer: customerNumber });
  let confirmed = false;
  try {
    console.log(`📤 جاري إرسال ${docType.label} إلى ${destLabel}...`);
    confirmed = await sendDocumentConfirmed(chatId, filePath, warehouseCaption(customerNumber, customerNameFor(customerNumber), branchOf(fileName), extraction.salesOrderNo), customerFileName(docType, customerNumber));
    console.log(`✅ ${fileName}: انرسل الفسح إلى ${destLabel}`);
  } catch (sendErr) {
    if (sendErr && sendErr.code === 'WA_NOT_READY') {
      // انقطع واتساب قبل خروج الرسالة: لم يُرسل شيء، فيرجع للانتظار بأمان
      unmarkSending(filePath);
      return { outcome: 'requeue', reason: NOT_READY_REASON };
    }
    console.error(`❌ فشل إرسال الفسح عبر واتساب: ${sendErr.message}`);
    return review(sendFailureReason(sendErr), destLabel);
  }

  // لم يصل تأكيد من واتساب: لا نحذف شيئاً، ونضعه في المراجعة للتأكد يدوياً
  if (!confirmed) {
    await review(UNCONFIRMED_REASON, destLabel);
    return { outcome: 'unconfirmed', reason: UNCONFIRMED_REASON };
  }

  if (isTest) {
    const testPath = finalizeTest(filePath, docType, { customerNumber: custDisplay, destination: destLabel });
    addActivityLog({ ...logBase, filePath: testPath, phone: destLabel, status: 'sent', reason: 'أُرسل لرقم التجربة فقط (لم يُرسل للمستودع) — المستند محفوظ في مجلد Test' });
    return { outcome: 'test', sentPath: testPath };
  }

  // أُرسل للقروب لكن نسخة الموقع لم تُجهَّز: لا يُحذف الملف حتى لا يضيع على الموقع
  if (siteQueueFailed) {
    const reason = `أُرسل إلى ${destLabel} لكن ${SITE_QUEUE_FAILED_REASON} — تأكد قبل إعادة الإرسال حتى لا يتكرر في القروب`;
    await review(reason, destLabel);
    return { outcome: 'unconfirmed', reason };
  }

  let sentPath = null;
  try {
    sentPath = await finalizeSent(filePath, docType, { customerNumber: custDisplay, destination: destLabel, reportCustomer: customerNumber });
  } catch (moveErr) {
    console.error(`❌ تعذر إنهاء الملف بعد الإرسال: ${moveErr.message}`);
  }
  addActivityLog({
    ...logBase,
    filePath: sentPath || '',
    phone: destLabel,
    status: 'sent',
    reason: `تم الإرسال إلى ${destLabel}${siteOn ? ' ووُضع للرفع لموقع المستودع' : ''}${sentPath ? '' : '، وحُذف الملف'}`
  });
  return { outcome: 'sent', sentPath };
}

// ==========================================
// رسائل العميل من موقع المستودع (المرحلة 3)
// ==========================================

let warehouseNotifierInstance = null;
function warehouseNotifier() {
  if (!warehouseNotifierInstance) {
    warehouseNotifierInstance = new WarehouseNotifier({
      stateFile: path.join(CONFIG.warehouseOutboxDir, 'notify-state.json'),
      getConfig: () => ({ siteUrl: CONFIG.warehouseSiteUrl, apiKey: CONFIG.warehouseApiKey }),
      isWhatsAppReady: () => isWhatsAppReady && !!client,
      hasQueuedMessages: () => messageQueue.length > 0,
      enqueueMessage: enqueueCustomerMessage,
      getOutboxPending: () => warehouseSync().pendingCount(),
      getReportSnapshot: customerReportSnapshot,
      onCustomersImport: importCustomersFromSite,
      getEngineState: remoteEngineState,
      runCommand: runRemoteCommand,
      onRelayHint: () => { siteRelayInbox().tick().catch(() => {}); }
    });
  }
  return warehouseNotifierInstance;
}

/**
 * بيانات تقرير العملاء للموقع على الإنترنت (صفحة "تقارير الفواتير"):
 * قائمة العملاء + سجل المستندات + قروب كل عميل (الاسم بس، بدون أرقام جوالات).
 */
function customerReportSnapshot() {
  const store = customerReports();
  if (store.loadError && !store.activityWritable) return null;
  const customers = Array.isArray(store.customers && store.customers.customers) ? store.customers.customers : [];
  const records = Array.isArray(store.activity && store.activity.records) ? store.activity.records : [];
  const groups = {};
  if (groupIndex) {
    const numbers = new Set([...customers.map(c => c.number), ...records.map(r => r.customer)]);
    for (const n of numbers) {
      const g = groupMatcher.findGroupForCustomer(groupIndex, n);
      if (g.status === 'match') groupStripKeys(groups, n, g.group.name);
    }
  }
  return {
    importedAt: store.customers.importedAt || null,
    customers: customers.map(c => ({ number: c.number, repCode: c.repCode || '', repName: c.repName || '' })),
    records: records.map(r => ({ customer: r.customer, type: r.type, status: r.status, reason: r.reason || '', group: r.group || '', device: r.device || '', file: r.file || '', at: r.at, sentAt: r.sentAt || null })),
    groupsLoaded: !!groupIndex,
    groups
  };
}
function groupStripKeys(groups, number, name) { groups[groupMatcher.stripLeadingZeros(String(number))] = name; }

/**
 * تحديث قائمة العملاء من ملف (PDF أو CSV من نظام المحاسبة) — من لوحة البرنامج أو من الموقع على الإنترنت.
 * @returns {Promise<number>} عدد العملاء. يرمي خطأ فيه needsConfirm لو القائمة الجديدة أصغر بكثير من الحالية
 */
async function importCustomerListFile(buf, name, { force = false } = {}) {
  const list = await readCustomerListFile(buf);
  const count = customerReports().importCustomers(list, name, { force });
  console.log(`📋 تم تحديث قائمة العملاء: ${count} عميل (${name})`);
  return count;
}

// ==========================================
// صفحات "واتساب والإرسال" في الموقع على الإنترنت
// البرنامج يقرأ حالته من لوحته المحلية (127.0.0.1) ويرسلها للموقع، وينفذ أوامر الإدارة عليها.
// ==========================================

function localApiBase() { return `http://127.0.0.1:${CONFIG.port}`; }

async function localApi(method, pathname, body, timeoutMs = 15000) {
  const res = await fetch(localApiBase() + pathname, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

/** حالة البرنامج للموقع (بدون أي مفتاح أو عنوان داخلي) */
async function remoteEngineState() {
  const [st, logs, cash, settings, warehouse] = await Promise.all([
    localApi('GET', '/api/status'), localApi('GET', '/api/logs'), localApi('GET', '/api/cash-pending'), localApi('GET', '/api/settings'), localApi('GET', '/api/warehouse')
  ]);
  const s = st.json || {};
  const set = settings.json || {};
  const wh = { ...(warehouse.json || {}) };
  delete wh.siteUrl; delete wh.apiKey; delete wh.apiKeySet;
  return {
    status: { ...s, qrSvg: s.status === 'qr_ready' ? (s.qrSvg || null) : null },
    logs: Array.isArray(logs.json) ? logs.json.slice(0, 200) : [],
    cash: (cash.json && Array.isArray(cash.json.items)) ? cash.json.items : [],
    settings: { delayMs: set.delayMs, testPhone: set.testPhone || '', captions: set.captions || {}, defaultCaptions: set.defaultCaptions || {}, sendDocTypes: set.sendDocTypes || {} },
    warehouse: wh
  };
}

// أوامر الموقع المسموحة بس (نفس أزرار صفحة واتساب في الموقع المحلي)
const REMOTE_COMMANDS = {
  'POST /api/reset-whatsapp': 30000,
  'POST /api/retry-document': 120000,
  'POST /api/send-stopped': 120000,
  'POST /api/dismiss-log': 15000,
  'POST /api/cash-done': 15000,
  'POST /api/settings': 15000,
  'GET /api/document-data': 30000
};

async function runRemoteCommand(c) {
  const method = String(c.method || '').toUpperCase();
  const p = String(c.path || '');
  if (method === 'POST' && p === '/__restart') {
    // إعادة تشغيل البرنامج: يطلع، والمشغّل يرجّعه بعد ثواني
    console.log('🔄 إعادة تشغيل البرنامج بطلب من الموقع...');
    setTimeout(() => process.exit(0), 3000);
    return { status: 200, json: { success: true } };
  }
  const pathOnly = p.split('?')[0];
  const timeout = REMOTE_COMMANDS[`${method} ${pathOnly}`];
  if (!timeout) return { status: 403, json: { success: false, message: 'أمر غير مسموح' } };
  return localApi(method, p, method === 'POST' ? (c.body || {}) : undefined, timeout);
}

/** قراءة ملف قائمة العملاء (PDF أو CSV) بدون حفظ */
async function readCustomerListFile(buf) {
  let list;
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') {
    const d = await parsePdf(buf);
    list = parseCustomerListFromItems(d.layoutItems, normalizeArabicText);
  } else {
    list = parseCustomerListFromCsv(buf.toString('utf8'));
  }
  if (!list.length) throw new Error('ما لقيت أرقام عملاء في الملف (لازم يكون فيه عمود customer_no)');
  return list;
}

/**
 * قائمة العملاء من الموقع على الإنترنت (تجي مع النبضة) — على خطوتين عشان الإدارة توافق قبل أي تغيير:
 *  parse: نقرأ الملف بس ونرجّع القائمة للموقع (الموقع يعرض التعديلات للإدارة)
 *  apply: الإدارة وافقت => نحفظ نفس القائمة اللي شافتها
 */
async function importCustomersFromSite(buf, job) {
  try {
    if (job.mode === 'apply') {
      const data = JSON.parse(buf.toString('utf8'));
      const count = customerReports().importCustomers(Array.isArray(data.customers) ? data.customers : [], job.name || 'من الموقع', { force: true });
      console.log(`📋 تم تحديث قائمة العملاء من الموقع: ${count} عميل (${job.name || ''})`);
      return { ok: true, count };
    }
    const list = await readCustomerListFile(buf);
    return { ok: true, customers: list.map(c => ({ number: String(c.number), repCode: String(c.repCode || ''), repName: String(c.repName || '') })) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/**
 * إرسال رسالة عميل جاية من الموقع، ثم تبليغ الموقع بالنتيجة.
 *  - قروب العميل يُحدَّد برقمه بنفس قواعد المطابقة الصارمة (planDelivery)، ونفس وضع التجربة ورقم التجربة.
 *  - العميل النقدي، أو بدون رقم: ما تنرسل.
 * @returns {Promise<true|false|'requeue'>} true = خرجت رسالة واتساب، REQUEUE = واتساب انقطع (ما خرج شيء)
 */
async function deliverCustomerMessage(n) {
  const notifier = warehouseNotifier();
  const who = `رسالة للعميل [${n.customer_number || '-'}]`;
  const ageMin = (Date.now() - Date.parse(n.created_at)) / 60000;
  if (n.max_age_minutes && Number.isFinite(ageMin) && ageMin > n.max_age_minutes) {
    await notifier.ack(n.id, 'expired', `ما أُرسلت خلال ${n.max_age_minutes} دقيقة فانلغت`);
    return false;
  }
  if (notifier.wasSent(n.id)) {
    await notifier.ack(n.id, 'sent', 'أُرسلت من قبل');
    return false;
  }
  // نسخة ثانية من رسالة بدأ إرسالها قبل (مثلاً انسحبت مرة ثانية وهي تنتظر تأكيد واتساب): ما تنعاد
  if (notifier.wasAttempted(n.id)) {
    await notifier.ack(n.id, 'failed', ATTEMPTED_REASON);
    return false;
  }

  let chatId = null;
  let destLabel = '';
  if (n.target === 'customer_group') {
    if (!n.customer_number) { await notifier.ack(n.id, 'skipped', 'بدون رقم عميل'); return false; }
    if (isCashCustomer(n.customer_number)) { await notifier.ack(n.id, 'skipped', 'عميل نقدي — ما له قروب'); return false; }
    const plan = await planDelivery(n.customer_number);
    if (plan.notReady) return REQUEUE;
    if (CONFIG.dryRun) {
      const would = plan.groupName && !plan.groupReason ? `كان سيُرسل إلى القروب "${plan.groupName}"` : `ما كان سيُرسل: ${plan.groupReason}`;
      console.log(`🧪 [تشغيل تجريبي]: ${who}: ${would} (لم يُرسل شيء)`);
      await notifier.ack(n.id, 'skipped', `تشغيل تجريبي: ${would}`);
      return false;
    }
    if (!plan.ok) {
      console.warn(`⚠ ${who} ما أُرسلت: ${plan.reason}`);
      await notifier.ack(n.id, 'failed', plan.reason);
      return false;
    }
    chatId = plan.chatId;
    destLabel = plan.destLabel;
  } else if (n.target === 'warehouse_group') {
    if (CONFIG.dryRun) { await notifier.ack(n.id, 'skipped', 'تشغيل تجريبي (لم يُرسل شيء)'); return false; }
    const wh = warehouseGroupFor(n.branch || null);
    if (!wh.number) { await notifier.ack(n.id, 'skipped', `رقم ${wh.label} غير محدد في البرنامج`); return false; }
    const group = await confirmWarehouseGroup(wh.number, wh.label);
    if (group.notReady) return REQUEUE;
    if (!group.ok) { await notifier.ack(n.id, 'failed', group.reason); return false; }
    chatId = group.chatId;
    destLabel = `${wh.label}: ${group.name}`;
  } else {
    await notifier.ack(n.id, 'skipped', 'وجهة غير معروفة');
    return false;
  }

  // المرفقات (سند التسليم): تنحمّل كلها قبل أي إرسال — لو تعذر التحميل ما يطلع شي ونعيد المحاولة بعدين
  const files = [];
  for (const att of (Array.isArray(n.attachments) ? n.attachments : []).slice(0, 10)) {
    const f = await notifier.fetchAttachment(n.id, att);
    if (!f.ok) {
      if (f.gone) { await notifier.ack(n.id, 'failed', f.reason); return false; }
      console.warn(`⚠ ${who}: ${f.reason} — تنعاد المحاولة`);
      return REQUEUE;
    }
    const ext = f.mime === 'application/pdf' ? 'pdf' : (f.mime.split('/')[1] || 'jpg');
    files.push(MessageMedia.fromBuffer(f.data, f.mime, `سند التسليم ${files.length + 1}.${ext}`));
  }

  try {
    notifier.markAttempt(n.id);
  } catch (err) {
    console.error(`❌ ${who}: تعذر حفظ حالة الإرسال (${err.message}) — ما أُرسلت عشان ما تتكرر`);
    return REQUEUE;
  }
  try {
    let confirmed;
    if (files.length) {
      // أول مرفق ومعه نص الرسالة، والباقي وراه بدون نص
      confirmed = true;
      for (let i = 0; i < files.length; i++) {
        const caption = i === 0 ? String(n.text || '') : '';
        const r = await client.sendMessage(chatId, files[i], { caption: caption || undefined, waitForAck: true, ackTimeoutMs: 60000 });
        if (!(r && r.ack)) confirmed = false;
      }
    } else {
      const r = await client.sendMessage(chatId, String(n.text || ''), { waitForAck: true, ackTimeoutMs: 60000 });
      confirmed = !!(r && r.ack);
    }
    console.log(`${confirmed ? '💬' : '⚠'} ${who} ${confirmed ? 'أُرسلت إلى' : 'خرجت بدون تأكيد إلى'} ${destLabel}`);
    await notifier.ack(n.id, confirmed ? 'sent' : 'failed', confirmed ? destLabel : `خرجت لكن ما وصل تأكيد من واتساب (${destLabel})`);
    return true;
  } catch (err) {
    if (err && err.code === 'WA_NOT_READY') { notifier.clearAttempt(n.id); return REQUEUE; }
    console.error(`❌ ${who} فشلت: ${err.message}`);
    await notifier.ack(n.id, 'failed', `فشل الإرسال: ${err.message}`);
    return true;
  }
}

// ==========================================
// مستندات الفروع البعيدة (عن طريق موقع المستودع)
// ==========================================

let siteRelayInboxInstance = null;
function siteRelayInbox() {
  if (!siteRelayInboxInstance) {
    siteRelayInboxInstance = new SiteRelayInbox({
      inboxDir: CONFIG.invoicesDir,
      stateFile: path.join(CONFIG.warehouseOutboxDir, 'relay-inbox-state.json'),
      getConfig: () => ({ siteUrl: CONFIG.warehouseSiteUrl, apiKey: CONFIG.warehouseApiKey }),
      getOutcome,
      alreadyHandled: (fileName) => !!processedRegistry[fileName] || !!fileOutcomes.get(fileName),
      shouldPull: () => warehouseNotifier().shouldPoll('relay')
    });
  }
  return siteRelayInboxInstance;
}

/**
 * حالة رقم قروب مستودع للعرض: القروب اللي اسمه فيه الرقم، أو سبب واضح لو ما لقيناه.
 * @returns {{number: string, groupName: string, problem: string}}
 */
function describeWarehouseNumber(number) {
  if (!number) return { number: '', groupName: '', problem: '' };
  const r = findWarehouseGroupNow(number);
  if (r.status === 'match') return { number, groupName: r.group.name, problem: '' };
  if (r.status === 'unavailable') return { number, groupName: '', problem: 'قائمة القروبات تظهر بعد اتصال واتساب' };
  if (r.status === 'ambiguous') return { number, groupName: '', problem: `الرقم موجود في أكثر من قروب: ${r.groups.map(g => `"${g.name}"`).join('، ')}` };
  return { number, groupName: '', problem: 'ما فيه قروب اسمه فيه هذا الرقم' };
}

/** ملخص المستودع للواجهة (بدون مفتاح الربط) */
function getWarehouseSummary() {
  // الفروع البعيدة: أسماؤها من الموقع + أي فرع محفوظ له رقم
  const site = warehouseNotifier().siteBranches();
  const remote = [...new Set([...site.names, ...Object.keys(CONFIG.warehouseBranchNumbers || {})])].filter(b => b && b !== site.main);
  return {
    active: isWarehouseRouteActive(),
    mainBranch: site.main,
    main: describeWarehouseNumber(CONFIG.warehouseNumber),
    branchNumbers: remote.map(b => ({ branch: b, ...describeWarehouseNumber((CONFIG.warehouseBranchNumbers || {})[b] || '') })),
    groupsLoaded: !!fullGroupIndex,
    apiKeySet: !!CONFIG.warehouseApiKey,
    sync: warehouseSync().status(),
    notify: { ...warehouseNotifier().status(), queued: messageQueue.length },
    branches: siteRelayInbox().status()
  };
}

/**
 * حفظ إعدادات المستودع من الواجهة. يرمي خطأ بنص عربي إذا كانت القيمة غير صحيحة (ولا يُحفظ شيء منها).
 * @param {{number?: string, branchNumbers?: Object<string,string>, siteUrl?: string, apiKey?: string, clearApiKey?: boolean}} w
 *   number/branchNumbers: رقم قروب المستودع (الفاضي يشيله). apiKey الفارغ = لا تغيير
 */
function applyWarehouseSettings(w) {
  const next = { number: CONFIG.warehouseNumber, branchNumbers: { ...(CONFIG.warehouseBranchNumbers || {}) }, siteUrl: CONFIG.warehouseSiteUrl, apiKey: CONFIG.warehouseApiKey };
  const checkNumber = (raw, label) => {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return '';
    const num = cleanWarehouseNumber(text);
    if (!num) throw new Error(`رقم ${label} لازم يكون أرقام بس (مثل 95123698)`);
    if (num.length < CONFIG.minCustomerDigits) throw new Error(`رقم ${label} قصير — لازم ${CONFIG.minCustomerDigits} خانات أو أكثر`);
    if (CONFIG.cashCustomerNumbers.some(n => groupMatcher.canonicalCustomerNumber(n) === num)) throw new Error(`رقم ${label} هو رقم العميل النقدي — اختر رقم ثاني`);
    return num;
  };

  if (w.number !== undefined) next.number = checkNumber(w.number, 'قروب المستودع');
  // رقم لكل فرع: {"الرياض": "95123699"} — القيمة الفاضية تشيل رقم الفرع
  if (w.branchNumbers && typeof w.branchNumbers === 'object' && !Array.isArray(w.branchNumbers)) {
    for (const [rawName, rawNum] of Object.entries(w.branchNumbers)) {
      const name = cleanBranchName(rawName);
      if (!name) continue;
      const num = checkNumber(rawNum, `قروب مستودع فرع ${name}`);
      if (num) next.branchNumbers[name] = num; else delete next.branchNumbers[name];
    }
  }
  // نفس الرقم لمستودعين يخلط الطلبات بين المستودعات
  const used = [next.number, ...Object.values(next.branchNumbers)].filter(Boolean);
  if (new Set(used).size !== used.length) throw new Error('نفس الرقم مكتوب لأكثر من مستودع — كل فرع له رقم قروب خاص فيه');
  if (typeof w.siteUrl === 'string') {
    const raw = w.siteUrl.trim();
    if (raw) {
      const v = validateSiteUrl(raw);
      if (!v.ok) throw new Error(v.reason);
      next.siteUrl = v.url;
    } else {
      next.siteUrl = '';
    }
  }
  if (typeof w.apiKey === 'string' && w.apiKey.trim()) next.apiKey = w.apiKey.trim();
  if (w.clearApiKey === true) next.apiKey = '';

  const numbersChanged = next.number !== CONFIG.warehouseNumber || JSON.stringify(next.branchNumbers) !== JSON.stringify(CONFIG.warehouseBranchNumbers || {});
  CONFIG.warehouseNumber = currentSettings.warehouseNumber = next.number;
  CONFIG.warehouseBranchNumbers = currentSettings.warehouseBranchNumbers = next.branchNumbers;
  CONFIG.warehouseSiteUrl = next.siteUrl;
  CONFIG.warehouseApiKey = next.apiKey;
  // على السيرفر الرابط والمفتاح يجون من الموقع وقت التشغيل: ما ينحفظون في ملف الإعدادات
  if (!HOSTED) {
    currentSettings.warehouseSiteUrl = next.siteUrl;
    currentSettings.warehouseApiKey = next.apiKey;
  }
  // الإعداد القديم (اختيار القروب من القائمة) انلغى
  delete currentSettings.warehouseGroupId;
  delete currentSettings.warehouseBranchGroups;

  // قروبات المستودعات تطلع من قروبات العملاء فوراً (والقروب السابق يرجع لها)
  if (numbersChanged && groupIndex) {
    rebuildGroupIndex();
    broadcastSseEvent('stats_update', { customersCount: groupIndex.valid.length });
    broadcastSseEvent('customers_updated', {});
  }
  const show = (num) => { const d = describeWarehouseNumber(num); return d.groupName ? `[${num}] "${d.groupName}"` : `[${num}]`; };
  const branchText = Object.entries(next.branchNumbers).map(([b, num]) => `فرع ${b}: ${show(num)}`).join('، ');
  console.log(`⚙ المستودع: القروب ${next.number ? show(next.number) : 'غير محدد'}${branchText ? ` — ${branchText}` : ''}، الموقع ${next.siteUrl || 'غير محدد'}، مفتاح الربط ${next.apiKey ? 'محفوظ' : 'غير محدد'}`);
  // محاولة رفع فورية بالإعدادات الجديدة لما ينتظر في المجلد
  warehouseSync().kick();
}
// مستندات في الطابور فُحصت أثناء انقطاع واتساب (حتى لا يُعاد فحصها كل مرة)
const offlineCheckedFiles = new Set();
let offlineCheckRunning = false;

/**
 * واتساب مقطوع: الفسوحات المنتظرة في الطابور تُرفع لموقع المستودع الآن ولا تنتظر عودة واتساب.
 * (إرسالها لقروب المستودع يتم لاحقاً من الطابور عند عودة الاتصال، والرفع لا يتكرر.)
 */
async function queueWaitingClearancesForSite() {
  if (offlineCheckRunning || CONFIG.dryRun || isTestPhoneActive() || !isWarehouseSiteConfigured()) return;
  offlineCheckRunning = true;
  try {
    if (offlineCheckedFiles.size > 5000) offlineCheckedFiles.clear();
    for (const filePath of [...queue]) {
      if (isWhatsAppReady) break; // رجع واتساب: الطابور يكمل المسار المعتاد
      if (offlineCheckedFiles.has(filePath)) continue;
      offlineCheckedFiles.add(filePath);
      try {
        if (!fs.existsSync(filePath) || isFileAlreadyProcessed(filePath)) continue;
        await waitForFileReady(filePath, 2000);
        const pdfData = await parsePdf(fs.readFileSync(filePath));
        const rawText = (pdfData && pdfData.text) || '';
        if (detectDocumentType(rawText, pdfData.layoutItems).id !== 'clearance') continue;
        queueClearanceForSite(filePath, extractClearanceData(rawText, pdfData.layoutItems));
      } catch (err) {
        // يُفحص من جديد في المسار المعتاد عند عودة واتساب
        console.warn(`⚠ تعذر فحص (${path.basename(filePath)}) أثناء انقطاع واتساب: ${err.message}`);
      }
    }
  } finally {
    offlineCheckRunning = false;
  }
}

// ==========================================
// طابور المعالجة (Queue)
// ==========================================

const queue = [];
// رسائل العملاء من موقع المستودع: تمشي على نفس المهلة، والمستندات لها الأولوية دائماً
const messageQueue = [];
let isProcessingQueue = false;
let lastSentAt = 0; // وقت آخر مستند أُرسل لواتساب (لتطبيق مهلة التأخير)

function enqueueCustomerMessage(n) {
  if (!n || messageQueue.some(m => m.id === n.id)) return;
  messageQueue.push(n);
  processQueue();
}

// المستندات قيد الإرسال الآن (من الطابور أو من زر إعادة الإرسال) — بالاسم، لمنع إرسال نفس المستند مرتين في نفس الوقت
const inFlight = new Set();

function enqueue(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (queue.includes(resolvedPath) || inFlight.has(path.basename(resolvedPath))) {
    return;
  }
  console.log(`📥 تم رصد ملف جديد: ${path.basename(resolvedPath)} (أضيف لقائمة الانتظار)`);
  queue.push(resolvedPath);
  processQueue();
}

async function processQueue() {
  if (isProcessingQueue) return;

  if (!isWhatsAppReady) {
    if (queue.length > 0) {
      console.log('⏳ في انتظار اكتمال ربط واتساب لبدء إرسال الملفات...');
      armWhatsAppDownAlert();
      // الفسوحات تُرفع لموقع المستودع حتى لو واتساب مقطوع
      queueWaitingClearancesForSite().catch(() => {});
    }
    return;
  }

  isProcessingQueue = true;

  try {
    while (queue.length > 0 || messageQueue.length > 0) {
      // المهلة بين كل إرسال والذي بعده تُحسب من وقت آخر إرسال فعلي
      // (حتى لو وصل المستند التالي بعد انتهاء الطابور بلحظة)
      const waitMs = lastSentAt + CONFIG.delayMs - Date.now();
      if (lastSentAt && CONFIG.delayMs > 0 && waitMs > 0) {
        console.log(`⏱ الانتظار ${(waitMs / 1000).toFixed(1)} ثانية قبل المستند التالي (مهلة التأخير)...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
      if (!isWhatsAppReady) {
        // انقطع واتساب: الباقي ينتظر، ويكمل تلقائياً عند عودة الاتصال
        console.log(`⏳ واتساب غير متصل حالياً — (${queue.length}) مستند ينتظر عودة الاتصال.`);
        armWhatsAppDownAlert();
        queueWaitingClearancesForSite().catch(() => {});
        break;
      }

      // ما فيه مستندات: رسالة عميل واحدة (وبعدها نرجع نتأكد من المستندات أولاً)
      if (queue.length === 0) {
        const msg = messageQueue.shift();
        let result = false;
        try {
          result = await deliverCustomerMessage(msg);
        } catch (err) {
          console.error(`❌ خطأ غير متوقع أثناء إرسال رسالة عميل: ${err.message}`);
        }
        if (result === REQUEUE) {
          messageQueue.unshift(msg);
          if (isWhatsAppReady) {
            const t = setTimeout(() => processQueue(), 15000);
            if (t.unref) t.unref();
          }
          break;
        }
        if (result === true) lastSentAt = Date.now();
        continue;
      }

      const currentFile = queue.shift();
      const currentName = path.basename(currentFile);

      if (!fs.existsSync(currentFile)) {
        continue;
      }
      // تمت معالجته سابقاً (مثلاً حدث "تعديل" للملف أثناء إرساله) أو يُرسل الآن من مكان آخر => لا يُرسل مرة ثانية
      if (inFlight.has(currentName) || isFileAlreadyProcessed(currentFile)) {
        continue;
      }

      console.log(`\n--------------------------------------------------`);
      console.log(`🔄 بدء معالجة الملف: ${currentName}`);

      let wasSent = false;
      inFlight.add(currentName);
      try {
        wasSent = await handleInvoice(currentFile);
        if (wasSent === REQUEUE) {
          // لم يُرسل شيء لأن واتساب انقطع: يرجع لأول الطابور
          wasSent = false;
          if (!queue.includes(currentFile)) queue.unshift(currentFile);
          if (!isWhatsAppReady) {
            armWhatsAppDownAlert();
            queueWaitingClearancesForSite().catch(() => {});
          } else {
            // احتياط: لا إعادة محاولة سريعة متكررة، يعيد بعد قليل
            const t = setTimeout(() => processQueue(), 15000);
            if (t.unref) t.unref();
          }
          break;
        }
      } catch (err) {
        console.error(`❌ خطأ غير متوقع أثناء المعالجة (${path.basename(currentFile)}): ${err.message}`);
        try {
          await moveToReview(currentFile, `استثناء غير متوقع: ${err.message}`, DOC_TYPES.INVOICE);
        } catch (_) {}
      } finally {
        inFlight.delete(currentName);
      }

      if (wasSent) lastSentAt = Date.now();
    }
  } finally {
    isProcessingQueue = false;
  }
}

const DOC_TYPE_PLURAL = { invoice: 'الفواتير', clearance: 'الفسوحات', return: 'المرتجعات', statement: 'كشوف الحساب' };

function isDocTypeEnabled(docType) {
  return !!(CONFIG.sendDocTypes && CONFIG.sendDocTypes[docType.id] === true);
}

function stoppedReason(docType) {
  return `لم يُرسل: إرسال ${DOC_TYPE_PLURAL[docType.id] || docType.label} موقوف من الإعدادات`;
}

/** مستند من نوع موقوف: لا إرسال، يُنقل لمجلد Stopped (لا يُحذف حتى لا يضيع لو كان التصنيف خاطئاً) */
function skipStoppedDocument(filePath, docType, customerNumber) {
  keepWithoutSending(filePath, docType, customerNumber, { folder: 'Stopped', reason: stoppedReason(docType), kind: 'stopped' });
}

/** عميل نقدي (مثل 9999)؟ */
function isCashCustomer(customerNumber) {
  const n = groupMatcher.canonicalCustomerNumber(String(customerNumber == null ? '' : customerNumber));
  return !!n && (CONFIG.cashCustomerNumbers || []).some(c => groupMatcher.canonicalCustomerNumber(String(c)) === n);
}

function cashReason(customerNumber) {
  return `عميل نقدي [${customerNumber}]: لم يُرسل — محفوظ في مجلد "نقدي" للطباعة اليدوية`;
}

/** فاتورة عميل نقدي: لا إرسال، تُحفظ في مجلد "نقدي" (ولا تُحذف) */
function keepCashDocument(filePath, docType, customerNumber) {
  keepWithoutSending(filePath, docType, customerNumber, { folder: 'نقدي', reason: cashReason(customerNumber), kind: 'cash' });
  broadcastSseEvent('cash_pending', {});
}

const CASH_DIR = 'نقدي';
const CASH_PRINTED_DIR = 'مطبوعة';

/** فواتير نقدي تنتظر الطباعة اليدوية = الملفات الموجودة في مجلد "نقدي" (ما عدا "مطبوعة") */
function listCashPending() {
  const root = path.join(CONFIG.invoicesDir, CASH_DIR);
  const out = [];
  let subs = [];
  try { subs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== CASH_PRINTED_DIR).map(d => d.name); } catch (_) { return out; }
  for (const sub of subs) {
    const docType = Object.values(DOC_TYPES).find(d => d.subfolder === sub);
    let files = [];
    try { files = fs.readdirSync(path.join(root, sub)).filter(f => /\.pdf$/i.test(f)); } catch (_) {}
    for (const f of files) {
      const full = path.join(root, sub, f);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch (_) {}
      const reg = processedRegistry[f] || {};
      out.push({ fileName: f, filePath: full, docTypeLabel: docType ? docType.label : sub, customerNumber: reg.customerNumber || '', at: new Date(reg.processedAt || mtimeMs || Date.now()).toISOString() });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** "تمت الطباعة": ينقل الملف لمجلد نقدي/مطبوعة (لا يُحذف) */
function markCashPrinted(filePath) {
  const root = path.resolve(CONFIG.invoicesDir, CASH_DIR);
  const full = path.resolve(String(filePath || ''));
  const rel = path.relative(root, full);
  const parts = rel.split(path.sep);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || parts.length !== 2 || parts[0] === CASH_PRINTED_DIR || !/\.pdf$/i.test(full)) {
    throw new Error('الملف ليس من فواتير النقدي');
  }
  if (!fs.existsSync(full)) throw new Error('الملف غير موجود');
  return safeRelocateFile(full, path.join(root, CASH_PRINTED_DIR, parts[0]));
}

/** مستند لا يُرسل: يُنقل لمجلد خاص (لا يُحذف)، ويظهر في لوحة العمليات بدون زر إعادة إرسال */
function keepWithoutSending(filePath, docType, customerNumber, { folder, reason, kind }) {
  const fileName = path.basename(filePath);
  const stat = fileStatDetails(filePath);
  const dest = safeRelocateFile(filePath, path.join(CONFIG.invoicesDir, folder, docType.subfolder));
  markFileAsProcessed(filePath, 'skipped', { ...stat, docType: docType.subfolder, customerNumber, reason, kind, stoppedCopy: dest });
  recordOutcome(fileName, { status: 'skipped', customerNumber, message: reason });
  console.log(`${kind === 'cash' ? '💵' : '⏸'} ${fileName}: ${reason} (${folder}/${docType.subfolder})`);
  addActivityLog({ fileName, filePath: dest, docTypeLabel: docType.label, docTypeClass: docType.class, customerNumber, phone: '-', status: 'skipped', skipKind: kind, reason });
}

/** نتيجة handleInvoice: لم يُرسل شيء لأن واتساب غير متصل => يعود المستند للطابور */
const REQUEUE = 'requeue';

/** إلغاء علامة "قيد الإرسال" لمستند لم يخرج فعلاً (واتساب انقطع قبل الإرسال) */
function unmarkSending(filePath) {
  const name = path.basename(filePath);
  if (processedRegistry[name] && processedRegistry[name].status === 'sending') {
    delete processedRegistry[name];
    try { saveProcessedRegistry(); } catch (_) {}
  }
}

/** آخر الملف فيه علامة نهاية PDF (%%EOF) والملف يفتح للقراءة = انكتب كامل */
function isCompletePdfFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 64) return false;
    const len = Math.min(1024, size);
    const tail = Buffer.alloc(len);
    fs.readSync(fd, tail, 0, len, size - len);
    return /%%EOF\s*$/.test(tail.toString('latin1'));
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

async function waitForFileReady(filePath, maxWaitMs = 2500) {
  const start = Date.now();
  // ملف PDF مكتمل (آخره %%EOF) ويفتح للقراءة => نقرأه على طول بدون انتظار إضافي
  if (isCompletePdfFile(filePath)) return true;
  let lastSize = -1;
  while (Date.now() - start < maxWaitMs) {
    try {
      if (!fs.existsSync(filePath)) return false;
      const stat = fs.statSync(filePath);
      if (stat.size > 0 && stat.size === lastSize) {
        try {
          const fd = fs.openSync(filePath, 'r');
          fs.closeSync(fd);
          return true; // الملف مكتمل وقابل للقراءة فوراً!
        } catch (_) {}
      }
      lastSize = stat.size;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 120));
  }
  return fs.existsSync(filePath);
}

/**
 * معالجة المستند: تصنيفه، استخراج رقم العميل، إرساله، وأرشفته
 */
async function handleInvoice(filePath) {
  const fileName = path.basename(filePath);

  // 0. انتظار انتهاء برنامج التصدير (Word أو الطابعة) من كتابة وحفظ كامل الملف
  await waitForFileReady(filePath, 2000);

  // 1. استخراج النص من PDF مع إعادة المحاولة لضمان اكتمال المستند
  let pdfData = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const dataBuffer = fs.readFileSync(filePath);
      pdfData = await parsePdf(dataBuffer);
      if (pdfData && typeof pdfData.text === 'string') break;
    } catch (parseErr) {
      if (attempt === 3) {
        console.error(`❌ تعذر استخراج النص من ملف PDF (${fileName}): ${parseErr.message}`);
        const dest = await moveToReview(filePath, `تعذر استخراج النص: ${parseErr.message}`, DOC_TYPES.INVOICE);
        addActivityLog({
          fileName,
          filePath: dest,
          docTypeLabel: 'غير محدد',
          docTypeClass: 'general',
          customerNumber: '-',
          phone: '-',
          status: 'review',
          reason: 'تعذر قراءة ملف PDF'
        });
        return false;
      }
      await new Promise(r => setTimeout(r, 600));
    }
  }

  const rawText = pdfData.text || '';

  // 2. التصنيف الذكي التلقائي لنوع المستند
  const docType = detectDocumentType(rawText, pdfData.layoutItems);
  console.log(`🏷 نوع المستند المكتشف: [${docType.label}]`);

  if (CONFIG.debug) {
    console.log(`🔍 [تصحيح] أول 400 حرف من المستند (${fileName}):`);
    console.log(rawText.slice(0, 400));
  }

  // الفسح: يذهب للمستودع (قروب المستودع + موقع المستودع) وليس لقروب العميل
  if (docType.id === 'clearance' && isWarehouseRouteActive()) {
    const r = await deliverClearanceToWarehouse(filePath, docType, pdfData);
    if (r.outcome === 'requeue') {
      console.log(`⏳ ${fileName}: واتساب انقطع — سيُرسل لقروب المستودع تلقائياً عند عودة الاتصال.`);
      return REQUEUE;
    }
    // true = خرجت رسالة واتساب فعلاً (تُحسب في مهلة التأخير بين الرسائل)
    return ['sent', 'test', 'unconfirmed'].includes(r.outcome);
  }

  // نوع موقوف إرساله من الإعدادات (مثل الفسوحات): لا يُرسل أبداً، ويُحفظ في مجلد Stopped
  if (!isDocTypeEnabled(docType)) {
    const ex = extractCustomerNumber(rawText, pdfData.layoutItems);
    skipStoppedDocument(filePath, docType, ex.success ? ex.customerNumber : '-');
    return false;
  }

  // 3. استخراج رقم العميل
  const extraction = extractCustomerNumber(rawText, pdfData.layoutItems);
  if (!extraction.success) {
    const custDisplay = (extraction.uniqueNumbers && extraction.uniqueNumbers.length > 0)
      ? extraction.uniqueNumbers.join(', ')
      : '-';
    console.warn(`⚠ للمراجعة: ${extraction.reason} في الملف (${fileName})`);
    const dest = await moveToReview(filePath, extraction.reason, docType, custDisplay, '-', '');
    addActivityLog({
      fileName,
      filePath: dest,
      docTypeLabel: docType.label,
      docTypeClass: docType.class,
      customerNumber: custDisplay,
      phone: '-',
      status: 'review',
      reason: extraction.reason
    });
    return false;
  }

  const customerNumber = extraction.customerNumber;
  console.log(`ℹ تم استخراج رقم العميل بنجاح: [${customerNumber}]`);

  // عميل نقدي (9999): لا يُرسل لأي قروب، يُحفظ للطباعة اليدوية
  if (isCashCustomer(customerNumber)) {
    keepCashDocument(filePath, docType, customerNumber);
    return false;
  }

  // 4. تحديد قروب العميل تلقائياً من أسماء قروبات واتساب (أو رقم التجربة إن كان مفعلاً)
  const plan = await planDelivery(customerNumber);

  // التشغيل التجريبي: لا إرسال ولا نقل للملف
  if (plan.notReady) {
    console.log(`⏳ ${fileName}: واتساب انقطع — سيُرسل تلقائياً عند عودة الاتصال.`);
    return REQUEUE;
  }

  if (CONFIG.dryRun) {
    logDryRun(fileName, customerNumber, plan);
    return false;
  }

  if (!plan.ok) {
    console.warn(`⚠ للمراجعة: ${plan.reason}`);
    const dest = await moveToReview(filePath, plan.reason, docType, customerNumber, plan.destLabel);
    addActivityLog({
      fileName,
      filePath: dest,
      docTypeLabel: docType.label,
      docTypeClass: docType.class,
      customerNumber,
      phone: plan.destLabel,
      status: 'review',
      reason: plan.reason
    });
    return false;
  }

  // 5. إرسال ملف المستند عبر واتساب وانتظار تأكيد الاستلام
  // علامة "قيد الإرسال": إذا أُغلق البرنامج الآن لا يُعاد إرسال المستند تلقائياً بل يُنقل للمراجعة عند التشغيل
  markFileAsProcessed(filePath, 'sending', { customerNumber, destination: plan.destLabel, docType: docType.subfolder });
  let confirmed = false;
  try {
    console.log(`📤 جاري إرسال ${docType.label} للعميل [${customerNumber}] إلى ${plan.destLabel}...`);
    confirmed = await sendDocumentConfirmed(plan.chatId, filePath, getCaptionForDocType(docType), customerFileName(docType, customerNumber));
    logSendSuccess(fileName, customerNumber, plan);
  } catch (sendErr) {
    if (sendErr && sendErr.code === 'WA_NOT_READY') {
      // انقطع واتساب قبل خروج الرسالة: لم يُرسل شيء، فيرجع للانتظار بأمان
      unmarkSending(filePath);
      console.log(`⏳ ${fileName}: واتساب انقطع قبل الإرسال — سيُرسل تلقائياً عند عودة الاتصال.`);
      return REQUEUE;
    }
    console.error(`❌ فشل إرسال المستند عبر واتساب: ${sendErr.message}`);
    const dest = await moveToReview(filePath, sendFailureReason(sendErr), docType, customerNumber, plan.destLabel);
    addActivityLog({
      fileName,
      filePath: dest,
      docTypeLabel: docType.label,
      docTypeClass: docType.class,
      customerNumber,
      phone: plan.destLabel,
      status: 'review',
      reason: sendErr.message
    });
    return false;
  }

  // لم يصل تأكيد من واتساب: لا نحذف شيئاً، ونضعه في المراجعة للتأكد يدوياً
  if (!confirmed) {
    console.warn(`⚠ ${fileName}: ${UNCONFIRMED_REASON}`);
    const dest = await moveToReview(filePath, UNCONFIRMED_REASON, docType, customerNumber, plan.destLabel);
    addActivityLog({ fileName, filePath: dest, docTypeLabel: docType.label, docTypeClass: docType.class, customerNumber, phone: plan.destLabel, status: 'review', reason: UNCONFIRMED_REASON });
    return true;
  }

  // وضع التجربة: أُرسل لرقم التجربة فقط وليس للعميل => لا يُحذف، يُحفظ في مجلد Test
  if (plan.isTest) {
    const testPath = finalizeTest(filePath, docType, { customerNumber, destination: plan.destLabel });
    addActivityLog({ fileName, filePath: testPath, docTypeLabel: docType.label, docTypeClass: docType.class, customerNumber, phone: plan.destLabel, status: 'sent', reason: 'أُرسل لرقم التجربة فقط (لم يُرسل للعميل) — المستند محفوظ في مجلد Test' });
    return true;
  }

  // 6. تم التأكيد: حذف الملف (أو أرشفته إذا كان الحذف التلقائي معطلاً)
  try {
    const sentPath = await finalizeSent(filePath, docType, { customerNumber, destination: plan.destLabel });
    if (sentPath) console.log(`📁 تم نقل الملف بنجاح إلى مجلد Sent/${docType.subfolder}: ${path.basename(sentPath)}`);
    addActivityLog({
      fileName,
      filePath: sentPath || '',
      docTypeLabel: docType.label,
      docTypeClass: docType.class,
      customerNumber,
      phone: plan.destLabel,
      status: 'sent',
      reason: sentPath ? `تم الإرسال ونقل للمجلد Sent/${docType.subfolder}` : 'تم الإرسال وتأكيد الاستلام، وحُذف الملف'
    });
    return true;
  } catch (moveErr) {
    console.error(`❌ تعذر إنهاء الملف بعد الإرسال: ${moveErr.message}`);
    return true;
  }
}

/**
 * إعادة محاولة إرسال مستند متعثر (سواء من الموظف أو الإدارة)
 * مع إمكانية تحديد رقم العميل مباشرة في حال التضارب
 */
/**
 * إعادة الإرسال من الواجهة: لا يُسمح بإرسالين لنفس المستند في نفس الوقت (ضغط الزر مرتين، أو أثناء إرساله من الطابور)
 */
async function retryDocumentSending(filePath, overrideCustomerNumber = null, opts = {}) {
  const name = path.basename(filePath);
  if (inFlight.has(name)) {
    return { success: false, reason: 'هذا المستند قيد الإرسال الآن، انتظر النتيجة' };
  }
  inFlight.add(name);
  try {
    return await retryDocumentSendingInner(filePath, overrideCustomerNumber, opts);
  } finally {
    inFlight.delete(name);
  }
}

/** نوع المستند بدون اعتبار كلمة "فسح" (لزر "هذا مو فسح — أرسله") */
function detectTypeIgnoringClearance(rawText) {
  const clean = normalizeArabicText(rawText || '').replace(BIDI_MARKS, '');
  if (/كشف\s*(?:ال)?حساب|باسح(?:لا)?\s*فشك/.test(clean) || extractAccountCustomerNumbers(clean).length > 0) return DOC_TYPES.STATEMENT;
  if (/مرتجع|عجترم/.test(clean)) return DOC_TYPES.RETURN;
  return DOC_TYPES.INVOICE;
}

async function retryDocumentSendingInner(filePath, overrideCustomerNumber = null, opts = {}) {
  const fileName = path.basename(filePath);
  let pdfData;
  try {
    const dataBuffer = fs.readFileSync(filePath);
    pdfData = await parsePdf(dataBuffer);
  } catch (err) {
    return { success: false, reason: 'تعذر قراءة ملف الـ PDF: ' + err.message };
  }

  const rawText = pdfData.text || '';
  let docType = detectDocumentType(rawText, pdfData.layoutItems);
  // "هذا مو فسح — أرسله": المستخدم أكد أنه ليس فسح => يُعاد تصنيفه بدون كلمة الفسح (وكل فحوصات رقم العميل تبقى)
  if (opts.notClearance && docType.id === 'clearance') docType = detectTypeIgnoringClearance(rawText);

  // الفسح: نفس مسار المستودع (قروب المستودع + موقع المستودع)
  if (docType.id === 'clearance' && isWarehouseRouteActive()) {
    const needsWhatsApp = !CONFIG.dryRun && (!!warehouseGroupFor(branchOf(path.basename(filePath))).number || isTestPhoneActive());
    if (needsWhatsApp && !isWhatsAppReady) {
      return { success: false, reason: 'خدمة واتساب غير متصلة حالياً' };
    }
    const r = await deliverClearanceToWarehouse(filePath, docType, pdfData, { interactive: true });
    if (r.outcome === 'requeue') {
      return { success: false, reason: 'خدمة واتساب غير متصلة حالياً — حاول بعد عودة الاتصال' };
    }
    if (!['sent', 'test', 'site_only'].includes(r.outcome)) {
      return { success: false, reason: r.reason };
    }
    // إذا كان الحذف معطلاً والملف داخل مجلد Review يتم تنظيفه حتى لا يتكرر ظهوره
    if (r.outcome !== 'test' && r.sentPath && filePath.toLowerCase().includes(path.join('review', '').toLowerCase())) {
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
    }
    return { success: true, sentPath: r.sentPath };
  }

  if (!isDocTypeEnabled(docType)) {
    return { success: false, reason: stoppedReason(docType) };
  }

  const extraction = extractCustomerNumber(rawText, pdfData.layoutItems);
  const found = extraction.success ? [extraction.customerNumber] : (extraction.uniqueNumbers || []);
  // أي رقم نقدي في المستند => لا إرسال أبداً (حتى لو اختار المستخدم رقماً آخر)
  if (found.some(n => isCashCustomer(n))) {
    return { success: false, reason: cashReason(found.find(n => isCashCustomer(n))) };
  }

  let customerNumber = null;
  if (overrideCustomerNumber != null && String(overrideCustomerNumber).trim() !== '') {
    // الاختيار اليدوي: لازم يكون من الأرقام الموجودة فعلاً في المستند
    const chosen = normalizeArabicText(String(overrideCustomerNumber)).replace(/\s/g, '');
    const match = found.find(n => groupMatcher.stripLeadingZeros(n) === groupMatcher.stripLeadingZeros(chosen));
    if (!/^\d+$/.test(chosen) || !match) {
      return { success: false, reason: `الرقم [${chosen}] ليس من أرقام العملاء الموجودة في المستند — لم يتم الإرسال` };
    }
    customerNumber = match;
  } else {
    if (!extraction.success) {
      return {
        success: false,
        reason: extraction.reason,
        uniqueNumbers: extraction.uniqueNumbers || []
      };
    }
    customerNumber = extraction.customerNumber;
  }

  if (isCashCustomer(customerNumber)) {
    return { success: false, reason: cashReason(customerNumber) };
  }

  if (!isWhatsAppReady) {
    return { success: false, reason: 'خدمة واتساب غير متصلة حالياً' };
  }

  getWhatsAppClient();
  const plan = await planDelivery(customerNumber);
  if (plan.notReady) {
    return { success: false, reason: 'خدمة واتساب غير متصلة حالياً — حاول بعد عودة الاتصال' };
  }

  if (CONFIG.dryRun) {
    logDryRun(fileName, customerNumber, plan);
    return {
      success: false,
      reason: plan.groupName && !plan.groupReason
        ? `تشغيل تجريبي: كان سيُرسل إلى القروب "${plan.groupName}" (لم يُرسل شيء)`
        : `تشغيل تجريبي: ${plan.groupReason}`
    };
  }

  if (!plan.ok) {
    console.warn(`⚠ للمراجعة: ${plan.reason}`);
    return { success: false, reason: plan.reason };
  }

  markFileAsProcessed(filePath, 'sending', { customerNumber, destination: plan.destLabel, docType: docType.subfolder });
  let confirmed = false;
  try {
    confirmed = await sendDocumentConfirmed(plan.chatId, filePath, getCaptionForDocType(docType), customerFileName(docType, customerNumber));
    logSendSuccess(fileName, customerNumber, plan);
  } catch (sendErr) {
    if (sendErr && sendErr.code === 'WA_NOT_READY') {
      unmarkSending(filePath);
      return { success: false, reason: 'خدمة واتساب انقطعت قبل الإرسال (لم يُرسل شيء) — حاول بعد عودة الاتصال' };
    }
    const reason = sendFailureReason(sendErr);
    await moveToReview(filePath, reason, docType, customerNumber, plan.destLabel);
    return { success: false, reason };
  }
  if (!confirmed) {
    await moveToReview(filePath, UNCONFIRMED_REASON, docType, customerNumber, plan.destLabel);
    return { success: false, reason: UNCONFIRMED_REASON };
  }

  // وضع التجربة: لا يُحذف المستند (لم يصل للعميل)
  if (plan.isTest) {
    const testPath = finalizeTest(filePath, docType, { customerNumber, destination: plan.destLabel });
    addActivityLog({ fileName, filePath: testPath, docTypeLabel: docType.label, docTypeClass: docType.class, customerNumber, phone: plan.destLabel, status: 'sent', reason: 'أُرسل لرقم التجربة فقط (لم يُرسل للعميل) — المستند محفوظ في مجلد Test' });
    return { success: true, sentPath: testPath };
  }

  const sentPath = await finalizeSent(filePath, docType, { customerNumber, destination: plan.destLabel });

  // إذا كان الحذف معطلاً والملف داخل مجلد Review يتم تنظيفه حتى لا يتكرر ظهوره
  if (sentPath && filePath.toLowerCase().includes(path.join('review', '').toLowerCase())) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🧹 تم تنظيف نسخة المراجعة بنجاح بعد الإرسال: ${path.basename(filePath)}`);
      }
    } catch (_) {}
  }

  addActivityLog({
    fileName,
    filePath: sentPath || '',
    docTypeLabel: docType.label,
    docTypeClass: docType.class,
    customerNumber,
    phone: plan.destLabel,
    status: 'sent',
    reason: sentPath ? `تمت إعادة الإرسال بنجاح إلى ${plan.destLabel} ونقل الملف إلى Sent/${docType.subfolder}` : `تمت إعادة الإرسال بنجاح إلى ${plan.destLabel} وحُذف الملف`
  });

  return { success: true, sentPath };
}

// ==========================================
// مراقبة المجلد بواسطة Chokidar
// ==========================================

function initWatcher() {
  // المسار الحقيقي (ويندوز قد يكتب نفس المجلد بصيغة مختصرة مثل USERNA~1) حتى تتطابق المقارنات
  let rootDir = path.resolve(CONFIG.invoicesDir);
  try { rootDir = fs.realpathSync.native(rootDir); } catch (_) {}

  const watcher = chokidar.watch(rootDir, {
    depth: 0,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 400,
      pollInterval: 100
    },
    ignored: (itemPath, stats) => {
      const resolved = path.resolve(itemPath);
      if (resolved === rootDir) return false;
      if (stats && stats.isDirectory()) return true;
      if (path.dirname(resolved) !== rootDir) return true;
      return path.extname(resolved).toLowerCase() !== '.pdf';
    }
  });

  watcher.on('add', (filePath) => {
    const resolved = path.resolve(filePath);
    if (path.dirname(resolved) !== rootDir) return;
    if (path.extname(resolved).toLowerCase() !== '.pdf') return;
    if (isFileAlreadyProcessed(resolved)) return;
    console.log(`⚡ رصد ملف جديد فوراً: ${path.basename(resolved)}`);
    broadcastSseEvent('file_detected', { fileName: path.basename(resolved), time: new Date().toLocaleTimeString('ar-SA') });
    enqueue(resolved);
  });

  watcher.on('change', (filePath) => {
    const resolved = path.resolve(filePath);
    if (path.dirname(resolved) !== rootDir) return;
    if (path.extname(resolved).toLowerCase() !== '.pdf') return;
    if (isFileAlreadyProcessed(resolved)) return;
    console.log(`⚡ تعديل/تحديث ملف: ${path.basename(resolved)}`);
    broadcastSseEvent('file_detected', { fileName: path.basename(resolved), time: new Date().toLocaleTimeString('ar-SA') });
    enqueue(resolved);
  });

  watcher.on('error', (err) => {
    console.error('❌ خطأ في مراقب المجلد (Chokidar):', err.message);
  });

  console.log(`👀 جاري مراقبة المجلد (${rootDir}) للملفات الجديدة (فواتير، فسوحات، مرتجعات، كشوف حساب)...`);
  return watcher;
}

/**
 * فحص المجلد الرئيسي عند بدء تشغيل البرنامج لأي ملفات PDF جديدة لم تتم معالجتها
 */
function scanAndEnqueuePendingInvoices() {
  const rootDir = path.resolve(CONFIG.invoicesDir);
  if (!fs.existsSync(rootDir)) return;
  try {
    const files = fs.readdirSync(rootDir);
    for (const f of files) {
      if (f.toLowerCase().endsWith('.pdf')) {
        const fullPath = path.join(rootDir, f);
        try {
          if (fs.statSync(fullPath).isFile() && !isFileAlreadyProcessed(fullPath)) {
            console.log(`📥 رصد مستند جديد في المجلد عند بدء التشغيل: ${f}`);
            enqueue(fullPath);
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    console.warn('تحذير أثناء فحص المجلد الرئيسي عند الإقلاع:', err.message);
  }
}

/**
 * مزامنة ملفات المراجعة الموجودة مسبقاً على القرص مع استخراج الأسباب الدقيقة الحقيقية
 */
async function syncExistingReviewFiles() {
  const reviewBase = path.join(CONFIG.invoicesDir, 'Review');
  const subfolders = [
    { sub: 'فواتير', label: 'فاتورة مبيعات', class: 'invoice' },
    { sub: 'فسوحات', label: 'فسح جمركي', class: 'clearance' },
    { sub: 'مرتجعات', label: 'مرتجع', class: 'return' },
    { sub: 'كشوفات', label: 'كشف حساب', class: 'statement' }
  ];

  const collected = [];

  for (const { sub, label, class: docClass } of subfolders) {
    const dir = path.join(reviewBase, sub);
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf'));
      for (const f of files) {
        const fullPath = path.join(dir, f);
        if (activityLogs.some(l => l.fileName === f && l.status === 'review')) continue;

        // 1. فحص سجل المعالجة التاريخي إن وجد
        const registered = processedRegistry[f];
        if (registered && (registered.status === 'sent' || registered.dismissed || registered.status === 'dismissed')) {
          continue; // تم إرساله مسبقاً بنجاح أو إخفاؤه وتجاهله
        }

        let detectedCustomer = '-';
        let detectedPhone = '-';
        let failureReason = 'مستند متعثر بانتظار المراجعة والاعتماد';
        let statMtime = 0;
        try {
          statMtime = fs.statSync(fullPath).mtimeMs;
        } catch (_) {}

        // 2. فحص محتوى ملف الـ PDF مباشرة لاستخراج رقم العميل الحقيقي والسبب الدقيق
        try {
          const buf = fs.readFileSync(fullPath);
          const parsed = await parsePdf(buf);
          if (parsed && typeof parsed.text === 'string') {
            const extraction = extractCustomerNumber(parsed.text, parsed.layoutItems);
            if (!extraction.success) {
              failureReason = extraction.reason;
              if (extraction.uniqueNumbers && extraction.uniqueNumbers.length > 0) {
                detectedCustomer = extraction.uniqueNumbers.join(', ');
              }
            } else {
              detectedCustomer = extraction.customerNumber;
              // السبب المحفوظ من آخر محاولة (مثل: لا يوجد قروب / أكثر من قروب) إن وجد
              failureReason = (registered && registered.reason) || 'المستند بانتظار المراجعة وإعادة الإرسال';
              if (registered && registered.phone) detectedPhone = registered.phone;
            }
          } else {
            failureReason = 'تعذر استخراج النص من المستند';
          }
        } catch (pdfErr) {
          failureReason = `الملف تالف أو غير قابل للقراءة (${pdfErr.message})`;
        }

        markFileAsProcessed(fullPath, 'review', {
          noReport: true, // مستندات قديمة في المراجعة عند التشغيل: لا تُسجل بتاريخ اليوم
          reason: failureReason,
          docType: sub,
          destination: fullPath,
          customerNumber: detectedCustomer,
          phone: detectedPhone
        });

        collected.push({
          id: 'rev_' + Date.now() + Math.random().toString(36).substring(2, 5),
          time: new Date(statMtime || Date.now()).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' }),
          mtimeMs: statMtime,
          fileName: f,
          filePath: fullPath,
          docTypeLabel: label,
          docTypeClass: docClass,
          customerNumber: detectedCustomer,
          phone: detectedPhone,
          status: 'review',
          reason: failureReason
        });
      }
    } catch (_) {}
  }

  // ترتيب الملفات بحيث تظهر الأحدث دائماً في الأعلى
  collected.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  for (const item of collected) {
    delete item.mtimeMs;
    activityLogs.push(item);
  }
}

function parseSafeJson(body) {
  if (!body || typeof body !== 'string') return {};
  try {
    return JSON.parse(body);
  } catch (_) {
    try {
      const sanitized = body.replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":');
      return JSON.parse(sanitized);
    } catch (e) {
      return {};
    }
  }
}

// ==========================================
// خادم لوحة التحكم وصفحة الأدمن (Web & Desktop Server)
// ==========================================

function startWebServer(port = 3500) {
  const server = http.createServer(async (req, res) => {
    // الحماية: لوحة التحكم لا تقبل أوامر إلا من صفحتها هي.
    // أي موقع إنترنت يُفتح في متصفح هذا الجهاز لا يستطيع تغيير الإعدادات أو إرسال/حذف مستندات.
    const loopbackHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
    const ownOrigin = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
    if (CONFIG.dashboardHost !== '0.0.0.0' && !loopbackHost.test(String(req.headers.host || ''))) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin && !ownOrigin.test(String(origin))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'طلب مرفوض' }));
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://localhost:${port}`);
    const pathname = parsedUrl.pathname;

    // عرض واجهة المستخدم الرئيسية والملفات الثابتة
    if (pathname === '/' || pathname === '/index.html') {
      const htmlPath = path.join(__dirname, 'public', 'index.html');
      if (fs.existsSync(htmlPath)) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          // حماية إضافية: الصفحة ما تحمّل ولا ترسل لأي موقع برا البرنامج (حتى لو انحقن فيها شي)
          // على السيرفر الشاشة تفتح داخل صفحة الموقع (نفس العنوان)
          'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${HOSTED ? "'self'" : "'none'"}`,
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(fs.readFileSync(htmlPath));
        return;
      }
    }

    if (pathname === '/logo.png') {
      const logoPath = path.join(__dirname, 'public', 'logo.png');
      if (fs.existsSync(logoPath)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(fs.readFileSync(logoPath));
        return;
      }
    }

    if (pathname === '/pdf.js' || pathname === '/pdf.worker.js') {
      const target = path.join(__dirname, 'public', pathname.slice(1));
      if (fs.existsSync(target)) {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(fs.readFileSync(target));
        return;
      }
    }

    // API: جلب محتوى ملف المستند كـ Base64 مشفر (مقاوم لـ IDM تماماً)
    if (pathname === '/api/document-data' && (req.method === 'GET' || req.method === 'POST')) {
      const fileName = parsedUrl.searchParams.get('file') || parsedUrl.searchParams.get('name') || '';
      const filePath = parsedUrl.searchParams.get('path') || '';
      const resolvedPath = findDocumentPath(fileName, filePath);
      if (!resolvedPath || !fs.existsSync(resolvedPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'الملف غير موجود على القرص' }));
        return;
      }
      try {
        const fileBuffer = fs.readFileSync(resolvedPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          fileName: path.basename(resolvedPath),
          base64: fileBuffer.toString('base64'),
          size: fileBuffer.length
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
      return;
    }

    // API: حالة النظام والباركود
    if (pathname === '/api/status' && req.method === 'GET') {
      const sentCount = activityLogs.filter(l => l.status === 'sent').length;
      const reviewCount = activityLogs.filter(l => l.status === 'review').length;
      const customersCount = getGroupsSummary().readyCount;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        hosted: HOSTED,
        status: isWhatsAppReady ? 'connected' : (currentQrSvg ? 'qr_ready' : (whatsAppFailed ? 'failed' : (isReconnecting ? 'reconnecting' : 'waiting'))),
        phone: connectedPhone || '',
        qrSvg: currentQrSvg,
        loadingPercent: loadingPercent,
        stats: {
          sent: sentCount,
          review: reviewCount,
          customersCount
        },
        warehouse: getWarehouseSummary(),
        recentLogs: activityLogs.slice(0, 10)
      }));
      return;
    }

    // API: المستودع — قائمة القروبات لاختيار قروب المستودع + حالة الرفع للموقع
    if (pathname === '/api/warehouse' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...getWarehouseSummary(),
        siteUrl: CONFIG.warehouseSiteUrl
      }));
      return;
    }

    // ===== تقارير العملاء (الجهاز الرئيسي فقط) =====
    if (pathname === '/api/reports' && req.method === 'GET') {
      const month = parsedUrl.searchParams.get('month') || '';
      const from = parsedUrl.searchParams.get('from') || '';
      const to = parsedUrl.searchParams.get('to') || '';
      const hasGroup = (n) => !!groupIndex && groupMatcher.findGroupForCustomer(groupIndex, n).status === 'match';
      try {
        const r = customerReports().report({ from, to, month, hasGroup: groupIndex ? hasGroup : null });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ...r, months: customerReports().months(), warning: customerReports().loadError || '' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
      return;
    }
    if (pathname === '/api/reports/customer' && req.method === 'GET') {
      const number = String(parsedUrl.searchParams.get('number') || '').trim();
      const info = (customerReports().customers.customers || []).find(c => groupMatcher.stripLeadingZeros(c.number) === groupMatcher.stripLeadingZeros(number)) || null;
      let group = null;
      if (groupIndex) { const g = groupMatcher.findGroupForCustomer(groupIndex, number); if (g.status === 'match') group = g.group.name; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ number, info, group, history: customerReports().history(number) }));
      return;
    }
    // "هذا مو فسح — أرسله": مستند في Stopped/فسوحات تأكد المستخدم أنه ليس فسح
    if (pathname === '/api/send-stopped' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
      req.on('end', async () => {
        try {
          const { filePath } = JSON.parse(body || '{}');
          const root = path.resolve(CONFIG.invoicesDir, 'Stopped');
          const full = path.resolve(String(filePath || ''));
          const rel = path.relative(root, full);
          if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !/\.pdf$/i.test(full) || !fs.existsSync(full)) throw new Error('الملف ليس من المستندات الموقوفة');
          const result = await retryDocumentSending(full, null, { notClearance: true });
          if (result.success) console.log(`📤 (${path.basename(full)}) أُرسل بعد تأكيد المستخدم أنه ليس فسح`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, reason: e.message }));
        }
      });
      return;
    }

    // فواتير نقدي تنتظر الطباعة اليدوية
    if (pathname === '/api/cash-pending' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ items: listCashPending() }));
      return;
    }
    if (pathname === '/api/cash-done' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
      req.on('end', () => {
        try {
          const { filePath } = JSON.parse(body || '{}');
          const dest = markCashPrinted(filePath);
          console.log(`🖨 تمت طباعة فاتورة النقدي (${path.basename(dest)}) ونُقلت إلى نقدي/مطبوعة`);
          broadcastSseEvent('cash_pending', {});
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, message: e.message }));
        }
      });
      return;
    }

    // تصدير Excel حقيقي (.xlsx): الصفحة ترسل الصفوف المعروضة (حسب الفلتر والبحث) والبرنامج يبني الملف
    if (pathname === '/api/reports/xlsx' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 20 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const d = JSON.parse(body || '{}');
          if (!Array.isArray(d.headers) || !Array.isArray(d.rows)) throw new Error('بيانات غير صحيحة');
          const { buildXlsx } = require('./xlsx-writer');
          const buf = buildXlsx({ sheetName: d.sheetName || 'تقرير العملاء', title: d.title || '', headers: d.headers, rows: d.rows, widths: d.widths || [], textColumns: [0] });
          res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Length': buf.length });
          res.end(buf);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, message: e.message }));
        }
      });
      return;
    }

    if (pathname === '/api/reports/import' && req.method === 'POST') {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 20 * 1024 * 1024) req.destroy(); else chunks.push(c); });
      req.on('end', async () => {
        try {
          const name = decodeURIComponent(String(req.headers['x-file-name'] || ''));
          const count = await importCustomerListFile(Buffer.concat(chunks), name, { force: parsedUrl.searchParams.get('force') === '1' });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, count }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, message: e.message, needsConfirm: !!e.needsConfirm }));
        }
      });
      return;
    }

    // API: إعادة ضبط جلسة واتساب وتوليد باركود جديد فوراً
    if ((pathname === '/api/reset-whatsapp' || pathname === '/api/logout') && req.method === 'POST') {
      console.log('🔄 تم طلب مسح جلسة واتساب القديمة وتوليد باركود جديد...');
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      markWhatsAppDown();
      isReconnecting = false;
      whatsAppFailed = false;
      connectedPhone = null;
      currentQrSvg = null;
      loadingPercent = null;
      reconnectAttempts = 0;
      broadcastSseEvent('wa_status', { status: 'waiting' });
      restartWhatsAppClient(true);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'جاري مسح الجلسة القديمة وتوليد باركود جديد...' }));
      return;
    }

    // API: قناة البث اللحظي الفوري للأحداث (Server-Sent Events)
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
      });
      res.write(':\n\n');
      sseClients.add(res);

      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // API: سجل العمليات الكامل
    if (pathname === '/api/logs' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(activityLogs));
      return;
    }

    // API: فتح المستند عبر برنامج الويندوز الافتراضي
    // فتح الملفات والمجلدات على الجهاز: ما له معنى على السيرفر
    if (HOSTED && ['/api/open-file', '/api/show-in-folder', '/api/select-file', '/api/open-folder', '/api/shutdown'].includes(pathname)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: HOSTED_UNAVAILABLE }));
      return;
    }

    if (pathname === '/api/open-file' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { fileName, filePath } = parseSafeJson(body);
          const resolvedPath = findDocumentPath(fileName, filePath);
          if (!resolvedPath || !fs.existsSync(resolvedPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'الملف غير موجود على القرص' }));
            return;
          }
          const absPath = path.resolve(resolvedPath);
          console.log(`📄 طلب فتح الملف عبر ويندوز: "${absPath}"`);
          runPsWithPath('Invoke-Item -LiteralPath $env:ALWADY_PATH', absPath, (err) => {
            if (err) childProcess.execFile('explorer.exe', [absPath], { windowsHide: true }, () => {});
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, filePath: absPath }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
      });
      return;
    }

    // API: إظهار الملف داخل مجلد الويندوز (Explorer) أو فتح المجلد الرئيسي
    if ((pathname === '/api/show-in-folder' || pathname === '/api/select-file' || pathname === '/api/open-folder') && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { fileName, filePath } = parseSafeJson(body);
          const resolvedPath = findDocumentPath(fileName, filePath);

          if (resolvedPath && fs.existsSync(resolvedPath)) {
            const absFile = path.resolve(resolvedPath);
            selectFileInExplorer(absFile);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, path: absFile }));
          } else {
            const rootDir = path.resolve(fs.existsSync(CONFIG.invoicesDir) ? CONFIG.invoicesDir : '.');
            openFolderInExplorer(rootDir);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, folder: rootDir }));
          }
        } catch (err) {
          console.error('Error in show-in-folder:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
      });
      return;
    }

    // API: معاينة ملف الـ PDF كتيار للمتصفح
    if ((pathname === '/api/view-pdf' || pathname === '/api/document-pdf') && req.method === 'GET') {
      const fileName = parsedUrl.searchParams.get('file') || parsedUrl.searchParams.get('name') || '';
      const filePath = parsedUrl.searchParams.get('path') || '';
      const resolvedPath = findDocumentPath(fileName, filePath);
      if (!resolvedPath || !fs.existsSync(resolvedPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('الملف غير موجود');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${encodeURIComponent(path.basename(resolvedPath))}"`
      });
      fs.createReadStream(resolvedPath).pipe(res);
      return;
    }

    // API: تجاهل / إخفاء جميع التنبيهات والمستندات المتعثرة وحفظ الإخفاء نهائياً
    if ((pathname === '/api/dismiss-failed' || pathname === '/api/logs/dismiss-all') && req.method === 'POST') {
      try {
        let count = 0;
        for (let i = activityLogs.length - 1; i >= 0; i--) {
          if (activityLogs[i].status === 'review') {
            const fName = activityLogs[i].fileName;
            if (fName) {
              if (!processedRegistry[fName]) processedRegistry[fName] = {};
              processedRegistry[fName].dismissed = true;
              processedRegistry[fName].status = 'dismissed';
            }
            activityLogs.splice(i, 1);
            count++;
          }
        }
        for (const [k, v] of Object.entries(processedRegistry)) {
          if (v && v.status === 'review') {
            v.dismissed = true;
            v.status = 'dismissed';
          }
        }
        try {
          saveProcessedRegistry();
        } catch (_) {}
        console.log(`🧹 تم إخفاء كافة المستندات المتعثرة بنجاح وحفظ الحالة نهائياً (${count} مستند).`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, count, remaining: activityLogs.length }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
      return;
    }

    // API: تجاهل / إخفاء مستند فردي من السجل وحذف تنبيهه نهائياً
    if ((pathname === '/api/dismiss-log' || pathname === '/api/logs/dismiss') && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { id, logId, fileName } = parseSafeJson(body);
          const targetId = id || logId;
          let removed = false;
          let targetFile = fileName;
          for (let i = activityLogs.length - 1; i >= 0; i--) {
            if ((targetId && activityLogs[i].id === targetId) || (fileName && activityLogs[i].fileName === fileName)) {
              if (!targetFile && activityLogs[i].fileName) targetFile = activityLogs[i].fileName;
              activityLogs.splice(i, 1);
              removed = true;
            }
          }
          if (targetFile) {
            if (!processedRegistry[targetFile]) processedRegistry[targetFile] = {};
            processedRegistry[targetFile].dismissed = true;
            processedRegistry[targetFile].status = 'dismissed';
            try {
              saveProcessedRegistry();
            } catch (_) {}
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, removed, count: activityLogs.length }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
      });
      return;
    }

    // API: إعادة محاولة إرسال مستند متعثر
    if ((pathname === '/api/retry-document' || pathname === '/api/retry-invoice') && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { fileName, filePath, overrideCustomerNumber } = parseSafeJson(body);
          const resolvedPath = findDocumentPath(fileName, filePath);
          if (!resolvedPath || !fs.existsSync(resolvedPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'الملف غير موجود على القرص' }));
            return;
          }

          const result = await retryDocumentSending(resolvedPath, overrideCustomerNumber);
          if (result.success) {
            // حذف سجل التعثر القديم لهذا الملف
            const baseName = path.basename(resolvedPath);
            for (let i = activityLogs.length - 1; i >= 0; i--) {
              if (activityLogs[i].fileName === baseName && activityLogs[i].status === 'review') {
                activityLogs.splice(i, 1);
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'تم إرسال المستند بنجاح' }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: false, 
              message: result.reason,
              uniqueNumbers: result.uniqueNumbers || []
            }));
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: err.message }));
        }
      });
      return;
    }

    // API: إيقاف البرنامج (يعمل في الخلفية بدون نافذة سوداء، فهذا هو طريق إيقافه)
    if (pathname === '/api/shutdown' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      console.log('🛑 تم طلب إيقاف البرنامج من الواجهة.');
      setTimeout(async () => {
        try { if (client) await client.destroy(); } catch (_) {}
        process.exit(0);
      }, 500);
      return;
    }

    // API: الأجهزة المرتبطة ورمز الربط
    if (pathname === '/api/devices' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(relayServer
        ? { enabled: true, serverName: CONFIG.deviceName, pairingCode: relayServer.getPairingCode(), devices: relayServer.listDevices() }
        : { enabled: false, devices: [] }));
      return;
    }

    if (pathname === '/api/devices/new-code' && req.method === 'POST') {
      if (!relayServer) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false })); return; }
      const code = relayServer.regeneratePairingCode();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, pairingCode: code }));
      return;
    }

    if (pathname.startsWith('/api/devices/') && req.method === 'DELETE') {
      const id = decodeURIComponent(pathname.slice('/api/devices/'.length));
      const ok = !!(relayServer && relayServer.removeDevice(id));
      if (ok) console.log(`🗑 تم إلغاء ربط جهاز (${id})`);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: ok }));
      return;
    }

    // API: الإعدادات
    if (pathname === '/api/settings') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          hosted: HOSTED,
          invoicesDir: CONFIG.invoicesDir,
          delayMs: CONFIG.delayMs,
          testPhone: CONFIG.testPhone,
          captions: currentSettings.captions,
          sendDocTypes: CONFIG.sendDocTypes,
          // النص الأصلي لكل نوع (يُرسل إذا تُركت الخانة فاضية) — يظهر في الخانة باللون الرمادي
          defaultCaptions: Object.fromEntries(Object.values(DOC_TYPES).map(d => [d.id, d.defaultCaption]))
        }));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.delayMs !== undefined) {
              CONFIG.delayMs = Number(data.delayMs) || 5000;
              currentSettings.delayMs = CONFIG.delayMs;
            }
            if (typeof data.testPhone === 'string') {
              CONFIG.testPhone = data.testPhone.trim();
              currentSettings.testPhone = CONFIG.testPhone;
            }
            if (data.captions) {
              currentSettings.captions = Object.assign(currentSettings.captions || {}, data.captions);
              CONFIG.captions = currentSettings.captions;
            }
            if (data.sendDocTypes && typeof data.sendDocTypes === 'object') {
              for (const k of ['invoice', 'clearance', 'return', 'statement']) {
                if (typeof data.sendDocTypes[k] === 'boolean') CONFIG.sendDocTypes[k] = data.sendDocTypes[k];
              }
              currentSettings.sendDocTypes = { ...CONFIG.sendDocTypes };
              console.log(`⚙ أنواع المستندات المرسلة: ${Object.entries(CONFIG.sendDocTypes).map(([k, v]) => `${DOC_TYPE_PLURAL[k]} ${v ? '✅' : '⏸ موقوف'}`).join('، ')}`);
            }
            if (data.warehouse && typeof data.warehouse === 'object') {
              // على السيرفر الربط مع الموقع تلقائي: ما يتغير من الشاشة
              const w = HOSTED ? { ...data.warehouse, siteUrl: undefined, apiKey: undefined, clearApiKey: undefined } : data.warehouse;
              applyWarehouseSettings(w);
            }

            // تغيير مكان حفظ الفواتير (يُطبّق بإعادة تشغيل البرنامج) — على السيرفر مجلده ثابت
            let restartForFolder = false;
            if (!HOSTED && typeof data.invoicesDir === 'string' && data.invoicesDir.trim()) {
              const dir = path.resolve(data.invoicesDir.trim());
              if (!path.isAbsolute(data.invoicesDir.trim())) throw new Error('المسار يجب أن يكون كاملاً (مثل D:\\Invoices)');
              fs.mkdirSync(dir, { recursive: true });
              const probe = path.join(dir, `.write-test-${Date.now()}`);
              fs.writeFileSync(probe, 'ok');
              fs.unlinkSync(probe);
              if (path.resolve(CONFIG.invoicesDir).toLowerCase() !== dir.toLowerCase()) {
                currentSettings.invoicesDir = dir;
                restartForFolder = true;
                console.log(`📂 تم تغيير مكان حفظ الفواتير إلى: ${dir}`);
              }
            }

            saveSettingsFile(currentSettings);
            const canRestart = process.env.ALWADY_LAUNCHER === '1';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              settings: { ...currentSettings, warehouseApiKey: undefined },
              restarting: restartForFolder && canRestart,
              restartRequired: restartForFolder && !canRestart
            }));
            if (restartForFolder && canRestart) restartApp();
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: err.message }));
          }
        });
        return;
      }
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  // لوحة التحكم تفتح من هذا الجهاز فقط (127.0.0.1) حتى لا يغيّر أحد على الشبكة الإعدادات
  const dashboardHost = CONFIG.dashboardHost;
  const dashboardUrl = `http://${dashboardHost === '0.0.0.0' ? 'localhost' : dashboardHost}:${port}`;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠ المنفذ ${port} مستخدم بالفعل (البرنامج يعمل مسبقاً في الخلفية).`);
      openDesktopWindow(dashboardUrl);
    } else {
      console.error('❌ خطأ في خادم الويب:', err.message);
    }
  });

  server.listen(port, dashboardHost, () => {
    console.log(`🌐 خادم لوحة التحكم متاح الآن على: ${dashboardUrl}`);
    openDesktopWindow(dashboardUrl);
  });

  return server;
}

/**
 * فتح نافذة البرنامج المستقلة على سطح المكتب (Desktop Window)
 */
// إعادة تشغيل البرنامج (عند التشغيل من تشغيل.exe): رمز الخروج 75 يجعل المشغّل يعيد تشغيله فوراً
const RESTART_FLAG = path.join(__dirname, '.restart-flag');
const startedAfterRestart = (() => {
  try { if (fs.existsSync(RESTART_FLAG)) { fs.unlinkSync(RESTART_FLAG); return true; } } catch (_) {}
  return false;
})();

function restartApp() {
  console.log('🔄 جاري إعادة تشغيل البرنامج...');
  try { fs.writeFileSync(RESTART_FLAG, String(Date.now())); } catch (_) {}
  setTimeout(async () => {
    try { if (client) await client.destroy(); } catch (_) {}
    process.exit(75);
  }, 800);
}

function openDesktopWindow(url) {
  if (process.env.ALWADY_NO_WINDOW === '1') return; // للاختبارات فقط
  if (startedAfterRestart) return; // النافذة مفتوحة أصلاً وستُحدّث نفسها
  // PowerShell مخفي يفتح نافذة البرنامج بشكل طبيعي (Edge ثم Chrome ثم المتصفح الافتراضي)
  const u = String(url).replace(/'/g, "''");
  const ps = `
    try { Start-Process msedge -ArgumentList '--app=${u}','--window-size=1200,800' -ErrorAction Stop }
    catch { try { Start-Process chrome -ArgumentList '--app=${u}','--window-size=1200,800' -ErrorAction Stop } catch { Start-Process '${u}' } }
  `;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  childProcess.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true }, () => {});
}

// ==========================================
// بدء تشغيل البرنامج
// ==========================================

/**
 * إعدادات ملف تركيب الطابعة (site-install.json في مجلد البرنامج): عنوان الموقع + مفتاح الفرع.
 * يكتبها ملف التركيب من السطر اللي في آخره (ملف "تركيب الطابعة - فرع X" من صفحة أجهزة المحاسبين).
 * @returns {{siteUrl: string, installKey: string, branch: string, id: string} | null}
 */
function readInstallConfig(file = path.join(__dirname, 'site-install.json')) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (!c || typeof c.siteUrl !== 'string' || typeof c.installKey !== 'string' || !c.installKey) return null;
    const id = require('crypto').createHash('sha256').update(`${c.siteUrl}\n${c.installKey}`).digest('hex').slice(0, 16);
    return { siteUrl: c.siteUrl, installKey: c.installKey, branch: String(c.branch || ''), id };
  } catch (_) {
    return null;
  }
}

/**
 * وضع "جهاز فرعي": بدون واتساب. يستقبل الطباعة ويرفعها للجهاز الرئيسي.
 * الواجهة صفحة عادية (مثل الجهاز الرئيسي) بدل النافذة السوداء: رمز الربط، الحالة، وآخر العمليات.
 */
async function startClientMode() {
  const { RelayClient } = require('./relay-client');
  const credsFile = path.join(__dirname, 'client-device.json');
  console.log(`🖥 جهاز فرعي: ${CONFIG.deviceName} — مجلد الصادر: ${CONFIG.clientOutboxDir}`);

  // آخر العمليات لعرضها في الصفحة
  const events = [];
  const pushEvent = (level, text) => {
    events.unshift({ time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), level, text: String(text) });
    if (events.length > 100) events.pop();
  };
  const uiLog = {
    log: (m) => { console.log(m); pushEvent('info', m); },
    warn: (m) => { console.warn(m); pushEvent('warn', m); },
    error: (m) => { console.error(m); pushEvent('error', m); }
  };

  const { SiteRelayClient } = require('./site-relay-client');
  const savedMode = () => { try { return JSON.parse(fs.readFileSync(credsFile, 'utf8')).mode || 'lan'; } catch (_) { return 'lan'; } };
  const withReviewAlert = (c) => {
    // تنبيه ويندوز للمحاسب: المستند لم يُرسل ويحتاج مراجعة في الجهاز الرئيسي
    c.onReview = (fileName, reason) => notifier.notifyReview(fileName, reason);
    return c;
  };
  // ملف تركيب الطابعة للفرع: فيه عنوان الموقع ومفتاح الفرع => الجهاز يتسجّل في الموقع لحاله (بدون رموز)
  const installCfg = readInstallConfig();
  // جهاز في فرع بعيد (مربوط عن طريق موقع المستودع) أو جهاز داخل شبكة الجهاز الرئيسي
  const makeClient = () => withReviewAlert((installCfg || savedMode() === 'site')
    ? new SiteRelayClient({ credsFile, outboxDir: CONFIG.clientOutboxDir, siteUrl: installCfg ? installCfg.siteUrl : '', deviceName: CONFIG.deviceName, log: uiLog })
    : new RelayClient({
      credsFile,
      outboxDir: CONFIG.clientOutboxDir,
      serverAddress: CONFIG.serverAddress,
      relayPort: CONFIG.relayPort,
      discoveryPort: CONFIG.discoveryPort,
      deviceName: CONFIG.deviceName,
      log: uiLog
    }));
  let relayClient = makeClient();
  let printingStarted = false;

  async function startWorking() {
    const rc = relayClient; // نفس الربط من البداية للنهاية (لو أُلغي الربط أثناء التشغيل لا يُشغَّل الجديد غير المرتبط)
    if (!printingStarted && CONFIG.printCaptureEnabled) {
      printingStarted = true;
      const printServer = await printCapture.startPrintCaptureInWorker({ targetDir: CONFIG.clientOutboxDir, log: uiLog });
      if (printServer) {
        printCapture.resumeStuckPrintJobs(CONFIG.printerName);
        printCapture.startStuckJobWatcher(CONFIG.printerName);
      }
    }
    if (rc !== relayClient || !rc.isPaired()) return;
    const url = await rc.connect();
    if (rc !== relayClient || !rc.isPaired()) return;
    if (!url) uiLog.warn(rc instanceof SiteRelayClient
      ? '⏳ موقع المستودع غير متاح الآن (أو ما فيه إنترنت). يمكنك الطباعة عادي، وستُرسل المستندات تلقائياً عند رجوعه.'
      : '⏳ الجهاز الرئيسي غير متاح الآن. يمكنك الطباعة عادي، وستُرسل المستندات تلقائياً عند توفره.');
    rc.start();
    uiLog.log(`🖨 جاهز: اطبع أي فاتورة أو كشف على طابعة "${CONFIG.printerName}".`);
  }

  function saveServerAddress(address) {
    const a = String(address || '').trim();
    if (a === CONFIG.serverAddress) return;
    CONFIG.serverAddress = a;
    currentSettings.serverAddress = a;
    saveSettingsFile(currentSettings);
    relayClient.serverAddress = a;
    relayClient.serverUrl = null;
  }

  const readBody = (req) => new Promise((resolve) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
  });
  const sendJson = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

  const uiServer = http.createServer(async (req, res) => {
    // نفس حماية الجهاز الرئيسي: لا أوامر إلا من صفحة البرنامج نفسها
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(req.headers.host || ''))) { res.writeHead(403); res.end(); return; }
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(origin))) { sendJson(res, 403, { ok: false }); return; }

    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(__dirname, 'public', 'client.html')));
        return;
      }
      if (req.method === 'GET' && pathname === '/logo.png') {
        const logo = path.join(__dirname, 'public', 'logo.png');
        if (fs.existsSync(logo)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(fs.readFileSync(logo)); return; }
      }
      if (req.method === 'GET' && pathname === '/api/client/status') {
        // صفحة الموظف: بدون أي تفاصيل مستندات أو عملاء (فقط هل الجهاز مربوط)
        const viaSite = relayClient instanceof SiteRelayClient;
        return sendJson(res, 200, {
          printerName: CONFIG.printerName,
          paired: relayClient.isPaired(),
          unlinked: !!relayClient.unlinked,
          connected: !!relayClient.serverUrl,
          serverAddress: CONFIG.serverAddress,
          mode: viaSite ? 'site' : 'lan',
          branch: viaSite ? relayClient.branch : null,
          siteUrl: viaSite ? relayClient.siteUrl : null
        });
      }
      if (req.method === 'POST' && pathname === '/api/client/pair') {
        const body = await readBody(req);
        // فرع بعيد: الربط عن طريق موقع المستودع برمز من صفحة "أجهزة الفروع"
        if (body.mode === 'site') {
          const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (code.length !== 8) return sendJson(res, 400, { ok: false, reason: 'bad_code' });
          const sc = withReviewAlert(new SiteRelayClient({ credsFile: `${credsFile}.pairing`, outboxDir: CONFIG.clientOutboxDir, deviceName: CONFIG.deviceName, log: uiLog }));
          uiLog.log('🔍 جاري الربط بموقع المستودع...');
          const r = await sc.pair(code, String(body.siteUrl || ''));
          if (r.ok) {
            await relayClient.stop(); // ينتظر انتهاء أي رفع جارٍ بالطريقة القديمة
            fs.renameSync(`${credsFile}.pairing`, credsFile);
            sc.credsFile = credsFile;
            relayClient = sc;
            uiLog.log(`✅ تم ربط هذا الجهاز بموقع المستودع — فرع ${r.branch}.`);
            startWorking().catch(e => uiLog.error(`❌ ${e.message}`));
          } else if (r.reason === 'wrong_code') uiLog.warn('❌ رمز الربط غير صحيح أو انتهت صلاحيته.');
          else if (r.reason === 'bad_url') uiLog.warn(`❌ ${r.message}`);
          else uiLog.warn('❌ تعذر الوصول لموقع المستودع. تأكد من الرابط والإنترنت.');
          return sendJson(res, 200, r);
        }
        const code = String(body.code || '').replace(/\D/g, '');
        if (code.length !== 6) return sendJson(res, 400, { ok: false, reason: 'bad_code' });
        if (typeof body.serverAddress === 'string') saveServerAddress(body.serverAddress);
        // كان مربوط عن طريق الموقع ورجع يتربط داخل الشبكة
        if (relayClient instanceof SiteRelayClient) {
          await relayClient.stop();
          try { fs.unlinkSync(credsFile); } catch (_) {}
          relayClient = makeClient();
        }
        uiLog.log('🔍 جاري البحث عن الجهاز الرئيسي في الشبكة...');
        const r = await relayClient.pair(code);
        if (r.ok) {
          relayClient.unlinked = false;
          uiLog.log(`✅ تم ربط هذا الجهاز بالجهاز الرئيسي (${r.serverName}).`);
          startWorking().catch(e => uiLog.error(`❌ ${e.message}`));
        } else if (r.reason === 'wrong_code') uiLog.warn('❌ رمز الربط غير صحيح.');
        else if (r.reason === 'not_found') uiLog.warn('❌ لم يتم العثور على الجهاز الرئيسي على الشبكة.');
        return sendJson(res, 200, r);
      }
      if (req.method === 'POST' && pathname === '/api/client/unpair') {
        await relayClient.stop(); // ينتظر انتهاء أي رفع جارٍ
        try { fs.unlinkSync(credsFile); } catch (_) {}
        relayClient = makeClient();
        uiLog.log('🔗 تم إلغاء الربط. أدخل رمز الربط الظاهر في الجهاز الرئيسي.');
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && pathname === '/api/shutdown') {
        sendJson(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 300);
        return;
      }
      res.writeHead(404); res.end();
    } catch (err) {
      sendJson(res, 500, { ok: false, message: err.message });
    }
  });

  const uiUrl = `http://127.0.0.1:${CONFIG.clientUiPort}`;
  notifier.configure({ url: uiUrl });
  await new Promise((resolve) => {
    uiServer.once('error', (e) => { console.error(`❌ تعذر تشغيل صفحة البرنامج: ${e.message}`); resolve(); });
    uiServer.listen(CONFIG.clientUiPort, '127.0.0.1', () => { console.log(`🌐 صفحة البرنامج: ${uiUrl}`); resolve(); });
  });
  if (installCfg) {
    // ملف الطابعة للفرع: بدون أي نافذة. الطباعة تشتغل على طول (المطبوع ينحفظ لين يتسجّل الجهاز)،
    // والجهاز يتسجّل في الموقع لحاله، ولو الموقع ما يرد يعيد المحاولة.
    await startWorking();
    await keepEnrolled(installCfg);
    return;
  }

  // الصفحة تفتح تلقائياً فقط إذا الجهاز غير مربوط (يحتاج كود). المربوط يشتغل بالخلفية بدون نوافذ،
  // ويفتحها الموظف من اختصار سطح المكتب إذا بغى.
  if (!relayClient.isPaired()) openDesktopWindow(uiUrl);

  if (relayClient.isPaired()) await startWorking();
  else uiLog.log('🔗 هذا الجهاز غير مرتبط بالجهاز الرئيسي بعد. أدخل رمز الربط في الأعلى.');

  /**
   * التسجيل التلقائي: أول تشغيل، أو بعد تركيب ملف فرع ثاني، أو لو الموقع قطع مفتاح الجهاز
   * (مثلاً الإدارة أوقفته ثم شغّلته). الموقع ما يرد => يعيد بعد دقيقة. الملف قديم أو الجهاز موقوف => كل 30 دقيقة.
   */
  async function keepEnrolled(cfg) {
    const needsEnroll = () => !relayClient.isPaired() || relayClient.creds.installId !== cfg.id || relayClient.unlinked;
    let lastReason = null;
    const attempt = async () => {
      if (!needsEnroll()) return 60 * 1000;
      const wasWorking = relayClient.isPaired();
      const r = await relayClient.enroll(cfg.installKey, cfg.siteUrl, cfg.id);
      if (r.ok) {
        lastReason = null;
        uiLog.log(`✅ هذا الجهاز مسجّل في موقع المستودع — فرع ${r.branch}.`);
        if (!wasWorking) await startWorking();
        return 60 * 1000;
      }
      if (r.reason !== lastReason) {
        if (r.reason === 'stopped') uiLog.error('⛔ الإدارة أوقفت هذا الجهاز من صفحة "أجهزة المحاسبين".');
        else if (r.reason === 'wrong_key') uiLog.error('❌ ملف الطابعة هذا قديم. حمّل ملف الفرع الجديد من الموقع وركّبه.');
        else if (r.reason === 'bad_url') uiLog.error(`❌ عنوان الموقع في ملف الطابعة غير صحيح: ${r.message || ''}`);
        else uiLog.warn('⏳ موقع المستودع غير متاح الآن. الطباعة شغالة، والمستندات تنرسل أول ما يرجع.');
        lastReason = r.reason;
      }
      return r.reason === 'not_found' || r.reason === 'too_many_attempts' ? 60 * 1000 : 30 * 60 * 1000;
    };
    const loop = async () => {
      let wait = 60 * 1000;
      try { wait = await attempt(); } catch (e) { uiLog.error(`❌ ${e.message}`); }
      const t = setTimeout(loop, wait);
      if (t.unref) t.unref();
    };
    await loop();
  }
}

let relayServer = null;

async function startRelayServer() {
  const { createRelayServer } = require('./relay-server');
  try {
    relayServer = createRelayServer({
      port: CONFIG.relayPort,
      host: CONFIG.relayHost,
      discoveryPort: CONFIG.discoveryPort,
      inboxDir: CONFIG.invoicesDir,
      dataDir: __dirname,
      serverName: CONFIG.deviceName,
      getOutcome
    });
    await relayServer.ready;
    console.log(`🔗 استقبال المستندات من الأجهزة الأخرى يعمل (رمز الربط الحالي: ${relayServer.getPairingCode()})`);
  } catch (err) {
    relayServer = null;
    console.warn(`⚠ تعذر تشغيل استقبال المستندات من الأجهزة الأخرى: ${err.message}`);
  }
}

/**
 * قفل "نسخة واحدة فقط على الجهاز": أنبوب باسم ثابت لا يمكن أن يملكه برنامجان.
 * يُحرَّر تلقائياً عند إغلاق البرنامج (لا يبقى قفل عالق بعد انقطاع الكهرباء مثلاً).
 */
function acquireSingleInstanceLock(role) {
  return new Promise((resolve) => {
    const lock = require('net').createServer();
    lock.once('error', () => resolve(null));
    // على السيرفر: منفذ داخلي بدل أنبوب ويندوز (ينفك لحاله لو البرنامج طاح، فما يبقى قفل عالق)
    if (HOSTED) {
      lock.listen(Number(process.env.ALWADY_LOCK_PORT) || (Number(CONFIG.port) + 1000), '127.0.0.1', () => resolve(lock));
      return;
    }
    const testSuffix = process.env.ALWADY_TEST_LOCK ? `-${process.env.ALWADY_TEST_LOCK}` : ''; // للاختبارات فقط
    lock.listen(`\\\\.\\pipe\\alwady-invoice-${role}-instance-lock${testSuffix}`, () => resolve(lock));
  });
}

async function start() {
  const lock = await acquireSingleInstanceLock(CONFIG.mode === 'client' ? 'client' : 'server');
  if (!lock) {
    console.warn('⚠ البرنامج يعمل بالفعل على هذا الجهاز. لن تُفتح نسخة ثانية (حتى لا يُرسل أي مستند مرتين).');
    // فتح نافذة النسخة الشغالة بدل تشغيل نسخة ثانية
    openDesktopWindow(`http://127.0.0.1:${CONFIG.mode === 'client' ? CONFIG.clientUiPort : CONFIG.port}`);
    setTimeout(() => process.exit(0), 1500);
    return;
  }

  if (CONFIG.mode === 'client') return startClientMode();

  console.log('=======================================================');
  console.log(`   نظام إرسال الفواتير والفسوحات والمرتجعات (${HOSTED ? 'على السيرفر داخل موقع المستودع' : 'Desktop App'})   `);
  console.log('=======================================================');
  console.log(`📂 مجلد المراقبة : ${CONFIG.invoicesDir}`);
  console.log(`👥 وجهة الإرسال : قروب واتساب يحتوي اسمه على رقم العميل (تحديث القائمة كل ${CONFIG.groupsRefreshMinutes} دقيقة)`);
  console.log(`⏱ مهلة التأخير  : ${CONFIG.delayMs} مللي ثانية`);
  console.log('📶 اتصال واتساب : مباشر بدون متصفح');
  if (CONFIG.testPhone) {
    console.log(`🧪 وضع التجربة  : مفعّل — كل المستندات تُرسل للرقم (${CONFIG.testPhone})`);
  }
  if (CONFIG.dryRun) {
    console.log('🧪 تشغيل تجريبي : مفعّل (dryRun) — لن يُرسل أي شيء ولن تُنقل الملفات، فقط تسجيل القروب المستهدف');
  }
  console.log(`🔍 وضع التصحيح  : ${CONFIG.debug ? 'مفعّل' : 'معطّل'}`);
  console.log('-------------------------------------------------------');

  ensureDirectories();
  await recoverInterruptedSends();
  await syncExistingReviewFiles();

  // استقبال المستندات المطبوعة على طابعة البرنامج
  if (CONFIG.printCaptureEnabled) {
    const printServer = await printCapture.startPrintCaptureInWorker({ targetDir: CONFIG.invoicesDir });
    if (printServer) {
      printCapture.resumeStuckPrintJobs(CONFIG.printerName);
      printCapture.startStuckJobWatcher(CONFIG.printerName);
    }
  }

  // الضغط على أي تنبيه ويندوز يفتح نافذة البرنامج
  notifier.configure({ url: `http://127.0.0.1:${CONFIG.port}` });

  // تشغيل خادم لوحة التحكم ونافذة سطح المكتب
  startWebServer(CONFIG.port);

  // رفع الفسوحات المنتظرة لموقع المستودع (يعمل في الخلفية ومستقل عن واتساب)
  warehouseSync().start();
  // رسائل العملاء من الموقع + نبضة حالة واتساب (كل 10 ثواني / كل دقيقة)
  warehouseNotifier().start();
  // مستندات الفروع البعيدة من صندوق الموقع (كل 10 ثواني)
  siteRelayInbox().start();
  if (warehouseNumbers().length > 0 || CONFIG.warehouseSiteUrl) {
    const nums = [CONFIG.warehouseNumber ? `قروب المستودع [${CONFIG.warehouseNumber}]` : null, ...Object.entries(CONFIG.warehouseBranchNumbers || {}).map(([b, n]) => `قروب فرع ${b} [${n}]`)].filter(Boolean);
    console.log(`🏬 المستودع      : الفسح يذهب إلى ${[nums.join('، ') || null, isWarehouseSiteConfigured() ? `الموقع (${CONFIG.warehouseSiteUrl})` : null].filter(Boolean).join(' + ') || '— (الإعدادات ناقصة)'}`);
  }

  // استقبال المستندات من الأجهزة الأخرى (الإرسال يتم من واتساب هذا الجهاز فقط)
  if (CONFIG.relayEnabled) await startRelayServer();

  // تشغيل عميل واتساب فائق السرعة مع المراقبة وإعادة المحاولة التلقائية
  console.log('⏳ جاري تشغيل المتصفح فائق السرعة وتهيئة عميل واتساب...');
  startWhatsAppClient();

  // تشغيل مراقب المجلد وفحص الملفات غير المعالجة
  initWatcher();
  scanAndEnqueuePendingInvoices();
}

// إغلاق نظيف للمتصفح عند إيقاف البرنامج لمنع بقاء lockfile عالقاً
process.on('SIGINT', async () => {
  console.log('\n🛑 جاري إيقاف البرنامج وتنظيف جلسة المتصفح بنظافة...');
  if (client) {
    try { await client.destroy(); } catch (_) {}
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (client) {
    try { await client.destroy(); } catch (_) {}
  }
  process.exit(0);
});

if (require.main === module) {
  start();
}

module.exports = {
  CONFIG,
  DOC_TYPES,
  detectDocumentType,
  normalizeArabicText,
  extractCustomerNumber,
  extractSalesOrderNumber,
  extractClearanceCustomerNumber,
  extractClearanceData,
  extractClearanceItems,
  customerFileName,
  extractCustomerNumbersByLayout,
  buildVisualLines,
  readInstallConfig,
  extractAccountCustomerNumbers,
  normalizePhone,
  parsePdf,
  ensureDirectories,
  safeMoveFile,
  moveToSent,
  moveToReview,
  handleInvoice,
  enqueue,
  processQueue,
  getWhatsAppClient,
  startWebServer,
  addActivityLog,
  loadGroups,
  retryDocumentSending,
  recoverInterruptedSends,
  markFileAsProcessed,
  restartWhatsAppClient,
  customerReports,
  listCashPending,
  markCashPrinted,
  warehouseSync,
  buildClearanceMeta,
  warehouseCaption,
  deliverClearanceToWarehouse,
  queueWaitingClearancesForSite,
  applyWarehouseSettings,
  getWarehouseSummary,
  isWarehouseRouteActive,
  warehouseNotifier,
  siteRelayInbox,
  branchOf,
  warehouseGroupFor,
  warehouseNumbers,
  sourceDeviceOf,
  getOutcome,
  deliverCustomerMessage,
  enqueueCustomerMessage,
  // للاختبارات فقط: محاكاة اتصال واتساب بدون شبكة
  _test: {
    runRemoteCommand,
    importCustomersFromSite,
    customerReportSnapshot,
    setWhatsApp({ ready, fakeClient, media }) {
      isWhatsAppReady = !!ready;
      client = fakeClient || null;
      if (media) MessageMedia = media;
    },
    setGroups(groups) { allGroups = groups || []; rebuildGroupIndex(); },
    planDelivery: (n) => planDelivery(n),
    customerGroupCount: () => (groupIndex ? groupIndex.valid.length : 0),
    queue,
    messageQueue,
    processedRegistry
  }
};
