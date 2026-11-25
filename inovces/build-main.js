/**
 * build-main.js — يبني ملف تثبيت "برنامج الواتساب" للجهاز الرئيسي في الشركة (التابع لموقع المستودع على الإنترنت):
 *
 *   dist\main-setup.exe     ملف صغير: الموقع يضيف في آخره عنوانه + مفتاح الربط + رابط البرنامج، ويعطيه للإدارة
 *   dist\main-payload.zip   البرنامج كامل (ينرفع مرة على تخزين الموقع، وملف التثبيت يحمّله وقت التثبيت)
 *   dist\main-payload.json  بصمة الملف وحجمه
 *
 * الضغط على ملف التثبيت في الجهاز الرئيسي: يحمّل البرنامج، يوقف البرنامج القديم ويشيله من بدء التشغيل،
 * يثبّت طابعة "WhatsApp Sender"، ويشغّل البرنامج بالخلفية مع ويندوز. بعدها: مسح الباركود من صفحة واتساب في الموقع.
 * تشغيله مرة ثانية = تحديث (البيانات وتسجيل دخول واتساب ما تنمسح).
 *
 * الاستخدام:  node build-main.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { setupSource, compileCs, makeIcon, zipDir, ROOT, DIST, WORK, LAUNCHER_NAME } = require('./build-exe');

const TITLE = 'برنامج واتساب الوادي';
const INSTALL_FOLDER = 'AlwadyWhatsApp';
const SHORTCUT_NAME = 'واتساب الوادي';

// ملفات البرنامج (نفس اللي يشتغل الحين مع الموقع)
const FILES = [
  'index.js', 'customer-report.js', 'group-matcher.js', 'notify.js', 'print-capture.js', 'relay-client.js', 'relay-server.js',
  'site-relay-client.js', 'site-relay-inbox.js', 'wa-baileys.js', 'warehouse-notify.js', 'warehouse-sync.js', 'xlsx-writer.js',
  'printer-setup.js', 'device-setup.js', 'package.json', 'customers-list.default.json'
];

/** "تشغيل.exe": يشغّل البرنامج بالخلفية بإعدادات main.env، ويرجّعه لو توقف. نسخة وحدة بس */
function launcherSource() {
  return `
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
class Launcher {
  [STAThread]
  static int Main() {
    bool created;
    var mutex = new Mutex(true, "Local\\\\AlwadyWhatsAppMain", out created);
    if (!created) return 0;
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    string node = Path.Combine(dir, "node.exe");
    string envFile = Path.Combine(dir, "main.env");
    string logDir = Path.Combine(dir, "logs");
    try { Directory.CreateDirectory(logDir); } catch {}
    while (true) {
      try {
        var psi = new ProcessStartInfo(node, "index.js");
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        if (File.Exists(envFile)) {
          foreach (var line in File.ReadAllLines(envFile, Encoding.UTF8)) {
            int i = line.IndexOf('=');
            if (i > 0) psi.EnvironmentVariables[line.Substring(0, i).Trim()] = line.Substring(i + 1).Trim();
          }
        }
        psi.EnvironmentVariables["ALWADY_LOG_FILE"] = Path.Combine(logDir, "app.log");
        var p = Process.Start(psi);
        p.WaitForExit();
      } catch (Exception e) {
        try { File.AppendAllText(Path.Combine(logDir, "launcher.log"), DateTime.Now.ToString("s") + " " + e.Message + Environment.NewLine); } catch {}
      }
      // توقف لأي سبب (أو طلب إعادة تشغيل من الموقع): يرجع بعد 15 ثانية
      Thread.Sleep(15000);
    }
  }
}`;
}

