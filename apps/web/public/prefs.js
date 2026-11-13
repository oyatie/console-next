// SPDX-License-Identifier: LicenseRef-Proprietary
// Appearance before the first paint. The shell that applies the theme is a lazy chunk, so until it mounted (sign-in,
// every first paint) the page was light whatever was stored or the system preferred. This classic script sits before
// the module entry, outside the hashed bundle (the content security policy allows no inline script), and puts on
// <html> each stored choice it knows. It only reads: src/shell/theme.ts stays the one place that changes the theme
// and writes the store.
(function () {
  // Per attribute (data-<name>): its storage key and the closed list of values. Anything else stored is no choice.
  var prefs = {
    theme: { key: "console.theme", values: ["light", "dark"] },
    // An experience becomes known by adding its id to this list; a test holds the list to the experience token files.
    experience: { key: "console.experience", values: [] },
  };
  // With no stored theme the shell follows the system (src/shell/theme.ts), so the first paint does too.
  function system() {
    try {
      return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {
      // A browser that cannot say gets no attribute.
      return null;
    }
  }
  for (var name in prefs) {
    var value = null;
    try {
      value = localStorage.getItem(prefs[name].key);
    } catch {
      // Storage can refuse the read (private mode, blocked site data): that is no choice either.
    }
    if (prefs[name].values.indexOf(value) < 0) value = name === "theme" ? system() : null;
    if (value) document.documentElement.setAttribute("data-" + name, value);
  }
  // Published so there is one list of each. Today only tests read them; choosing an experience will check against them.
  window.consolePrefs = prefs;
})();
