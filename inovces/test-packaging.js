/**
 * فحص التغليف: كل ملف يطلبه البرنامج (require('./...')) لازم يكون في قائمة ملفات التثبيت
 * لجهاز المحاسب (make-client-package.js، واللي يستخدمه ملف تركيب الطابعة build-exe.js) — وإلا يتعطل البرنامج بعد التثبيت.
 * التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/** كل الملفات المحلية اللي يحتاجها ملف (ومتطلباتها) */
function localDeps(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = fs.readFileSync(path.join(__dirname, entry), 'utf8');
  for (const m of src.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) {
    const name = m[1].endsWith('.js') || m[1].endsWith('.json') ? m[1] : `${m[1]}.js`;
    if (fs.existsSync(path.join(__dirname, name))) localDeps(name, seen);
  }
  return seen;
}

function listFrom(file, regex) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const m = regex.exec(src);
  assert.ok(m, `ما لقيت قائمة الملفات في ${file}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

test('ملف تركيب الطابعة: ياخذ الفرع من آخر الملف، بدون اختصار على سطح المكتب', () => {
  const { installScript, ROLES } = require('./build-exe');
  assert.deepEqual(Object.keys(ROLES), ['client'], 'ملف واحد بس: الطابعة (ما فيه جهاز رئيسي)');
  assert.equal(ROLES.client.setupName, 'printer-setup.exe');
  const ps = installScript('client');
  assert.match(ps, /site-install\.json/, 'يحفظ عنوان الموقع ومفتاح الفرع');
  assert.match(ps, /ALWADY_INSTALL_CONFIG/);
  // الإنشاء في مجلد التشغيل مع ويندوز بس (سطح المكتب فقط لحذف الاختصارات القديمة)
  assert.match(ps, /# التشغيل مع ويندوز فقط[^\n]*\n\s*foreach \(\$folder in @\(\[Environment\]::GetFolderPath\('Startup'\)\)\)/);
  const src = fs.readFileSync(path.join(__dirname, 'build-exe.js'), 'utf8');
  assert.match(src, /const string Marker = "ALWADY-INSTALL-CONFIG:";/);
  // نفس العلامة اللي يكتبها الموقع
  const siteInstaller = path.join(__dirname, '..', 'warehouse-site', 'src', 'services', 'installer.js');
  if (fs.existsSync(siteInstaller)) assert.equal(require(siteInstaller).MARKER, 'ALWADY-INSTALL-CONFIG:');
});

test('ملفات الجهاز الفرعي (make-client-package.js) فيها كل اللي يحتاجه البرنامج', () => {
  const listed = new Set(listFrom('make-client-package.js', /const CODE_FILES = \[([^\]]+)\]/));
  // wa-baileys و customers-list ما يحتاجها الجهاز الفرعي (واتساب يشتغل في الجهاز الرئيسي فقط)
  const missing = [...localDeps('index.js')].filter(f => !listed.has(f) && !['wa-baileys.js', 'customers-list.default.json'].includes(f));
  assert.deepEqual(missing, [], `ناقص من الجهاز الفرعي: ${missing.join('، ')}`);
});
