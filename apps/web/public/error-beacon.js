// First-party client error beacon (B-01). A white screen is otherwise invisible to every alert: nothing in the
// bundle runs when the entry chunk, a static import or a stylesheet is gone, so this classic script sits before the
// module entry, outside the hashed bundle. It reports one of five kinds to our own origin (never a third party):
// error, rejection, resource, preload, boot. No message, stack, query string, hash or form value ever leaves: only
// the kind, the build (entry chunk hash), the route with ids collapsed and the error's constructor name.
// Contract: console-infra ops contracts "B-01" (POST /api/v1/client-errors, at most 2 KiB, 204).
// public/chunk-guard.js (when present) owns the reload; this script only reports, and sendBeacon survives the reload.
(function () {
  var ENDPOINT = "/api/v1/client-errors";
  var CAP = 10; // per page load: a render loop must not flood our own origin
  var BOOT_MS = 15000;
  var sent = 0;
  var seen = typeof WeakSet === "function" ? new WeakSet() : null;

  // The running build: the entry chunk's hash (/assets/index-<hash>.js), "dev" under Vite's dev server. Read late:
  // the entry tag follows this script.
  function build() {
    var s = document.querySelectorAll('script[type="module"][src]');
    var m = s.length ? /\/index-([A-Za-z0-9_-]{1,16})\.js$/.exec(String(s[s.length - 1].src).split(/[?#]/)[0]) : null;
    return m ? m[1] : "dev";
  }
  // The path as a pattern: a segment that is a number, a UUID, a long token or anything outside a plain word
  // (a name, an encoded value) becomes :id. Never the query or the hash.
  function route() {
    var parts = String(location.pathname).split("/");
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p && (!/^[A-Za-z0-9._-]+$/.test(p) || /^\d+$/.test(p) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(p) || p.length > 32 || (p.length >= 16 && /\d/.test(p)))) parts[i] = ":id";
    }
    return parts.join("/").slice(0, 64) || "/";
  }
  function report(kind, err) {
    if (sent >= CAP) return;
    if (err && (typeof err === "object" || typeof err === "function") && seen) {
      if (seen.has(err)) return; // vite:preloadError rethrows the same error as an unhandled rejection
      seen.add(err);
    }
    sent++;
    var body = { kind: kind, build: build(), release: build(), route: route() };
    var name = err && typeof err === "object" ? err.name : undefined;
    if (typeof name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(name)) body.name = name;
    var data = JSON.stringify(body);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, data)) return;
    } catch {}
    try {
      fetch(ENDPOINT, { method: "POST", body: data, keepalive: true }).catch(function () {});
    } catch {}
  }

  // Recovery screens need a response; beacons continue to use the unload-safe 204 transport.
  window.consoleErrorBeacon = {
    reference: function (token) {
      var headers = { "Accept": "application/json" };
      if (token) headers.Authorization = "Bearer " + token;
      return fetch(ENDPOINT, { method: "POST", headers: headers,
        body: JSON.stringify({ kind: "reference", build: build(), release: build(), route: route() }) })
        .then(function (r) { if (!r.ok) return null; return r.json(); })
        .then(function (body) { return body && typeof body.support_ref === "string" ? body : null; })
        .catch(function () { return null; });
    },
  };

  // Capture phase: a module script, modulepreload or stylesheet that failed to load (these do not bubble), and every
  // uncaught exception (target window).
  window.addEventListener(
    "error",
    function (e) {
      var el = e.target;
      if (el && el.tagName) {
        var boot = el.tagName === "SCRIPT" ? el.type === "module" : el.tagName === "LINK" && /^(modulepreload|stylesheet)$/.test(el.rel);
        if (boot) report("resource", el);
        return;
      }
      report("error", e.error);
    },
    true,
  );
  window.addEventListener("unhandledrejection", function (e) {
    report("rejection", e.reason);
  });
  window.addEventListener("vite:preloadError", function (e) {
    report("preload", e.payload);
  });

  // Boot watchdog: #root still empty 15 s after this ran, counted only while the page is visible (a background tab
  // may never render; it is re-checked 15 s after it shows).
  function watch() {
    setTimeout(function () {
      var root = document.getElementById("root");
      if (root && root.firstElementChild) return;
      if (document.visibilityState === "hidden") {
        var shown = function () {
          if (document.visibilityState === "hidden") return;
          document.removeEventListener("visibilitychange", shown);
          watch();
        };
        document.addEventListener("visibilitychange", shown);
        return;
      }
      report("boot");
    }, BOOT_MS);
  }
  watch();
})();
