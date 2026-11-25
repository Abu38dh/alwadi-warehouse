/**
 * device-setup.js — تجهيز الأجهزة (مرة واحدة لكل جهاز)
 *
 *   node device-setup.js server   ← الجهاز الرئيسي: يسمح للأجهزة الأخرى في نفس الشبكة فقط بالوصول (جدار حماية ويندوز)
 *   node device-setup.js client   ← جهاز فرعي: يحوّل البرنامج لوضع "جهاز فرعي" ويثبت طابعة البرنامج
 */

const fs = require('fs');
const path = require('path');
const printerSetup = require('./printer-setup');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (_) { return {}; }
}

function writeSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2) + '\n', 'utf8');
}

function setupServer() {
  const s = readSettings();
  if (s.mode === 'client') {
    s.mode = 'server';
    writeSettings(s);
  }
  const relayPort = Number(s.relayPort) || 3501;
  const discoveryPort = Number(s.discoveryPort) || 3502;
  console.log('🛡 جاري تجهيز الجهاز الرئيسي: طابعة البرنامج + السماح للأجهزة على نفس الشبكة (سيطلب ويندوز موافقة المسؤول مرة واحدة)...');
  const out = printerSetup.runElevated(`
    $ErrorActionPreference = 'Stop'
    Get-NetFirewallRule -DisplayName 'Alwady Invoice Relay*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName 'Alwady Invoice Relay (TCP ${relayPort})' -Direction Inbound -Protocol TCP -LocalPort ${relayPort} -Action Allow -RemoteAddress LocalSubnet -Profile Any | Out-Null
    New-NetFirewallRule -DisplayName 'Alwady Invoice Relay Discovery (UDP ${discoveryPort})' -Direction Inbound -Protocol UDP -LocalPort ${discoveryPort} -Action Allow -RemoteAddress LocalSubnet -Profile Any | Out-Null
    ${printerSetup.installScript()}
    'OK'
  `);
  if (/ERROR:/.test(out)) { console.error(out.trim()); }
  const check = printerSetup.runPowerShell(`(Get-NetFirewallRule -DisplayName 'Alwady Invoice Relay*' -ErrorAction SilentlyContinue | Measure-Object).Count`).trim();
  const printerOk = printerSetup.reportInstall(printerSetup.getPrinterName());
  if (check === '2') {
    console.log('✅ الأجهزة الفرعية على نفس الشبكة تستطيع الآن إرسال المستندات لهذا الجهاز.');
  } else {
    console.error('❌ لم تكتمل إعدادات جدار الحماية.');
  }
  return check === '2' && printerOk;
}

function setupClient() {
  const s = readSettings();
  s.mode = 'client';
  writeSettings(s);
  console.log('✅ تم تحويل البرنامج على هذا الجهاز إلى "جهاز فرعي" (بدون واتساب، الإرسال من الجهاز الرئيسي).');
  const ok = printerSetup.install();
  if (ok) console.log('👉 الآن شغّل البرنامج وأدخل رمز الربط الظاهر في الجهاز الرئيسي.');
  return ok;
}

if (require.main === module) {
  const cmd = (process.argv[2] || '').toLowerCase();
  try {
    if (cmd === 'server') process.exit(setupServer() ? 0 : 1);
    else if (cmd === 'client') process.exit(setupClient() ? 0 : 1);
    else {
      console.log('الاستخدام: node device-setup.js server   (الجهاز الرئيسي)');
      console.log('         node device-setup.js client   (جهاز فرعي)');
      process.exit(1);
    }
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

module.exports = { setupServer, setupClient };
