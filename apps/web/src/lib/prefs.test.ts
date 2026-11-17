// SPDX-License-Identifier: LicenseRef-Proprietary
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { THEME_KEY, THEMES } from "./prefs";

const SRC = readFileSync(new URL("../../public/prefs.js", import.meta.url), "utf8");
type Published = Record<"theme" | "experience", { key: string; values: string[] }>;

/**
 * One page load of public/prefs.js over what the device has stored and the theme its system prefers (none given: a
 * browser with no matchMedia): the attributes it put on <html>, and what it published.
 */
function boot(stored: Record<string, string> | "blocked" | "unreadable", source = SRC, system?: "light" | "dark" | "throws") {
  const attributes: Record<string, string> = {};
  const window: { consolePrefs?: Published } = {};
  const document = { documentElement: { setAttribute: (name: string, value: string) => void (attributes[name] = value) } };
  const matchMedia = (query: string) => {
    if (system === "throws") throw new Error("matchMedia is refused");
    return { matches: query === `(prefers-color-scheme: ${system})` };
  };
  const context = Object.defineProperty({ window, document, ...(system && { matchMedia }) }, "localStorage", {
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
test("a stored theme is on <html> as soon as the script has run, whatever the system prefers", () => {
  expect(boot({ "console.theme": "dark" }, SRC, "light").attributes).toEqual({ "data-theme": "dark" });
  expect(boot({ "console.theme": "light" }, SRC, "dark").attributes).toEqual({ "data-theme": "light" });
});

test("a missing, unknown or malformed theme follows the system, and such an experience sets nothing", () => {
  for (const system of ["dark", "light"] as const) {
    expect(boot({}, SRC, system).attributes).toEqual({ "data-theme": system });
    for (const value of ["", "DARK", "dark ", " dark", '"dark"', "light,dark", "auto", "system", "null", "0", "constructor", "__proto__", "toString", "length"]) {
      expect(boot({ "console.theme": value, "console.experience": value }, SRC, system).attributes, value).toEqual({ "data-theme": system });
    }
  }
});

test("storage that refuses the read leaves the theme to the system and lets the page go on", () => {
  for (const storage of ["blocked", "unreadable"] as const) {
    const page = boot(storage, SRC, "dark");
    expect(page.attributes).toEqual({ "data-theme": "dark" });
    expect(page.published.theme.values).toEqual(["light", "dark"]);
  }
});

test("a browser that cannot say what the system prefers sets a stored theme and no other", () => {
  for (const system of [undefined, "throws"] as const) {
    expect(boot({}, SRC, system).attributes, system).toEqual({});
    expect(boot({ "console.theme": "midnight" }, SRC, system).attributes, system).toEqual({});
    const page = boot({ "console.theme": "dark" }, SRC, system);
    expect(page.attributes, system).toEqual({ "data-theme": "dark" });
    expect(page.published.theme.values).toEqual(["light", "dark"]);
  }
});

for (const experience of ["warm-clear", "control-room"]) {
  test(`${experience} applies the stored choice before the bundle in either theme`, () => {
    for (const theme of THEMES) {
      expect(boot({ "console.experience": experience, "console.theme": theme }).attributes).toEqual({ "data-theme": theme, "data-experience": experience });
    }
  });
}

test("an unknown experience never applies", () => {
  for (const value of ["calm", "baseline", "light", "dark", "Warm-clear", "control-room "]) {
    expect(boot({ "console.experience": value, "console.theme": "dark" }).attributes, value).toEqual({ "data-theme": "dark" });
  }
});

test("the bundle uses the key and the themes the boot script applies", () => {
  expect(boot({}).published.theme).toEqual({ key: THEME_KEY, values: [...THEMES] });
});

test("only the supported experiences are registered", () => {
  expect(boot({}).published.experience).toEqual({ key: "console.experience", values: ["warm-clear", "control-room"] });
});

test("the known experiences are exactly the ones with a token file", () => {
  // The token gates take an experience's id from its file name; a list that differed would apply nothing, or an id with no tokens.
  const dir = new URL("../../../../packages/tokens/experiences/", import.meta.url);
  expect(existsSync(new URL("../tokens.css", dir)), "the folder is looked for beside the base token file").toBe(true);
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".css")).map((name) => name.slice(0, -".css".length)) : [];
  expect([...boot({}).published.experience.values].sort()).toEqual(files.sort());
});

test("the boot script blocks the parser ahead of the entry, so it has run before anything can paint", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  // No async, defer or module type: any of them lets the page render before the script runs.
  expect(html.match(/<script\b[^>]*prefs\.js[^>]*>/g)).toEqual(['<script src="/prefs.js">']);
  expect(html.indexOf('<script src="/prefs.js">')).toBeLessThan(html.indexOf('<script type="module"'));
});
