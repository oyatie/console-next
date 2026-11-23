// A deploy can leave a page whose index.html names chunks the server no longer has: a blue/green switch, or a
// browser that revalidated a stale cached index.html. This classic script sits outside the hashed bundle so it still
// runs when the entry chunk itself (or one of its static imports) is gone, and it owns the one decision for the
// whole app (src/lib/chunk-guard.ts calls it for lazy chunks): reload once per build, then show an error screen.
// The reload is a navigation to a fresh URL (`_r`), so the browser fetches index.html instead of revalidating it.
(function () {
  var PREFIX = "console.chunk-reload:";
  var BUST = /([?&])_r=\d+$/;
  var DEFAULT_STATUS_ORIGIN = "https://status.cosskorea.com";
  var reloading = false;
  var gaveUp = false;
  var started = false;
  var leaving = false;
  var statusOrigin = DEFAULT_STATUS_ORIGIN;
  function isLoopbackHost(hostname) {
    return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost";
  }
  function hasAsciiControl(value) {
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);
      if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
  }
  function hasUnsafeOriginChars(value) {
    if (hasAsciiControl(value) || /\s/.test(value)) return true;
    for (var i = 0; i < value.length; i++) {
      var ch = value[i];
      if (ch === "*" || ch === ";" || ch === "," || ch === "'" || ch === '"' || ch === "\\" || ch === "%" || ch === "@") {
        return true;
      }
    }
    return false;
  }
  function resolveOrigin(raw) {
    if (typeof raw !== "string" || !raw || hasAsciiControl(raw)) return DEFAULT_STATUS_ORIGIN;
    var trimmed = raw.trim();
    if (!trimmed) return DEFAULT_STATUS_ORIGIN;
    if (
      hasUnsafeOriginChars(trimmed) ||
      trimmed.slice(-1) === "/" ||
      trimmed.slice(-2) === "/." ||
      trimmed.slice(-3) === "/.."
    ) {
      return DEFAULT_STATUS_ORIGIN;
    }
    if (typeof URL === "function") {
      try {
        var parsed = new URL(trimmed);
        if (parsed.username || parsed.password || parsed.search || parsed.hash) return DEFAULT_STATUS_ORIGIN;
        if (parsed.pathname !== "/" || parsed.port === "0") return DEFAULT_STATUS_ORIGIN;
        if (
          parsed.origin === "null" ||
          !parsed.hostname ||
          hasUnsafeOriginChars(parsed.hostname) ||
          hasUnsafeOriginChars(parsed.origin)
        ) {
          return DEFAULT_STATUS_ORIGIN;
        }
        if (parsed.protocol === "https:") return parsed.origin;
        if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return parsed.origin;
        return DEFAULT_STATUS_ORIGIN;
      } catch {
        return DEFAULT_STATUS_ORIGIN;
      }
    }
    var match = /^(https?):\/\/([^/?#]+)$/i.exec(trimmed);
    if (!match) return DEFAULT_STATUS_ORIGIN;
    var scheme = match[1].toLowerCase();
    var hostMatch = /^(\[[0-9a-fA-F:]+\]|[^:[\]]+)(?::(\d+))?$/.exec(match[2]);
    if (!hostMatch) return DEFAULT_STATUS_ORIGIN;
    var host = hostMatch[1].toLowerCase();
    var portStr = hostMatch[2];
    if (host.charAt(0) !== "[" && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(host)) {
      return DEFAULT_STATUS_ORIGIN;
    }
    var port = "";
    if (portStr !== undefined) {
      var portNum = Number(portStr);
      if (portNum < 1 || portNum > 65535) return DEFAULT_STATUS_ORIGIN;
      var isDefault = (scheme === "https" && portNum === 443) || (scheme === "http" && portNum === 80);
      if (!isDefault) port = ":" + String(portNum);
    }
    if (scheme === "https") return "https://" + host + port;
    if (scheme === "http" && isLoopbackHost(host)) return "http://" + host + port;
    return DEFAULT_STATUS_ORIGIN;
  }
  // Firefox aborts imports before pagehide; recovery must not cancel the navigation that aborted them.
  window.addEventListener("beforeunload", function () { leaving = true; });
  window.addEventListener("pageshow", function () { leaving = false; });
  // The busting parameter is only for the request: drop it before the router reads the URL.
  if (BUST.test(location.search)) history.replaceState(history.state, "", location.pathname + location.search.replace(BUST, "") + location.hash);

  // The running build: its entry script's URL (content-hashed in a build). Read late: the tag follows this script.
  function version() {
    var s = document.querySelectorAll('script[type="module"][src]');
    return s.length ? s[s.length - 1].src : location.pathname;
  }
  function reload() {
    reloading = true;
    var q = location.search.replace(BUST, "");
    location.replace(location.pathname + q + (q ? "&" : "?") + "_r=" + Date.now() + location.hash);
  }
  // True: a reload is under way. False: this build already reloaded once (or storage is unavailable): show an error.
  function recover() {
    if (leaving) return true;
    if (reloading) return true;
    try {
      var key = PREFIX + version();
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, "1");
      else gaveUp = true;
    } catch {
      gaveUp = true;
    }
    if (gaveUp) return false;
    reload();
    return true;
  }
  // The page booted, routed and has its screen catalog: forget the reloads, so a later deploy may reload again.
  function loaded() {
    if (reloading || gaveUp) return;
    try {
      for (var i = sessionStorage.length - 1; i >= 0; i--) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) sessionStorage.removeItem(k);
      }
    } catch {}
  }
  // The static error screen (common.crashed.* in packages/i18n boot.ts; a test keeps them equal). Plain DOM with the
  // DS class names: the stylesheet may be what failed, so it reads unstyled too.
  var COPY = {
    ko: ["화면을 표시하지 못했습니다", "새 버전이 배포되었거나 일시적인 오류일 수 있습니다. 페이지를 새로 고치십시오.", "페이지 새로 고침", "지원 참조 번호", "지원 참조 번호 복사", "지원 참조 번호를 복사했습니다", "복사하지 못했습니다. 지원 참조 번호를 선택해 직접 복사하십시오.", "상태 페이지 보기", "작성 중이던 내용은 이 탭을 닫기 전까지 유지됩니다."],
    en: ["Couldn’t show this screen", "A new version may have been released, or this may be a temporary error. Reload the page.", "Reload page", "Support reference", "Copy support reference", "Support reference copied", "Could not copy. Select and copy the full support reference.", "View status page", "Unsaved input stays in this tab until you close it."],
  };
  function fail() {
    if (document.getElementById("chunk-fallback")) return;
    var en = false;
    try {
      en = localStorage.getItem("console.locale") === "en";
    } catch {}
    var c = COPY[en ? "en" : "ko"];
    var main = document.createElement("main");
    main.id = "chunk-fallback";
    main.className = "page";
    main.innerHTML = '<div class="state" role="alert"><h2 class="state__title"></h2><span class="muted"></span><div class="state__actions"><button type="button" class="btn btn--primary"></button></div></div>';
    main.querySelector("h2").textContent = c[0];
    main.querySelector("span").textContent = c[1];
    var button = main.querySelector("button");
    button.textContent = c[2];
    button.addEventListener("click", reload);
    var rootEl = document.documentElement;
    var exp = rootEl && typeof rootEl.getAttribute === "function" ? rootEl.getAttribute("data-experience") : null;
    if (exp === "console" || exp === "warm-clear") {
      var extras = document.createElement("div");
      extras.className = "state__extras";
      var link = document.createElement("a");
      link.className = "btn btn--sm";
      link.href = statusOrigin;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = c[7];
      var note = document.createElement("div");
      note.className = "muted";
      note.textContent = c[8];
      extras.appendChild(link);
      extras.appendChild(note);
      main.querySelector(".state").appendChild(extras);
    }
    var root = document.getElementById("root");
    if (root) root.hidden = true;
    (document.body || document.documentElement).appendChild(main);
    if (window.consoleErrorBeacon) window.consoleErrorBeacon.reference().then(function (receipt) {
      if (!receipt) return;
      var reference = receipt.support_ref;
      var box = document.createElement("div");
      box.setAttribute("data-support-reference", reference);
      box.className = "muted";
      var label = document.createElement("code");
      label.textContent = c[3] + " ref " + reference.slice(0, 8);
      label.title = "ref " + reference;
      var time = document.createElement("time");
      time.dateTime = receipt.support_ref_at;
      time.textContent = receipt.support_ref_at ? receipt.support_ref_at.slice(0, 19).replace("T", " ") + " UTC" : "";
      var copy = document.createElement("button");
      copy.type = "button";
      copy.className = "btn";
      copy.textContent = c[4];
      var status = document.createElement("span");
      status.setAttribute("role", "status");
      copy.addEventListener("click", function () {
        if (!navigator.clipboard) { label.textContent = c[3] + " ref " + reference; status.textContent = c[6]; return; }
        navigator.clipboard.writeText("ref " + reference).then(function () { status.textContent = c[5]; }, function () { label.textContent = c[3] + " ref " + reference; status.textContent = c[6]; });
      });
      box.appendChild(label);
      box.appendChild(document.createTextNode(" · "));
      box.appendChild(time);
      box.appendChild(document.createTextNode(" · "));
      box.appendChild(copy);
      box.appendChild(status);
      main.querySelector(".state").appendChild(box);
    });
  }

  // The entry chunk, its static imports or its stylesheet failed: nothing bundled will run, so decide here. Once the
  // entry runs (started), lazy chunks are the bundle's to handle (their import rejects; src/lib/chunk-guard.ts).
  window.addEventListener(
    "error",
    function (e) {
      var el = e.target;
      if (started || !el || !el.tagName) return;
      var boot = el.tagName === "SCRIPT" ? el.type === "module" : el.tagName === "LINK" && /^(modulepreload|stylesheet)$/.test(el.rel);
      if (boot && !recover()) fail();
    },
    true,
  );
  // Give an importing component's catch handler one turn to claim an error for its local boundary.
  var preloadErrors = new WeakMap();
  window.addEventListener("vite:preloadError", function (event) {
    if (event.payload && typeof event.payload === "object") preloadErrors.set(event.payload, event);
    setTimeout(function () { if (!event.defaultPrevented) recover(); }, 0);
  });

  window.consoleChunkGuard = {
    handled: function (error) {
      var event = preloadErrors.get(error);
      if (event) event.preventDefault();
    },
    recover: recover,
    reload: reload,
    loaded: loaded,
    fail: fail,
    start: function (origin) {
      started = true;
      statusOrigin = resolveOrigin(origin);
    },
  };
})();