function installScript() {
  return `
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$SetupLog = $env:ALWADY_SETUP_LOG
function Say($t) {
  Microsoft.PowerShell.Utility\\Write-Host $t
  if ($SetupLog) { [IO.File]::AppendAllText($SetupLog, ([string]$t) + [Environment]::NewLine, [Text.Encoding]::UTF8) }
}
trap {
  Say ('ERROR: ' + $_.Exception.Message)
  exit 1
}
$test = $env:ALWADY_INSTALL_TEST -eq '1'
if (-not $env:ALWADY_INSTALL_CONFIG) { throw 'ملف التثبيت ناقص. حمّله من جديد من موقع المستودع.' }
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ALWADY_INSTALL_CONFIG)) | ConvertFrom-Json
if (-not $cfg.siteUrl -or -not $cfg.apiKey -or -not $cfg.payloadUrl) { throw 'ملف التثبيت ناقص. حمّله من جديد من موقع المستودع.' }
$target = if ($env:ALWADY_INSTALL_DIR) { $env:ALWADY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA '${INSTALL_FOLDER}' }
Say '=== ${TITLE} ==='
Say "مكان التثبيت: $target"

# 1) تحميل البرنامج
$zipPath = Join-Path ([IO.Path]::GetTempPath()) ('alwady-main-' + [guid]::NewGuid().ToString('N') + '.zip')
Say 'جاري تحميل البرنامج...'
if ($env:ALWADY_PAYLOAD_FILE) {
  Copy-Item $env:ALWADY_PAYLOAD_FILE $zipPath
} else {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $wc = New-Object Net.WebClient
  try { $wc.DownloadFile([string]$cfg.payloadUrl, $zipPath) } catch { throw ('تعذر تحميل البرنامج. تأكد من النت وشغّل الملف مرة ثانية. (' + $_.Exception.Message + ')') }
}
if ($cfg.payloadSha256) {
  $hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
  if ($hash -ne ([string]$cfg.payloadSha256).ToLower()) { Remove-Item $zipPath -Force; throw 'الملف نزل ناقص. شغّل ملف التثبيت مرة ثانية.' }
}

# 2) إيقاف النسخة الشغالة من هذا البرنامج (عند التحديث)
function Get-InstalledProcesses {
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $p = $null; try { $p = $_.Path } catch {}; $p -and $p.StartsWith($target, [StringComparison]::OrdinalIgnoreCase) }
}
for ($i = 0; $i -lt 20; $i++) {
  $running = @(Get-InstalledProcesses)
  if ($running.Count -eq 0) { break }
  $running | Sort-Object { if ($_.ProcessName -eq 'node') { 1 } else { 0 } } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}
if (@(Get-InstalledProcesses).Count -gt 0) { throw 'تعذر إيقاف البرنامج الشغال. أعد تشغيل الجهاز ثم شغّل ملف التثبيت مرة أخرى.' }

# 3) فك الملفات (مجلد البيانات data ما ينلمس: تسجيل دخول واتساب والسجل يبقون)
New-Item -ItemType Directory -Force -Path $target | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  foreach ($e in $zip.Entries) {
    $name = $e.FullName -replace '/', '\\'
    $dest = Join-Path $target $name
    if ($name.EndsWith('\\')) { New-Item -ItemType Directory -Force -Path $dest | Out-Null; continue }
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    for ($try = 1; ; $try++) {
      try { [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true); break }
      catch { if ($try -ge 20) { throw "تعذر تحديث الملف $name لأنه مستخدم. أعد تشغيل الجهاز ثم شغّل ملف التثبيت مرة أخرى." }; Start-Sleep -Milliseconds 500 }
    }
  }
} finally { $zip.Dispose(); Remove-Item $zipPath -Force -ErrorAction SilentlyContinue }
Say 'تم نسخ ملفات البرنامج.'

# 4) إعدادات التشغيل: تابع للموقع، ويلتقط طابعة هذا الجهاز
$data = Join-Path $target 'data'
New-Item -ItemType Directory -Force -Path $data | Out-Null
$envLines = @(
  'ALWADY_HOSTED=1',
  'ALWADY_NO_WINDOW=1',
  'ALWADY_LAUNCHER=1',
  'ALWADY_PRINT_CAPTURE=1',
  'PORT=4100',
  'ALWADY_LOCK_PORT=4101',
  ('ALWADY_DATA_DIR=' + $data),
  ('INVOICES_DIR=' + (Join-Path $data 'documents')),
  ('WAREHOUSE_OUTBOX_DIR=' + (Join-Path $data 'warehouse-outbox')),
  ('WAREHOUSE_SITE_URL=' + [string]$cfg.siteUrl),
  ('WAREHOUSE_API_KEY=' + [string]$cfg.apiKey)
)
[IO.File]::WriteAllLines((Join-Path $target 'main.env'), $envLines, (New-Object Text.UTF8Encoding($false)))

if ($test) { Say 'TEST MODE: skipped old program/shortcuts/printer/start'; exit 0 }

# 5) البرنامج القديم: يتقفل وينشال من بدء التشغيل (اختصاراته تنحفظ في مجلد، ما ينحذف شي)
$oldDirs = @((Join-Path $env:LOCALAPPDATA 'AlwadyInvoiceServer'), (Join-Path $env:LOCALAPPDATA 'AlwadyInvoiceClient'))
$isOld = { param($p) $r = $false; foreach ($d in $oldDirs) { if ($p -and $p.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) { $r = $true } }; $r }
Get-Process -ErrorAction SilentlyContinue | Where-Object { $p = $null; try { $p = $_.Path } catch {}; & $isOld $p } | Stop-Process -Force -ErrorAction SilentlyContinue
$launcher = Join-Path $target '${LAUNCHER_NAME}'
$shortcutsOk = $true
try {
  $ws = New-Object -ComObject WScript.Shell
  $startup = [Environment]::GetFolderPath('Startup')
  $keep = Join-Path $target 'old-startup-shortcuts'
  foreach ($lnk in Get-ChildItem $startup -Filter *.lnk -ErrorAction SilentlyContinue) {
    $t = $ws.CreateShortcut($lnk.FullName).TargetPath
    if (& $isOld $t) {
      New-Item -ItemType Directory -Force -Path $keep | Out-Null
      Move-Item $lnk.FullName -Destination $keep -Force
      Say ('البرنامج القديم انشال من بدء التشغيل: ' + $lnk.Name)
    }
  }
  $s = $ws.CreateShortcut((Join-Path $startup '${SHORTCUT_NAME}.lnk'))
  $s.TargetPath = $launcher
  $s.WorkingDirectory = $target
  $s.IconLocation = $launcher
  $s.Save()
} catch { $shortcutsOk = $false; Say ('تنبيه: تعذر ضبط بدء التشغيل: ' + $_.Exception.Message) }
if ($shortcutsOk) { Say 'البرنامج يشتغل تلقائياً مع ويندوز.' }

# 6) الطابعة (تحتاج موافقة ويندوز لو ما كانت موجودة)
$setupOk = $true
if (-not (Get-Printer -Name 'WhatsApp Sender' -ErrorAction SilentlyContinue)) {
  Say 'جاري تثبيت طابعة البرنامج (وافق على طلب ويندوز)...'
  $setupOk = $false
  $ErrorActionPreference = 'Continue'
  try {
    Push-Location $target
    $out = & (Join-Path $target 'node.exe') (Join-Path $target 'printer-setup.js') install 2>&1
    $setupOk = ($LASTEXITCODE -eq 0)
    foreach ($line in @($out)) { $t = [string]$line; if ($t.Trim()) { Say $t } }
  } catch { Say ([string]$_.Exception.Message) } finally { Pop-Location; $ErrorActionPreference = 'Stop' }
} else { Say 'طابعة WhatsApp Sender موجودة.' }

# 7) التشغيل
Start-Process -FilePath $launcher -WorkingDirectory $target
Start-Sleep -Seconds 3
Say 'تم التثبيت.'
if (-not $setupOk) { exit 3 }
exit 0
`;
}

