// A deploy can leave a page whose index.html names chunks the server no longer has: a blue/green switch, or a
// browser that revalidated a stale cached index.html. This classic script sits outside the hashed bundle so it still
// runs when the entry chunk itself (or one of its static imports) is gone, and it owns the one decision for the
// whole app (src/lib/chunk-guard.ts calls it for lazy chunks): reload once per build, then show an error screen.
// The reload is a navigation to a fresh URL (`_r`), so the browser fetches index.html instead of revalidating it.
(function () {
  var PREFIX = "console.chunk-reload:";
  var BUST = /([?&])_r=\d+$/;
  var reloading = false;
  var gaveUp = false;
  var started = false;
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
    ko: ["화면을 표시하지 못했습니다", "새 버전이 배포되었거나 일시적인 오류일 수 있습니다. 페이지를 새로 고치십시오.", "페이지 새로 고침", "지원 참조 번호", "지원 참조 번호 복사", "지원 참조 번호를 복사했습니다", "복사하지 못했습니다. 지원 참조 번호를 선택해 직접 복사하십시오."],
    en: ["Couldn’t show this screen", "A new version may have been released, or this may be a temporary error. Reload the page.", "Reload page", "Support reference", "Copy support reference", "Support reference copied", "Could not copy. Select and copy the full support reference."],
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
    start: function () {
      started = true;
    },
  };
})();
