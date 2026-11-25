/**
 * build-exe.js — يبني ملف تركيب الطابعة لأجهزة المحاسبين:  dist\printer-setup.exe
 *
 * الملف هذا ما يُستخدم مباشرة: الموقع (أجهزة المحاسبين ← تحميل ملف الفرع) يضيف في آخره سطر فيه
 * عنوان الموقع ومفتاح الفرع، فيصير "تركيب الطابعة - فرع X.exe". انسخه للسيرفر (PRINTER_INSTALLER).
 *
 * الضغط عليه: يثبّت طابعة "WhatsApp Sender" + جزء مخفي يشتغل مع ويندوز ويرفع المطبوع للموقع،
 * والجهاز يتسجّل في الموقع لحاله على فرع الملف. بدون نوافذ ولا اختصار على سطح المكتب ولا رموز ربط.
 * تشغيله مرة ثانية = تحديث (ما يمسح شي).
 *
 * يُبنى بمترجم C# المدمج في ويندوز (.NET Framework) بدون تحميل أي برنامج.
 * الاستخدام:  npm run build-exe
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const clientPackage = require('./make-client-package');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const WORK = path.join(ROOT, '.build-tmp'); // مسار إنجليزي فقط
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const LAUNCHER_NAME = 'تشغيل.exe';

const ROLES = {
  client: {
    setupName: 'printer-setup.exe',
    installFolder: 'AlwadyInvoiceClient',
    shortcutName: 'طابعة الواتساب',
    oldShortcutName: 'إرسال المستندات',
    title: 'طابعة الواتساب',
    setupArg: 'client',
    deps: ['chokidar', 'pdf-parse'],
    finalMessage: 'تمت إضافة الطابعة.'
  }
};

function runPs(script) {
  const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue'\n$ErrorActionPreference='Stop'\n${script}`, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { encoding: 'utf8' });
}
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** أيقونة من شعار الشركة */
function makeIcon(outIco) {
  const pngOut = outIco.replace(/\.ico$/, '.png');
  runPs(`
    Add-Type -AssemblyName System.Drawing
    $src = [System.Drawing.Image]::FromFile(${psq(path.join(ROOT, 'public', 'logo.png'))})
    $side = [Math]::Min($src.Width, $src.Height)
    $bmp = New-Object System.Drawing.Bitmap 256, 256
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::White)
    $srcW = [Math]::Min($src.Width, [int]($side * 1.22))
    $scale = 240.0 / $srcW
    $dh = [int]($side * $scale)
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle 8, ([int]((256 - $dh) / 2)), 240, $dh), (New-Object System.Drawing.Rectangle 0, 0, $srcW, $side), [System.Drawing.GraphicsUnit]::Pixel)
    $bmp.Save(${psq(pngOut)}, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose(); $src.Dispose()
  `);
  const png = fs.readFileSync(pngOut);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
  fs.writeFileSync(outIco, Buffer.concat([header, png]));
}

