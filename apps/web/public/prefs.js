// SPDX-License-Identifier: LicenseRef-Proprietary
// Appearance before the first paint. The shell that applies the theme is a lazy chunk, so until it mounted (sign-in,
// every first paint) the page ignored a stored dark theme. This classic script sits before the module entry, outside
// the hashed bundle (the content security policy allows no inline script), and copies each stored choice it knows
// onto <html>. It only reads: src/shell/theme.ts stays the one place that changes the theme and writes the store.
(function () {
  // Per attribute (data-<name>): its storage key and the closed list of values. Anything else stored sets nothing.
  var prefs = {
    theme: { key: "console.theme", values: ["light", "dark"] },
    // An experience becomes known by adding its id to this list; a test holds the list to the experience token files.
    experience: { key: "console.experience", values: [] },
  };
  for (var name in prefs) {
    var value = null;
    try {
      value = localStorage.getItem(prefs[name].key);
    } catch {
      // Storage can refuse the read (private mode, blocked site data): nothing is known, so nothing is set.
    }
    if (prefs[name].values.indexOf(value) >= 0) document.documentElement.setAttribute("data-" + name, value);
  }
  // The bundle checks a choice against these same lists (src/lib/prefs.ts), so the two cannot disagree.
  window.consolePrefs = prefs;
})();
