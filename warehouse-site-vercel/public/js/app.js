/* سلوك عام: تأكيد قبل الإجراءات الحساسة، منع الإرسال المكرر، تحديد الكل، وأزرار النسخ */
(function () {
  'use strict';

  // نافذة التأكيد بشكل الموقع (بدل نافذة المتصفح)
  var confirmDialog = null;
  function getConfirmDialog() {
    if (confirmDialog) return confirmDialog;
    confirmDialog = document.createElement('dialog');
    confirmDialog.className = 'site-confirm';
    confirmDialog.innerHTML =
      '<form method="dialog">' +
        '<div class="site-confirm-body">' +
          '<span class="site-confirm-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg></span>' +
          '<p class="site-confirm-text"></p>' +
        '</div>' +
        '<div class="site-confirm-actions">' +
          '<button type="submit" value="yes" class="btn btn-primary">نعم، متأكد</button>' +
          '<button type="submit" value="no" class="btn btn-ghost">إلغاء</button>' +
        '</div>' +
      '</form>';
    document.body.appendChild(confirmDialog);
    // الضغط على الخلفية = إلغاء
    confirmDialog.addEventListener('click', function (e) { if (e.target === confirmDialog) confirmDialog.close('no'); });
    return confirmDialog;
  }
  function askConfirm(message, onYes) {
    var dlg = getConfirmDialog();
    if (typeof dlg.showModal !== 'function') { if (window.confirm(message)) onYes(); return; }
    dlg.querySelector('.site-confirm-text').textContent = message;
    dlg.returnValue = '';
    dlg.addEventListener('close', function done() {
      dlg.removeEventListener('close', done);
      if (dlg.returnValue === 'yes') onYes();
    });
    dlg.showModal();
    dlg.querySelector('button[value="yes"]').focus();
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.getAttribute) return;
    // نموذج نافذة التأكيد نفسها: المتصفح يقفلها
    if (form.getAttribute('method') === 'dialog') return;
    var message = form.getAttribute('data-confirm');
    if (message && form.getAttribute('data-confirmed') !== '1') {
      event.preventDefault();
      var submitter = event.submitter && event.submitter.form === form ? event.submitter : null;
      askConfirm(message, function () {
        form.setAttribute('data-confirmed', '1');
        if (form.requestSubmit) form.requestSubmit(submitter || undefined); else form.submit();
      });
      return;
    }
    form.removeAttribute('data-confirmed');
    // ضغطتان سريعتان على نفس الزر: الثانية لا تُرسل (والسيرفر يحمي نفسه أيضاً)
    if (form.hasAttribute('data-once')) {
      if (form.getAttribute('data-sent') === '1') { event.preventDefault(); return; }
      form.setAttribute('data-sent', '1');
      form.classList.add('is-sending');
    }
  });

  // اختيار اسم من القائمة أو كتابة اسم جديد: واحد بس يكون محدد (عشان ما يتلخبط المستخدم)
  document.addEventListener('input', function (event) {
    var input = event.target;
    var group = input.getAttribute && input.getAttribute('data-pairs-with');
    if (!group || !input.value.trim()) return;
    var radios = document.querySelectorAll('input[type="radio"][name="' + group + '"]');
    for (var i = 0; i < radios.length; i++) radios[i].checked = false;
  });
  document.addEventListener('change', function (event) {
    var radio = event.target;
    if (!radio || radio.type !== 'radio' || !radio.checked) return;
    var text = document.querySelector('[data-pairs-with="' + radio.name + '"]');
    if (text) text.value = '';
  });

  // الرجوع للصفحة من سجل المتصفح: الأزرار ترجع تشتغل
  window.addEventListener('pageshow', function () {
    var sent = document.querySelectorAll('form[data-sent]');
    for (var i = 0; i < sent.length; i++) { sent[i].removeAttribute('data-sent'); sent[i].classList.remove('is-sending'); }
  });

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target.closest) return;

    // القوائم المنسدلة (حسابي / المزيد) تنقفل لما تضغط برا
    var menus = document.querySelectorAll('details.user-menu[open], details.more[open]');
    for (var m = 0; m < menus.length; m++) {
      if (!menus[m].contains(target)) menus[m].removeAttribute('open');
    }

    // صف الجدول كله يفتح المستند
    var row = target.closest('tr[data-href]');
    if (row && !target.closest('a, button, input, label')) {
      window.location.href = row.getAttribute('data-href');
      return;
    }

    var checkAll = target.closest('[data-check-all]');
    if (checkAll) {
      var boxes = document.querySelectorAll('input[type="checkbox"][name="' + checkAll.getAttribute('data-check-all') + '"]');
      var allChecked = true;
      for (var i = 0; i < boxes.length; i++) { if (!boxes[i].checked) allChecked = false; }
      for (var j = 0; j < boxes.length; j++) { boxes[j].checked = !allChecked; }
      checkAll.textContent = allChecked ? 'تحديد الكل' : 'إلغاء التحديد';
      return;
    }

    var button = target.closest('[data-copy]');
    if (!button) return;
    var input = document.querySelector(button.getAttribute('data-copy'));
    if (!input) return;
    var done = function () {
      var original = button.textContent;
      button.textContent = 'تم النسخ ✓';
      setTimeout(function () { button.textContent = original; }, 1600);
    };
    var fallback = function () {
      input.focus();
      input.select();
      try { if (document.execCommand('copy')) done(); } catch (e) { /* ينسخ المستخدم يدوياً */ }
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(input.value).then(done, fallback);
    else fallback();
  });
  // زر "إلغاء" داخل أي نموذج ينفتح بضغطة: يرجّع الخانات زي ما كانت ويقفله
  document.addEventListener('click', function (event) {
    var btn = event.target && event.target.closest ? event.target.closest('[data-cancel]') : null;
    if (!btn) return;
    event.preventDefault();
    var form = btn.closest('form');
    if (form) {
      form.reset();
      var roles = form.querySelectorAll('select[name="role"]');
      for (var i = 0; i < roles.length; i++) syncRoleBranch(roles[i]);
    }
    var details = btn.closest('details');
    if (details) {
      details.open = false;
      var summary = details.querySelector('summary');
      if (summary) summary.focus();
    }
  });

  // زر "طباعة الفسح": يجيب الملف بنفس طريقة "فتح الفسح" (بيانات، مو تنزيل ملف — عشان برامج التنزيل
  // مثل IDM ما تخطفه)، ويحطه في إطار مخفي داخل الصفحة ويفتح نافذة الطباعة على طول.
  // لو المتصفح ما سمح بالطباعة من الإطار (بعض الجوالات): يفتح صفحة الفسح ويطبع منها.
  document.addEventListener('click', function (event) {
    var btn = event.target && event.target.closest ? event.target.closest('[data-print-pdf]') : null;
    if (!btn) return;
    event.preventDefault();
    if (btn.disabled) return;
    var dataUrl = btn.getAttribute('data-print-pdf');
    var viewUrl = btn.getAttribute('data-view') || '';
    var label = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('is-sending');
    var done = function () { btn.disabled = false; btn.classList.remove('is-sending'); btn.innerHTML = label; };
    var fail = function () { done(); if (viewUrl) window.location.href = viewUrl; };
    fetch(dataUrl, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (data) {
        var bin = atob(data.base64 || '');
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        var old = document.getElementById('print-frame');
        if (old) old.parentNode.removeChild(old);
        var frame = document.createElement('iframe');
        frame.id = 'print-frame';
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;';
        frame.onload = function () {
          setTimeout(function () {
            try { frame.contentWindow.focus(); frame.contentWindow.print(); done(); }
            catch (e) { fail(); }
            // الملف المؤقت ينمسح بعد ما تخلص الطباعة
            setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 60000);
          }, 400);
        };
        frame.src = blobUrl;
        document.body.appendChild(frame);
      })
      .catch(fail);
  });

  // سند التسليم: صورة الجوال الكبيرة تتصغّر قبل الرفع (فيرسيل يرفض أي طلب أكبر من 4.5 ميقا)
  var SHRINK_OVER = 1200 * 1024;
  var MAX_SIDE = 1800;
  function shrinkImage(f) {
    if (!/^image\/(jpeg|png|webp)$/.test(f.type) || f.size <= SHRINK_OVER) return Promise.resolve(f);
    return createImageBitmap(f, { imageOrientation: 'from-image' }).then(function (bmp) {
      var scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      if (bmp.close) bmp.close();
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) {
          if (!blob || blob.size >= f.size) return resolve(f);
          resolve(new File([blob], String(f.name || 'receipt').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
        }, 'image/jpeg', 0.82);
      });
    }).catch(function () { return f; });
  }

  document.addEventListener('change', function (event) {
    var input = event.target;
    if (!input || !input.hasAttribute || !input.hasAttribute('data-receipt') || input._shrinking) return;
    var files = Array.prototype.slice.call(input.files || []);
    var needs = files.some(function (f) { return /^image\//.test(f.type) && f.size > SHRINK_OVER; });
    if (!needs || !window.DataTransfer || !window.createImageBitmap) return showReceipt(input);
    // أثناء التصغير: زر التسليم ينتظر (عشان ما ينرفع الملف الكبير)
    input._shrinking = true;
    var buttons = input.form ? input.form.querySelectorAll('button[type="submit"]') : [];
    for (var k = 0; k < buttons.length; k++) buttons[k].disabled = true;
    var label = input.parentNode.querySelector('[data-receipt-label]');
    if (label) label.textContent = 'جاري تجهيز الصورة…';
    Promise.all(files.map(shrinkImage)).then(function (list) {
      try { var dt = new DataTransfer(); list.forEach(function (f) { dt.items.add(f); }); input.files = dt.files; } catch (_) {}
    }).then(function () {
      input._shrinking = false;
      for (var k2 = 0; k2 < buttons.length; k2++) buttons[k2].disabled = false;
      showReceipt(input);
    });
  });

  // بعد الاختيار يطلع عدد الملفات بدل "صوّر السند"، ومعاينة السند تحت الزر
  function showReceipt(input) {
    var label = input.parentNode.querySelector('[data-receipt-label]');
    if (!label) return;
    var n = input.files ? input.files.length : 0;
    label.textContent = n === 0 ? 'صوّر السند أو اختر ملف' : (n === 1 ? 'تم إرفاق السند ✓' : 'تم إرفاق ' + n + ' مرفقات ✓');
    input.parentNode.classList.toggle('has-file', n > 0);

    // معاينة السند قبل التسليم: الصورة نفسها، والـ PDF باسمه
    var preview = input.parentNode.parentNode.querySelector('[data-receipt-preview]');
    if (!preview) return;
    var old = preview.querySelectorAll('img');
    for (var o = 0; o < old.length; o++) URL.revokeObjectURL(old[o].src);
    preview.textContent = '';
    for (var i = 0; i < n; i++) {
      var f = input.files[i];
      var item;
      if (/^image\//.test(f.type)) {
        item = document.createElement('img');
        item.className = 'receipt-preview-img';
        item.alt = 'سند التسليم';
        item.src = URL.createObjectURL(f);
      } else {
        item = document.createElement('div');
        item.className = 'receipt-preview-file';
        item.textContent = 'PDF · ' + f.name;
        renderPdfPreview(f, item);
      }
      preview.appendChild(item);
    }
    preview.hidden = n === 0;
  }

  // صفحات ملف الـ PDF كصور (نفس مكتبة عارض الفسوحات) — يشتغل حتى في الجوال. لو فشل يبقى اسم الملف
  var PDFJS = '/static/vendor/pdfjs/';
  function renderPdfPreview(file, box) {
    if (!file.arrayBuffer) return;
    Promise.all([import(PDFJS + 'legacy/build/pdf.min.mjs'), file.arrayBuffer()]).then(function (r) {
      var lib = r[0];
      lib.GlobalWorkerOptions.workerSrc = PDFJS + 'legacy/build/pdf.worker.min.mjs';
      return lib.getDocument({
        data: new Uint8Array(r[1]),
        cMapUrl: PDFJS + 'cmaps/', cMapPacked: true,
        standardFontDataUrl: PDFJS + 'standard_fonts/', wasmUrl: PDFJS + 'wasm/', iccUrl: PDFJS + 'iccs/',
        disableWorkerRendering: true
      }).promise;
    }).then(function (pdf) {
      var pages = Math.min(pdf.numPages, 3);
      var shown = false;
      var chain = Promise.resolve();
      for (var p = 1; p <= pages; p++) {
        (function (num) {
          chain = chain.then(function () { return pdf.getPage(num); }).then(function (page) {
            var base = page.getViewport({ scale: 1 });
            // الصفحة كاملة بدون ما تطول كثير
            var cssW = Math.min(box.clientWidth || 600, 460 * base.width / base.height);
            var ratio = Math.min(window.devicePixelRatio || 1, 2) * 1.5;
            var viewport = page.getViewport({ scale: (cssW * ratio) / base.width });
            var canvas = document.createElement('canvas');
            canvas.className = 'receipt-preview-page';
            canvas.width = Math.round(viewport.width);
            canvas.height = Math.round(viewport.height);
            canvas.style.width = Math.round(cssW) + 'px';
            canvas.setAttribute('role', 'img');
            canvas.setAttribute('aria-label', 'سند التسليم');
            return page.render({ canvas: canvas, viewport: viewport }).promise.then(function () {
              if (!shown) { box.textContent = ''; box.className = 'receipt-preview-pdf'; shown = true; }
              box.appendChild(canvas);
            });
          });
        })(p);
      }
      return chain;
    }).catch(function () { /* يبقى اسم الملف */ });
  }

  // حساب الإدارة يشوف كل الفروع: خانة الفرع تختفي لما الدور "الإدارة"
  function syncRoleBranch(role) {
    var form = role.form;
    if (!form) return;
    var parts = form.querySelectorAll('[data-warehouse-only]');
    for (var i = 0; i < parts.length; i++) parts[i].hidden = role.value === 'admin';
  }
  document.addEventListener('change', function (event) {
    var t = event.target;
    if (t && t.tagName === 'SELECT' && t.name === 'role') syncRoleBranch(t);
  });
  var roles = document.querySelectorAll('select[name="role"]');
  for (var r = 0; r < roles.length; r++) syncRoleBranch(roles[r]);

  // زر رفع ملف واحد: أول ما يختار الملف ينرفع (بدون زر ثاني)
  document.addEventListener('change', function (event) {
    var t = event.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-autosubmit') || !t.form || !t.files || !t.files.length) return;
    var label = t.closest('label');
    if (label) label.classList.add('is-busy');
    if (t.form.requestSubmit) t.form.requestSubmit(); else t.form.submit();
  });

  // صفحة تنتظر برنامج الواتساب (يقرأ ملف قائمة العملاء): تتحدث لحالها لين تخلص
  if (document.querySelector('[data-refresh-soon]')) setTimeout(function () { window.location.reload(); }, 8000);
})();