function compileCs({ name, source, outExe, icon, resources = [], windowed = false }) {
  const csFile = path.join(WORK, `${name}.cs`);
  fs.writeFileSync(csFile, '\uFEFF' + source, 'utf8');
  const tmpExe = path.join(WORK, `${name}.exe`);
  execFileSync(CSC, ['/nologo', windowed ? '/target:winexe' : '/target:exe', ...(windowed ? ['/r:System.Windows.Forms.dll', '/r:System.Drawing.dll'] : []), '/optimize+', '/codepage:65001', `/win32icon:${icon}`,
    ...resources.map(([file, id]) => `/resource:${file},${id}`), `/out:${tmpExe}`, csFile], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  fs.mkdirSync(path.dirname(outExe), { recursive: true });
  fs.copyFileSync(tmpExe, outExe);
}

/**
 * "تشغيل.exe" للجهاز الرئيسي: يشغّل البرنامج في الخلفية بدون أي نافذة سوداء.
 * التفاصيل تُحفظ في logs\\app.log، وأي توقف مفاجئ يظهر برسالة ويندوز واضحة.
 */
function hiddenLauncherSource(title) {
  return `
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
class Launcher {
  [STAThread]
  static int Main() {
    string title = ${JSON.stringify(title)};
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    string node = Path.Combine(dir, "node.exe");
    if (!File.Exists(node)) node = "node";
    string logDir = Path.Combine(dir, "logs");
    try { Directory.CreateDirectory(logDir); } catch {}
    int code;
    try {
      do {
        // رمز الخروج 75 = البرنامج طلب إعادة تشغيل نفسه (مثلاً بعد تغيير مكان الحفظ)
        var psi = new ProcessStartInfo(node, "index.js");
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.EnvironmentVariables["ALWADY_LAUNCHER"] = "1";
        psi.EnvironmentVariables["ALWADY_LOG_FILE"] = Path.Combine(logDir, "app.log");
        var p = Process.Start(psi);
        p.WaitForExit();
        code = p.ExitCode;
      } while (code == 75);
    } catch (Exception e) {
      MessageBox.Show("تعذر تشغيل البرنامج: " + e.Message, title, MessageBoxButtons.OK, MessageBoxIcon.Error, MessageBoxDefaultButton.Button1, MessageBoxOptions.RtlReading | MessageBoxOptions.RightAlign);
      return 1;
    }
    if (code != 0) {
      MessageBox.Show("توقف البرنامج بسبب خطأ.\\nالتفاصيل في الملف: " + Path.Combine(logDir, "app.log"), title, MessageBoxButtons.OK, MessageBoxIcon.Error, MessageBoxDefaultButton.Button1, MessageBoxOptions.RtlReading | MessageBoxOptions.RightAlign);
    }
    return code;
  }
}`;
}

/** "تشغيل.exe" للجهاز الفرعي: نافذة صغيرة تعرض النتائج وتطلب رمز الربط أول مرة */
function launcherSource(title) {
  return `
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
class Launcher {
  static int Main() {
    try { Console.OutputEncoding = Encoding.UTF8; Console.InputEncoding = Encoding.UTF8; } catch {}
    try { Console.Title = ${JSON.stringify(title)}; } catch {}
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    string node = Path.Combine(dir, "node.exe");
    if (!File.Exists(node)) node = "node";
    try {
      int code;
      do {
        // رمز الخروج 75 = البرنامج طلب إعادة تشغيل نفسه (مثلاً بعد تغيير مكان الحفظ)
        var psi = new ProcessStartInfo(node, "index.js");
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        psi.EnvironmentVariables["ALWADY_LAUNCHER"] = "1";
        var p = Process.Start(psi);
        p.WaitForExit();
        code = p.ExitCode;
      } while (code == 75);
      if (code != 0) { Console.WriteLine(); Console.WriteLine("توقف البرنامج. اضغط أي زر للإغلاق..."); Console.ReadKey(); }
      return code;
    } catch (Exception e) {
      Console.WriteLine("تعذر تشغيل البرنامج: " + e.Message);
      Console.ReadKey();
      return 1;
    }
  }
}`;
}

/**
 * ملف التثبيت: نافذة ويندوز عادية (بدون شاشة سوداء) فيها شريط تقدم، ثم رسالة "تم" أو سبب الفشل.
 * يحمل payload.zip و install.ps1 بداخله ويشغّل سكربت التثبيت في الخلفية.
 */
function setupSource(title, o = {}) {
  // o: نصوص وملفات ملف تثبيت ثاني (برنامج الجهاز الرئيسي — build-main.js). بدونها: ملف الطابعة كما هو
  const cs = (s) => JSON.stringify(String(s));
  const resources = o.resources || ['payload.zip', 'install.ps1'];
  const missingText = cs(o.missingText || 'هذا الملف ناقص: ما فيه الفرع.\nحمّل ملف الفرع من موقع المستودع (أجهزة المحاسبين) وشغّله هو.');
  const waitText = cs(o.waitText || 'جاري تركيب الطابعة، انتظر قليلاً...\nإذا طلب ويندوز الموافقة اضغط (نعم).');
  const doneText = cs(o.doneText || 'تمت إضافة الطابعة ✅\nاطبع على طابعة WhatsApp Sender.');
  return `
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

class Setup {
  const string Title = ${JSON.stringify('تثبيت ' + title)};
  static MessageBoxOptions Rtl = MessageBoxOptions.RtlReading | MessageBoxOptions.RightAlign;

  const string Marker = "ALWADY-INSTALL-CONFIG:";

  /** السطر اللي يضيفه الموقع في آخر الملف: عنوان الموقع ومفتاح الفرع (base64) */
  static string ReadInstallConfig() {
    try {
      using (var f = new FileStream(Application.ExecutablePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
        int len = (int)Math.Min(8192, f.Length);
        var buf = new byte[len];
        f.Seek(-len, SeekOrigin.End);
        int read = 0;
        while (read < len) { int n = f.Read(buf, read, len - read); if (n <= 0) break; read += n; }
        string tail = Encoding.ASCII.GetString(buf, 0, read);
        int i = tail.LastIndexOf(Marker);
        if (i < 0) return null;
        int j = tail.IndexOf(":END", i);
        if (j < 0) return null;
        return tail.Substring(i + Marker.Length, j - i - Marker.Length).Trim();
      }
    } catch { return null; }
  }

  [STAThread]
  static int Main() {
    bool test = Environment.GetEnvironmentVariable("ALWADY_INSTALL_TEST") == "1"; // للاختبارات فقط: بدون نوافذ
    string installConfig = ReadInstallConfig();
    if (installConfig == null && !test) {
      MessageBox.Show(${missingText}, Title, MessageBoxButtons.OK, MessageBoxIcon.Error, MessageBoxDefaultButton.Button1, Rtl);
      return 2;
    }
    string tmp = Path.Combine(Path.GetTempPath(), "alwady-setup-" + Guid.NewGuid().ToString("N"));
    var output = new StringBuilder();
    int code = 1;
    Form form = null;
    if (!test) {
      Application.EnableVisualStyles();
      form = new Form();
      form.Text = Title;
      form.RightToLeft = RightToLeft.Yes;
      form.RightToLeftLayout = true;
      form.FormBorderStyle = FormBorderStyle.FixedDialog;
      form.ControlBox = false;
      form.StartPosition = FormStartPosition.CenterScreen;
      form.ClientSize = new Size(440, 120);
      form.TopMost = true;
      try { form.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch {}
      var label = new Label();
      label.Text = ${waitText};
      label.Font = new Font("Segoe UI", 11);
      label.SetBounds(20, 14, 400, 52);
      var bar = new ProgressBar();
      bar.Style = ProgressBarStyle.Marquee;
      bar.SetBounds(20, 74, 400, 22);
      form.Controls.Add(label);
      form.Controls.Add(bar);
    }

    ThreadStart work = delegate {
      try {
        Directory.CreateDirectory(tmp);
        var asm = Assembly.GetExecutingAssembly();
        foreach (var name in new[] { ${resources.map(cs).join(', ')} }) {
          using (var s = asm.GetManifestResourceStream(name))
          using (var f = File.Create(Path.Combine(tmp, name))) { s.CopyTo(f); }
        }
        var psi = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \\"" + Path.Combine(tmp, "install.ps1") + "\\"");
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        string setupLog = Path.Combine(tmp, "setup.log");
        psi.EnvironmentVariables["ALWADY_SETUP_LOG"] = setupLog;
        if (installConfig != null) psi.EnvironmentVariables["ALWADY_INSTALL_CONFIG"] = installConfig;
        var p = new Process();
        p.StartInfo = psi;
        p.OutputDataReceived += (o, e) => { if (e.Data != null) lock (output) output.AppendLine(e.Data); };
        p.ErrorDataReceived += (o, e) => { if (e.Data != null) lock (output) output.AppendLine(e.Data); };
        p.Start();
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        p.WaitForExit();
        code = p.ExitCode;
        // رسائل التثبيت من ملف UTF-8 (أدق من قراءة مخرجات PowerShell التي قد تفسد الحروف العربية)
        if (File.Exists(setupLog)) {
          string logText = File.ReadAllText(setupLog, Encoding.UTF8);
          lock (output) { output.Clear(); output.Append(logText); }
        }
      } catch (Exception e) {
        lock (output) output.AppendLine(e.Message);
        code = 1;
      } finally {
        try { Directory.Delete(tmp, true); } catch {}
        if (form != null) { try { form.BeginInvoke(new MethodInvoker(form.Close)); } catch {} }
      }
    };

    if (test) {
      work();
      byte[] bytes = Encoding.UTF8.GetBytes(output.ToString());
      using (var stdout = Console.OpenStandardOutput()) { stdout.Write(bytes, 0, bytes.Length); }
      return code;
    }

    var thread = new Thread(work);
    thread.IsBackground = true;
    form.Shown += (o, e) => thread.Start();
    Application.Run(form);
    thread.Join();

    if (code == 0) {
      MessageBox.Show(${doneText}, Title, MessageBoxButtons.OK, MessageBoxIcon.Information, MessageBoxDefaultButton.Button1, Rtl);
    } else if (code == 3) {
      MessageBox.Show("⚠ الطابعة ما انضافت (ربما ضغطت «لا» على طلب ويندوز).\\nشغّل الملف مرة ثانية واضغط «نعم».", Title, MessageBoxButtons.OK, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button1, Rtl);
      return 0;
    } else {
      string all = output.ToString().Trim();
      string[] lines = all.Split('\\n');
      int from = Math.Max(0, lines.Length - 12);
      string tail = string.Join("\\n", lines, from, lines.Length - from);
      MessageBox.Show("فشل التثبيت ❌ صوّر هذه الرسالة.\\n\\n" + tail, Title, MessageBoxButtons.OK, MessageBoxIcon.Error, MessageBoxDefaultButton.Button1, Rtl);
    }
    return code;
  }
}`;
}

function installScript(role) {
  const r = ROLES[role];
  return `
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$ErrorActionPreference = 'Stop'
# رسائل التثبيت تُكتب أيضاً في ملف UTF-8 (حتى تظهر صحيحة بالعربي في نافذة ملف التثبيت)
$SetupLog = $env:ALWADY_SETUP_LOG
function Write-Host {
  param([Parameter(Position = 0)] $Object = '', $ForegroundColor)
  if ($ForegroundColor) { Microsoft.PowerShell.Utility\\Write-Host $Object -ForegroundColor $ForegroundColor } else { Microsoft.PowerShell.Utility\\Write-Host $Object }
  if ($SetupLog) { [IO.File]::AppendAllText($SetupLog, "$Object\`r\`n", [Text.Encoding]::UTF8) }
}
trap {
  Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
$test = $env:ALWADY_INSTALL_TEST -eq '1'
$target = if ($env:ALWADY_INSTALL_DIR) { $env:ALWADY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA '${r.installFolder}' }
Write-Host ''
Write-Host '=== ${r.title} ===' -ForegroundColor Cyan
Write-Host "مكان التثبيت: $target"

# إيقاف النسخة الشغالة (عند التحديث): كل البرامج الشغالة من مجلد البرنامج (المشغّل تشغيل.exe ثم node.exe)
function Get-InstalledProcesses {
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $p = $null; try { $p = $_.Path } catch {}; $p -and $p.StartsWith($target, [StringComparison]::OrdinalIgnoreCase) }
}
for ($i = 0; $i -lt 20; $i++) {
  $running = @(Get-InstalledProcesses)
  if ($running.Count -eq 0) { break }
  if ($i -eq 0) { Write-Host 'جاري إيقاف النسخة الشغالة من البرنامج...' }
  $running | Sort-Object { if ($_.ProcessName -eq 'node') { 1 } else { 0 } } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}
if (@(Get-InstalledProcesses).Count -gt 0) { throw 'تعذر إيقاف البرنامج الشغال. أعد تشغيل الجهاز ثم شغّل ملف التثبيت مرة أخرى.' }

New-Item -ItemType Directory -Force -Path $target | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $PSScriptRoot 'payload.zip'))
try {
  foreach ($e in $zip.Entries) {
    $name = $e.FullName -replace '/', '\\'
    $dest = Join-Path $target $name
    if ($name.EndsWith('\\')) { New-Item -ItemType Directory -Force -Path $dest | Out-Null; continue }
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    # إعادة المحاولة إذا كان الملف مقفولاً لحظياً (برنامج حماية أو برنامج يُغلق للتو)
    for ($try = 1; ; $try++) {
      try { [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true); break }
      catch { if ($try -ge 20) { throw "تعذر تحديث الملف $name لأنه مستخدم. أعد تشغيل الجهاز ثم شغّل ملف التثبيت مرة أخرى." }; Start-Sleep -Milliseconds 500 }
    }
  }
} finally { $zip.Dispose() }

# الإعدادات لا تُمسح عند التحديث
$settings = Join-Path $target 'settings.json'
if (-not (Test-Path $settings)) { Copy-Item (Join-Path $target 'settings.default.json') $settings }

# عنوان الموقع ومفتاح الفرع (من آخر ملف التركيب): الجهاز يتسجّل في الموقع لحاله
if ($env:ALWADY_INSTALL_CONFIG) {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ALWADY_INSTALL_CONFIG))
  $null = $json | ConvertFrom-Json
  [IO.File]::WriteAllText((Join-Path $target 'site-install.json'), $json, (New-Object Text.UTF8Encoding($false)))
  Write-Host 'تم حفظ فرع الجهاز.' -ForegroundColor Green
}
Write-Host 'تم نسخ ملفات البرنامج.' -ForegroundColor Green

if ($test) { Write-Host 'TEST MODE: skipped shortcuts/printer/start'; exit 0 }

$launcher = Join-Path $target '${LAUNCHER_NAME}'
# الاختصارات: فشل أحدها لا يوقف التثبيت
$shortcutsOk = $true
try {
  $ws = New-Object -ComObject WScript.Shell
  # اختصارات النسخة القديمة (البرنامج كان يفتح نافذة): تنشال
  foreach ($old in @('${r.oldShortcutName}', '${r.shortcutName}')) {
    foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Startup'))) {
      $oldLnk = Join-Path $folder ($old + '.lnk')
      if (Test-Path $oldLnk) { Remove-Item $oldLnk -Force -ErrorAction SilentlyContinue }
    }
  }
  # التشغيل مع ويندوز فقط (الجزء المخفي اللي يرفع المطبوع) — بدون اختصار على سطح المكتب
  foreach ($folder in @([Environment]::GetFolderPath('Startup'))) {
    try {
      $lnk = $ws.CreateShortcut((Join-Path $folder '${r.shortcutName}.lnk'))
      $lnk.TargetPath = $launcher
      $lnk.WorkingDirectory = $target
      $lnk.IconLocation = $launcher
      $lnk.Save()
    } catch { $shortcutsOk = $false; Write-Host ('تنبيه: تعذر إنشاء اختصار في ' + $folder + ': ' + $_.Exception.Message) -ForegroundColor Yellow }
  }
} catch { $shortcutsOk = $false; Write-Host ('تنبيه: تعذر إنشاء الاختصارات: ' + $_.Exception.Message) -ForegroundColor Yellow }
if ($shortcutsOk) { Write-Host 'الطابعة تشتغل تلقائياً مع ويندوز.' -ForegroundColor Green }

# الطابعة وجدار الحماية: تحتاج موافقة ويندوز. لو ضغط المستخدم "لا" يكمل التثبيت ويفتح البرنامج مع تنبيه فقط
Write-Host 'جاري تثبيت طابعة البرنامج (وافق على طلب ويندوز)...'
$setupOk = $false
$ErrorActionPreference = 'Continue'
try {
  $setupOut = & (Join-Path $target 'node.exe') (Join-Path $target 'device-setup.js') ${r.setupArg} 2>&1
  $setupOk = ($LASTEXITCODE -eq 0)
  foreach ($line in @($setupOut)) { $t = [string]$line; if ($t.Trim()) { Write-Host $t } }
} catch {
  Write-Host ([string]$_.Exception.Message)
} finally {
  $ErrorActionPreference = 'Stop'
}
if (-not $setupOk) {
  Write-Host ''
  Write-Host 'تنبيه: الطابعة ما انضافت (ربما تم الضغط على "لا" في طلب ويندوز). شغّل الملف مرة ثانية واضغط "نعم".' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '${r.finalMessage}' -ForegroundColor Green
Start-Process -FilePath $launcher -WorkingDirectory $target
Start-Sleep -Seconds 3
# 3 = تم التثبيت والبرنامج يعمل، لكن الطابعة لم تكتمل
if (-not $setupOk) { exit 3 }
exit 0
`;
}

/** نسخ المكتبات المطلوبة مع كل ما تعتمد عليه من node_modules الحالي (بدون تحميل من الإنترنت) */
function copyDependencyClosure(names, fromDir, toNodeModules) {
  const rootNm = path.join(fromDir, 'node_modules');
  const copied = new Set();
  const findPkgDir = (name, requesterDir) => {
    // نفس طريقة Node: node_modules الأقرب ثم الأعلى
    let dir = requesterDir;
    for (;;) {
      const candidate = path.join(dir, 'node_modules', ...name.split('/'));
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir || !dir.startsWith(fromDir)) return null;
      dir = parent;
    }
  };
  const visit = (name, requesterDir, optional) => {
    const pkgDir = findPkgDir(name, requesterDir);
    if (!pkgDir) { if (!optional) throw new Error(`مكتبة غير مثبتة: ${name} (شغّل npm.cmd install)`); return; }
    if (copied.has(pkgDir)) return;
    copied.add(pkgDir);
    const rel = path.relative(rootNm, pkgDir);
    fs.cpSync(pkgDir, path.join(toNodeModules, rel), { recursive: true, filter: (src) => src === pkgDir || !/[\\/]node_modules$/.test(src) });
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies || {})) visit(dep, pkgDir, false);
    for (const dep of Object.keys(pkg.optionalDependencies || {})) visit(dep, pkgDir, true);
  };
  for (const n of names) visit(n, fromDir, false);
  return copied.size;
}

