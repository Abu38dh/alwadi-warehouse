/**
 * notify.js — تنبيهات ويندوز (بجانب الساعة) لأن البرنامج يعمل في الخلفية بدون نافذة.
 *
 * - تنبيه واتساب: انقطع الاتصال / يحتاج مسح باركود / مستندات تنتظر.
 * - تنبيه مراجعة: مستند لم يُرسل ويحتاج تدخلك (تُجمع عدة مستندات في تنبيه واحد).
 * - الضغط على التنبيه يفتح نافذة البرنامج.
 * - لا يتكرر نفس التنبيه بشكل مزعج (حد أدنى للمدة بين كل تنبيه وآخر من نفس النوع).
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const lastShown = new Map();
const history = []; // للاختبارات: كل التنبيهات التي صدرت
let openUrl = '';

const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function configure({ url } = {}) { if (url) openUrl = url; }

/**
 * النصوص (العنوان، النص، اسم الملف، الرابط...) تُمرَّر لـ PowerShell عبر متغيرات بيئة فقط،
 * ولا تُكتب داخل نص الأمر أبداً => لا يمكن لأي نص (مثل اسم قروب) أن يتحول إلى أمر.
 */
function buildNotificationScript() {
  return `
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon = [System.Drawing.SystemIcons]::Information
    try { if ($env:ALWADY_N_ICON -and (Test-Path -LiteralPath $env:ALWADY_N_ICON)) { $n.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:ALWADY_N_ICON) } } catch {}
    $n.Text = $env:ALWADY_N_APP
    $n.BalloonTipTitle = $env:ALWADY_N_TITLE
    $n.BalloonTipText = $env:ALWADY_N_TEXT
    $kind = 'Info'
    if ($env:ALWADY_N_LEVEL -eq 'Error') { $kind = 'Error' } elseif ($env:ALWADY_N_LEVEL -eq 'Warning') { $kind = 'Warning' }
    $n.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::$kind
    $script:clicked = $false
    $n.add_BalloonTipClicked({ $script:clicked = $true })
    $n.add_Click({ $script:clicked = $true })
    $n.Visible = $true
    $n.ShowBalloonTip(15000)
    for ($i = 0; $i -lt 200 -and -not $script:clicked; $i++) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 }
    $url = $env:ALWADY_N_URL
    if ($script:clicked -and $url -and $url -match '^http://(127\\.0\\.0\\.1|localhost):\\d+/?$') {
      try { Start-Process msedge -ArgumentList ('--app=' + $url), '--window-size=1200,800' -ErrorAction Stop } catch { Start-Process $url }
    }
    $n.Visible = $false
    $n.Dispose()
  `;
}

function notificationEnv({ title, text, level }) {
  return {
    ALWADY_N_ICON: path.join(__dirname, 'تشغيل.exe'),
    ALWADY_N_APP: 'نظام إرسال المستندات',
    ALWADY_N_TITLE: clip(title, 60),
    ALWADY_N_TEXT: clip(text, 240),
    ALWADY_N_LEVEL: { error: 'Error', warning: 'Warning' }[level] || 'Info',
    ALWADY_N_URL: openUrl || ''
  };
}

function showWindowsNotification(n) {
  const encoded = Buffer.from(buildNotificationScript(), 'utf16le').toString('base64');
  try {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], { windowsHide: true, env: { ...process.env, ...notificationEnv(n) } }, () => {});
    if (child && child.unref) child.unref();
  } catch (_) {}
}

/**
 * @param {string} key  نوع التنبيه (لمنع التكرار)
 * @param {{title: string, text: string, level?: 'info'|'warning'|'error', minIntervalMs?: number}} n
 * @returns {boolean} هل صدر التنبيه
 */
function notify(key, { title, text, level = 'info', minIntervalMs = 0 }) {
  const now = Date.now();
  if (minIntervalMs && now - (lastShown.get(key) || 0) < minIntervalMs) return false;
  lastShown.set(key, now);
  history.push({ key, title, text, level, at: now });
  if (history.length > 200) history.shift();
  console.log(`🔔 تنبيه: ${title} — ${text}`);
  if (process.env.ALWADY_NO_WINDOW === '1') return true; // الاختبارات: بدون تنبيهات على الشاشة
  showWindowsNotification({ title, text, level });
  return true;
}

function forget(key) { lastShown.delete(key); }

// ---- مستندات تحتاج مراجعة: تُجمع خلال ثوانٍ في تنبيه واحد ----
let pendingReview = [];
let reviewTimer = null;
function notifyReview(fileName, reason, { delayMs = 6000 } = {}) {
  pendingReview.push({ fileName, reason });
  if (reviewTimer) return;
  reviewTimer = setTimeout(() => {
    const items = pendingReview;
    pendingReview = [];
    reviewTimer = null;
    if (items.length === 1) {
      notify(`review:${Date.now()}`, { title: 'مستند لم يُرسل ويحتاج مراجعة', text: `${items[0].fileName}\n${items[0].reason}`, level: 'warning' });
    } else {
      notify(`review:${Date.now()}`, { title: `${items.length} مستندات لم تُرسل وتحتاج مراجعة`, text: 'افتح البرنامج ← "المتعثرة (تحتاج مراجعة)" لمعرفة السبب.', level: 'warning' });
    }
  }, delayMs);
  if (reviewTimer.unref) reviewTimer.unref();
}

module.exports = { notify, notifyReview, forget, configure, history, buildNotificationScript, notificationEnv };
