/* تحديث الصفحة لحالها (لوحة الإدارة) — ما يحدّث لو المستخدم يكتب أو فاتح خانة */
(function () {
  'use strict';
  var el = document.getElementById('auto-reload');
  if (!el) return;
  var seconds = Number(el.getAttribute('data-seconds')) || 60;

  function busy() {
    var active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return true;
    return !!document.querySelector('main details[open], details.user-menu[open], details.more[open]');
  }

  setInterval(function () {
    if (document.hidden || busy()) return;
    window.location.reload();
  }, seconds * 1000);
})();