function zipDir(srcDir, outZip) {
  runPs(`
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory(${psq(srcDir)}, ${psq(outZip)}, [IO.Compression.CompressionLevel]::Optimal, $false)
  `);
}

function buildRole(role, icon) {
  const r = ROLES[role];
  const stage = path.join(WORK, `${role}-app`);
  fs.rmSync(stage, { recursive: true, force: true });

  clientPackage.build(stage, { settingsFileName: 'settings.default.json', withBatFiles: false });
  const n = copyDependencyClosure(r.deps, ROOT, path.join(stage, 'node_modules'));
  fs.copyFileSync(process.execPath, path.join(stage, 'node.exe'));
  const hidden = true; // الجهازان بدون نافذة سوداء: الواجهة صفحة عادية
  compileCs({ name: `launcher-${role}`, source: hidden ? hiddenLauncherSource(r.title) : launcherSource(r.title), outExe: path.join(stage, LAUNCHER_NAME), icon, windowed: hidden });

  const payload = path.join(WORK, `payload-${role}`);
  fs.mkdirSync(payload, { recursive: true });
  zipDir(stage, path.join(payload, 'payload.zip'));
  fs.writeFileSync(path.join(payload, 'install.ps1'), '\uFEFF' + installScript(role), 'utf8');

  const outExe = path.join(DIST, r.setupName);
  compileCs({ name: `setup-${role}`, source: setupSource(r.title), outExe, icon, windowed: true,
    resources: [[path.join(payload, 'payload.zip'), 'payload.zip'], [path.join(payload, 'install.ps1'), 'install.ps1']] });
  return { outExe, libs: n };
}