function build() {
  if (process.platform !== 'win32') throw new Error('البناء يعمل على ويندوز فقط');
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });
  const icon = path.join(WORK, 'app.ico');
  makeIcon(icon);

  // البرنامج كامل
  const stage = path.join(WORK, 'main-app');
  fs.mkdirSync(stage, { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
  fs.cpSync(path.join(ROOT, 'public'), path.join(stage, 'public'), { recursive: true });
  // المكتبات بدون ملفات ما تنحتاج وقت التشغيل (خرائط وتعاريف وشروحات): أصغر، ومسارات أقصر من حد ويندوز
  const SKIP = /\.(map|md|markdown)$|\.d\.(ts|mts|cts)$/i;
  fs.cpSync(path.join(ROOT, 'node_modules'), path.join(stage, 'node_modules'), { recursive: true, filter: (src) => !SKIP.test(src) });
  fs.copyFileSync(process.execPath, path.join(stage, 'node.exe'));
  compileCs({ name: 'launcher-main', source: launcherSource(), outExe: path.join(stage, LAUNCHER_NAME), icon, windowed: true });

  const payloadZip = path.join(DIST, 'main-payload.zip');
  fs.rmSync(payloadZip, { force: true });
  zipDir(stage, payloadZip);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(payloadZip)).digest('hex');
  const size = fs.statSync(payloadZip).size;

  // ملف التثبيت الصغير (فيه سكربت التثبيت بس — البرنامج ينحمّل وقت التثبيت)
  const ps = path.join(WORK, 'install-main.ps1');
  fs.writeFileSync(ps, '﻿' + installScript(), 'utf8');
  const outExe = path.join(DIST, 'main-setup.exe');
  compileCs({
    name: 'setup-main', outExe, icon, windowed: true, resources: [[ps, 'install.ps1']],
    source: setupSource(TITLE, {
      resources: ['install.ps1'],
      missingText: 'هذا الملف ناقص.\nحمّل برنامج الواتساب من موقع المستودع (أجهزة المحاسبين) وشغّله هو.',
      waitText: 'جاري تحميل برنامج الواتساب وتثبيته (ياخذ كم دقيقة)...\nإذا طلب ويندوز الموافقة اضغط (نعم).',
      doneText: 'تم تثبيت برنامج الواتساب ✅\nافتح الموقع ← واتساب والإرسال، وامسح الباركود من جوال الشركة.'
    })
  });
  fs.writeFileSync(path.join(DIST, 'main-payload.json'), JSON.stringify({ sha256, size, builtAt: new Date().toISOString() }, null, 2));
  fs.rmSync(WORK, { recursive: true, force: true });

  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  console.log(`✅ dist\\main-setup.exe (${mb(fs.statSync(outExe).size)} MB)`);
  console.log(`✅ dist\\main-payload.zip (${mb(size)} MB) sha256 ${sha256.slice(0, 12)}…`);
  return { outExe, payloadZip, sha256, size };
}

if (require.main === module) {
  try { build(); } catch (err) { console.error(`❌ ${err.message}`); process.exit(1); }
}

module.exports = { build, installScript, launcherSource, TITLE, INSTALL_FOLDER };
