// SPDX-License-Identifier: LicenseRef-Proprietary
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, expect, test, vi } from "vitest";
import { THEME_KEY, THEMES, knownExperiences } from "./prefs";

const SRC = readFileSync(new URL("../../public/prefs.js", import.meta.url), "utf8");
type Published = Record<"theme" | "experience", { key: string; values: string[] }>;

/** One page load of public/prefs.js over what the device has stored: the attributes it put on <html>, and what it published. */
function boot(stored: Record<string, string> | "blocked" | "unreadable", source = SRC) {
  const attributes: Record<string, string> = {};
  const window: { consolePrefs?: Published } = {};
  const document = { documentElement: { setAttribute: (name: string, value: string) => void (attributes[name] = value) } };
  const context = Object.defineProperty({ window, document }, "localStorage", {
    get() {
      if (stored === "blocked") throw new Error("storage is blocked");
      return {
        getItem(key: string) {
          if (stored === "unreadable") throw new Error("storage cannot be read");
          return Object.hasOwn(stored, key) ? stored[key] : null;
        },
      };
    },
  });
  runInNewContext(source, context);
  return { attributes, published: window.consolePrefs! };
}
// The same script once an experience id has been added to its list.
const withCalm = SRC.replace('experience: { key: "console.experience", values: [] }', 'experience: { key: "console.experience", values: ["calm"] }');

afterEach(() => vi.unstubAllGlobals());

test("a stored theme is on <html> as soon as the script has run", () => {
  expect(boot({ "console.theme": "dark" }).attributes).toEqual({ "data-theme": "dark" });
  expect(boot({ "console.theme": "light" }).attributes).toEqual({ "data-theme": "light" });
});

test("a missing, unknown or malformed value sets nothing", () => {
  expect(boot({}).attributes).toEqual({});
  for (const value of ["", "DARK", "dark ", " dark", '"dark"', "light,dark", "auto", "system", "null", "0", "constructor", "__proto__", "toString", "length"]) {
    expect(boot({ "console.theme": value, "console.experience": value }).attributes, value).toEqual({});
  }
});

test("storage that refuses the read sets nothing and lets the page go on", () => {
  for (const storage of ["blocked", "unreadable"] as const) {
    const page = boot(storage);
    expect(page.attributes).toEqual({});
    expect(page.published.theme.values).toEqual(["light", "dark"]);
  }
});

test("no experience is known yet, so a stored one is never applied", () => {
  expect(boot({}).published.experience).toEqual({ key: "console.experience", values: [] });
  for (const value of ["calm", "baseline", "light", "dark"]) {
    expect(boot({ "console.experience": value, "console.theme": "dark" }).attributes, value).toEqual({ "data-theme": "dark" });
  }
});

test("adding an id to the one list is all it takes for that experience to be applied", () => {
  expect(withCalm).not.toBe(SRC);
  expect(boot({ "console.experience": "calm", "console.theme": "dark" }, withCalm).attributes).toEqual({ "data-theme": "dark", "data-experience": "calm" });
  expect(boot({ "console.experience": "warm" }, withCalm).attributes).toEqual({});
});

test("the bundle uses the key and the themes the boot script applies", () => {
  expect(boot({}).published.theme).toEqual({ key: THEME_KEY, values: [...THEMES] });
});

test("the bundle's known experiences are the boot script's own list", () => {
  expect(knownExperiences()).toEqual([]);
  vi.stubGlobal("consolePrefs", boot({}, withCalm).published);
  expect(knownExperiences()).toEqual(["calm"]);
});

test("the known experiences are exactly the ones with a token file", () => {
  // The token gates take an experience's id from its file name; a list that differed would apply nothing, or an id with no tokens.
  const dir = new URL("../../../../packages/tokens/experiences/", import.meta.url);
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".css")).map((name) => name.slice(0, -".css".length)) : [];
  expect([...boot({}).published.experience.values].sort()).toEqual(files.sort());
});

test("the boot script blocks the parser ahead of the entry, so it has run before anything can paint", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  // No async, defer or module type: any of them lets the page render before the script runs.
  expect(html.match(/<script\b[^>]*prefs\.js[^>]*>/g)).toEqual(['<script src="/prefs.js">']);
  expect(html.indexOf('<script src="/prefs.js">')).toBeLessThan(html.indexOf('<script type="module"'));
});
