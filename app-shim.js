// ============================================================================
//  app-shim.js
//  เลียนแบบ google.script.run ของ Google Apps Script
//  ทุกการเรียก  google.script.run.withSuccessHandler(s).withFailureHandler(f).someFn(args...)
//  จะถูกส่งไปที่ POST /api/rpc  →  { fn:'someFn', args:[...] }
//  แล้วเรียก s(result) หรือ f(error) กลับมา — โค้ด UI เดิมไม่ต้องแก้
// ============================================================================
(function () {
  window.google = window.google || {};
  window.google.script = window.google.script || {};

  function callBackend(fn, args, onSuccess, onFailure) {
    fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: fn, args: args })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) { if (onSuccess) onSuccess(d.result); }
        else { if (onFailure) onFailure(new Error((d && d.error) || 'เกิดข้อผิดพลาด')); }
      })
      .catch(function (e) { if (onFailure) onFailure(e); });
  }

  // builder แบบ immutable เหมือน google.script.run จริง
  function makeRunner(onSuccess, onFailure) {
    return new Proxy({}, {
      get: function (_t, prop) {
        if (prop === 'withSuccessHandler') return function (fn) { return makeRunner(fn, onFailure); };
        if (prop === 'withFailureHandler') return function (fn) { return makeRunner(onSuccess, fn); };
        if (prop === 'withUserObject')     return function () { return makeRunner(onSuccess, onFailure); };
        if (prop === 'then' || typeof prop === 'symbol') return undefined; // กัน await/console เผลอ trigger
        // อย่างอื่น = ชื่อฟังก์ชัน backend
        return function () {
          var args = Array.prototype.slice.call(arguments);
          callBackend(prop, args, onSuccess, onFailure);
        };
      }
    });
  }

  // google.script.run คืน builder ใหม่ทุกครั้งที่เข้าถึง
  Object.defineProperty(window.google.script, 'run', {
    configurable: true,
    get: function () { return makeRunner(null, null); }
  });

  // google.script.host (กันกรณี UI เรียก) — แบบ no-op
  window.google.script.host = window.google.script.host || {
    close: function () {},
    setHeight: function () {},
    setWidth: function () {},
    editor: { focus: function () {} }
  };
})();
