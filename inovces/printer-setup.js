/**
 * printer-setup.js
 *
 * تثبيت / إزالة / فحص طابعة البرنامج (بدون أي برنامج PDF خارجي).
 * الطابعة مبنية على طابعة ويندوز المدمجة "Microsoft Print To PDF" ومنفذها أنبوب داخلي يستمع عليه البرنامج.
 *
 * الاستخدام:
 *   npm run install-printer     (يطلب صلاحية المسؤول مرة واحدة)
 *   npm run uninstall-printer
 *   npm run printer-status
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DEFAULT_PIPE_NAME } = require('./print-capture');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

function getPrinterName() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (s.printerName && String(s.printerName).trim()) return String(s.printerName).trim();
  } catch (_) {}
  return 'WhatsApp Sender';
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function runPowerShell(script) {
  const encoded = Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${script}`, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true
  });
}

function isAdmin() {
  try {
    const out = runPowerShell('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)');
    return out.trim().toLowerCase() === 'true';
  } catch (_) {
    return false;
  }
}

/**
 * تشغيل سكربت بصلاحية المسؤول (يظهر طلب الموافقة من ويندوز) وإرجاع ناتجه.
 */
function runElevated(script) {
  if (isAdmin()) return runPowerShell(script);

  const logFile = path.join(os.tmpdir(), `alwady-printer-setup-${Date.now()}.log`);
  const wrapped = `
    try { & { ${script} } *>&1 | Out-File -FilePath ${psQuote(logFile)} -Encoding utf8 }
    catch { "ERROR: $($_.Exception.Message)" | Out-File -FilePath ${psQuote(logFile)} -Encoding utf8 -Append }
  `;
  const innerEncoded = Buffer.from(wrapped, 'utf16le').toString('base64');
  const launcher = `
    $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${innerEncoded}'
    $p.ExitCode
  `;
  try {
    runPowerShell(launcher);
  } catch (err) {
    throw new Error('تم إلغاء طلب صلاحية المسؤول أو تعذر تشغيله');
  }
  let out = '';
  try { out = fs.readFileSync(logFile, 'utf8'); fs.unlinkSync(logFile); } catch (_) {}
  return out;
}

function status(printerName = getPrinterName()) {
  const out = runPowerShell(`
    $p = Get-Printer -Name ${psQuote(printerName)} -ErrorAction SilentlyContinue
    if ($p) { "FOUND|$($p.DriverName)|$($p.PortName)" } else { "MISSING" }
  `).trim();
  if (out.startsWith('FOUND|')) {
    const [, driver, port] = out.split('|');
    return { installed: true, driver, port, correct: port === DEFAULT_PIPE_NAME && /Microsoft Print To PDF/i.test(driver) };
  }
  return { installed: false };
}

/** سكربت تثبيت الطابعة (يحتاج صلاحية المسؤول) — يُستخدم وحده أو مع إعدادات أخرى بطلب موافقة واحد */
function installScript(printerName = getPrinterName()) {
  return `
    $ErrorActionPreference = 'Stop'
    $port = ${psQuote(DEFAULT_PIPE_NAME)}
    $name = ${psQuote(printerName)}
    if (-not (Get-PrinterDriver -Name 'Microsoft Print To PDF' -ErrorAction SilentlyContinue)) { throw 'طابعة Microsoft Print To PDF غير موجودة في ويندوز' }
    if (-not (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue)) { Add-PrinterPort -Name $port }
    $existing = Get-Printer -Name $name -ErrorAction SilentlyContinue
    if ($existing) { Set-Printer -Name $name -PortName $port -DriverName 'Microsoft Print To PDF' }
    else { Add-Printer -Name $name -DriverName 'Microsoft Print To PDF' -PortName $port }
  `;
}

function reportInstall(printerName) {
  const s = status(printerName);
  if (s.installed && s.correct) {
    console.log(`✅ تم تثبيت الطابعة "${printerName}" بنجاح.`);
    console.log('   من برنامج المحاسبة اختر هذه الطابعة عند الطباعة، والبرنامج الرئيسي يجب أن يكون شغالاً.');
    return true;
  }
  console.error('❌ لم يكتمل تثبيت الطابعة.', s.installed ? `(المنفذ الحالي: ${s.port})` : '');
  return false;
}

function install() {
  const printerName = getPrinterName();
  console.log(`🖨 جاري تثبيت طابعة البرنامج "${printerName}" (سيطلب ويندوز موافقة المسؤول)...`);
  const out = runElevated(installScript(printerName) + "\n'OK'");
  if (/ERROR:/.test(out)) console.error(out.trim());
  return reportInstall(printerName);
}

function uninstall() {
  const printerName = getPrinterName();
  console.log(`🗑 جاري إزالة طابعة البرنامج "${printerName}" (سيطلب ويندوز موافقة المسؤول)...`);
  const out = runElevated(`
    $ErrorActionPreference = 'Stop'
    $name = ${psQuote(printerName)}
    $port = ${psQuote(DEFAULT_PIPE_NAME)}
    if (Get-Printer -Name $name -ErrorAction SilentlyContinue) { Remove-Printer -Name $name }
    Start-Sleep -Seconds 1
    if ((Get-PrinterPort -Name $port -ErrorAction SilentlyContinue) -and -not (Get-Printer | Where-Object { $_.PortName -eq $port })) { Remove-PrinterPort -Name $port }
    'OK'
  `);
  if (/ERROR:/.test(out)) console.error(out.trim());
  const s = status(printerName);
  if (!s.installed) {
    console.log('✅ تمت إزالة الطابعة.');
    return true;
  }
  console.error('❌ تعذرت إزالة الطابعة.');
  return false;
}

if (require.main === module) {
  if (process.platform !== 'win32') {
    console.error('❌ هذه الأداة تعمل على ويندوز فقط.');
    process.exit(1);
  }
  const cmd = (process.argv[2] || 'status').toLowerCase();
  try {
    if (cmd === 'install') process.exit(install() ? 0 : 1);
    else if (cmd === 'uninstall') process.exit(uninstall() ? 0 : 1);
    else {
      const name = getPrinterName();
      const s = status(name);
      if (!s.installed) console.log(`ℹ الطابعة "${name}" غير مثبتة. للتثبيت: npm run install-printer`);
      else if (s.correct) console.log(`✅ الطابعة "${name}" مثبتة وجاهزة.`);
      else console.log(`⚠ الطابعة "${name}" موجودة لكن إعدادها غير صحيح (التعريف: ${s.driver}، المنفذ: ${s.port}). أعد التثبيت: npm run install-printer`);
    }
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

module.exports = { install, installScript, reportInstall, uninstall, status, getPrinterName, runPowerShell, runElevated, psQuote };
