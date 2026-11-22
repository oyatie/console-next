// SPDX-License-Identifier: LicenseRef-Proprietary
// Apply theme preference and console experience before first paint without inline script (CSP script-src 'self').
(function () {
  var THEME_KEY = "console.ops.theme";
  var ALLOWED = ["light", "dark"];
  function systemTheme() {
    try {
      return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {
      return "light";
    }
  }
  var stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    stored = null;
  }
  var theme = ALLOWED.indexOf(stored) >= 0 ? stored : systemTheme();
  document.documentElement.setAttribute("data-experience", "console");
  document.documentElement.setAttribute("data-theme", theme);
})();