function main() {
  if (process.platform !== 'win32') throw new Error('البناء يعمل على ويندوز فقط');
  if (!fs.existsSync(CSC)) throw new Error(`أداة ويندوز غير موجودة: ${CSC}`);
  if (/[^\x20-\x7E]/.test(ROOT)) throw new Error('مسار مجلد البرنامج يجب أن يكون بأحرف إنجليزية فقط');

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  const icon = path.join(WORK, 'app.ico');
  makeIcon(icon);

  const results = {};
  for (const role of Object.keys(ROLES)) {
    console.log(`🔨 بناء "${ROLES[role].setupName}"...`);
    results[role] = buildRole(role, icon);
  }
  fs.rmSync(WORK, { recursive: true, force: true });

  const mb = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(1);
  console.log('');
  for (const role of Object.keys(ROLES)) {
    console.log(`✅ dist\\${ROLES[role].setupName}  (${mb(results[role].outExe)} MB)`);
  }
  console.log('   انسخه للسيرفر، والموقع يعطي ملف كل فرع من صفحة "أجهزة المحاسبين".');
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(`❌ ${err.message}`); process.exit(1); }
}

module.exports = { copyDependencyClosure, ROLES, installScript, setupSource, compileCs, makeIcon, zipDir, runPs, psq, ROOT, DIST, WORK, LAUNCHER_NAME };
