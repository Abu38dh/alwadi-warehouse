/**
 * make-client-package.js
 *
 * يجهّز مجلد "client-package" فيه فقط ما يحتاجه الجهاز الفرعي:
 *  - بدون جلسة واتساب (.baileys_auth) ولا سجلات ولا فواتير ولا كلمة مرور الأدمن.
 *  - بدون مكتبات واتساب وChrome (أخف وأسرع في التثبيت).
 *
 * الاستخدام:  npm run make-client-package
 * ثم انسخ مجلد client-package إلى الجهاز الفرعي.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'client-package');

// كل ملف يطلبه index.js عند التشغيل لازم يكون هنا، وإلا الجهاز الفرعي يتعطل بعد التثبيت
const CODE_FILES = ['index.js', 'group-matcher.js', 'notify.js', 'customer-report.js', 'xlsx-writer.js', 'print-capture.js', 'relay-server.js', 'relay-client.js', 'site-relay-client.js', 'site-relay-inbox.js', 'warehouse-sync.js', 'warehouse-notify.js', 'printer-setup.js', 'device-setup.js'];

function bat(title, body) {
  return ['@echo off', 'chcp 65001 > nul', `title ${title}`, 'cd /d "%~dp0"', ...body, 'echo.', 'pause', ''].join('\r\n');
}

/**
 * @param {string} [outDir]
 * @param {{settingsFileName?: string, withBatFiles?: boolean}} [opts]
 *   settingsFileName: في نسخة exe تُحفظ الإعدادات باسم settings.default.json حتى لا يمسح التحديث إعدادات الجهاز
 */
function build(outDir = OUT, { settingsFileName = 'settings.json', withBatFiles = true } = {}) {
  const OUT = outDir;
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  for (const f of CODE_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
  // صفحة الجهاز الفرعي وشعار الشركة
  fs.mkdirSync(path.join(OUT, 'public'), { recursive: true });
  for (const f of ['client.html', 'logo.png']) fs.copyFileSync(path.join(ROOT, 'public', f), path.join(OUT, 'public', f));

  const mainPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const pkg = {
    name: 'invoice-sender-client',
    version: mainPkg.version,
    description: 'جهاز فرعي: طباعة المستندات وإرسالها للجهاز الرئيسي (الإرسال عبر واتساب يتم من الجهاز الرئيسي)',
    main: 'index.js',
    private: true,
    scripts: { start: 'node index.js', 'setup-client': 'node device-setup.js client', 'printer-status': 'node printer-setup.js status' },
    dependencies: { chokidar: mainPkg.dependencies.chokidar, 'pdf-parse': mainPkg.dependencies['pdf-parse'] }
  };
  fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  const main = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.json'), 'utf8')); } catch (_) { return {}; } })();
  const settings = {
    mode: 'client',
    printerName: main.printerName || 'WhatsApp Sender',
    printCaptureEnabled: true,
    relayPort: main.relayPort || 3501,
    discoveryPort: main.discoveryPort || 3502,
    serverAddress: ''
  };
  fs.writeFileSync(path.join(OUT, settingsFileName), JSON.stringify(settings, null, 2) + '\n');
  if (!withBatFiles) return settings;

  fs.writeFileSync(path.join(OUT, '1-تثبيت.bat'), bat('Install', [
    'echo [1/2] Installing libraries...',
    'call npm.cmd install --omit=dev',
    'if errorlevel 1 (echo FAILED - is Node.js installed? & pause & exit /b 1)',
    'echo [2/2] Installing printer...',
    'node device-setup.js client'
  ]));
  fs.writeFileSync(path.join(OUT, '2-تشغيل.bat'), bat('Invoice Sender - Client', ['node index.js']));

  fs.writeFileSync(path.join(OUT, 'اقرأني.txt'), [
    'جهاز فرعي — نظام إرسال المستندات',
    '====================================',
    '',
    'هذا الجهاز لا يرسل واتساب بنفسه. يطبع المستندات ويرسلها للجهاز الرئيسي، والجهاز الرئيسي يرسلها لقروب العميل.',
    '',
    'التثبيت (مرة واحدة):',
    '  1) ثبّت Node.js (نسخة LTS) من الموقع الرسمي nodejs.org إذا لم يكن مثبتاً.',
    '  2) اضغط مرتين على "1-تثبيت.bat" ووافق على طلب صلاحية المسؤول (لتثبيت الطابعة).',
    '',
    'التشغيل:',
    '  3) اضغط مرتين على "2-تشغيل.bat".',
    '  4) أول مرة فقط: أدخل رمز الربط الظاهر في الجهاز الرئيسي (الإعدادات ← الأجهزة المرتبطة).',
    '',
    'الاستخدام:',
    '  من برنامج المحاسبة اطبع على الطابعة "' + settings.printerName + '". النتيجة تظهر في نافذة البرنامج.',
    '  إذا كان الجهاز الرئيسي مغلقاً، تنتظر المستندات وتُرسل تلقائياً عند تشغيله.',
    '',
    'إذا لم يجد الجهاز الرئيسي تلقائياً: اكتب اسم الجهاز الرئيسي في settings.json في "serverAddress".',
    ''
  ].join('\r\n'), 'utf8');

  console.log(`✅ تم تجهيز حزمة الجهاز الفرعي في: ${OUT}`);
  console.log('   انسخ هذا المجلد كاملاً إلى الجهاز الفرعي، ثم اتبع ملف "اقرأني.txt".');
  console.log('   (لا يحتوي على جلسة واتساب ولا على أي بيانات أو فواتير من هذا الجهاز)');
}

if (require.main === module) build();

module.exports = { build, OUT };
