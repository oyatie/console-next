// SPDX-License-Identifier: LicenseRef-Proprietary
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { EXPERIENCE_KEY, SINGLE_KEYS_KEY, THEME_KEY, THEMES, singleKeysOn } from "./prefs";
import { EXPERIENCE_SOURCE_KEY, resolveEffectiveExperience, writeStoredExperience } from "../experience/dom";
import { DEFAULT_EXPERIENCE_ID, experiences } from "../experience/table";

const SRC = readFileSync(new URL("../../public/prefs.js", import.meta.url), "utf8");
type Published = Record<"theme" | "experience", { key: string; values: string[]; default?: string }>;

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
  expect(boot({ "console.theme": "dark" }, SRC, "light").attributes).toEqual({ "data-theme": "dark", "data-experience": "console" });
  expect(boot({ "console.theme": "light" }, SRC, "dark").attributes).toEqual({ "data-theme": "light", "data-experience": "console" });
});

test("a missing, unknown or malformed theme follows the system, and such an experience paints the default style", () => {
  for (const system of ["dark", "light"] as const) {
    expect(boot({}, SRC, system).attributes).toEqual({ "data-theme": system, "data-experience": "console" });
    for (const value of ["", "DARK", "dark ", " dark", '"dark"', "light,dark", "auto", "system", "null", "0", "constructor", "__proto__", "toString", "length"]) {
      expect(boot({ "console.theme": value, "console.experience": value }, SRC, system).attributes, value).toEqual({ "data-theme": system, "data-experience": "console" });
    }
  }
});

test("storage that refuses the read leaves the theme to the system, paints the default style and lets the page go on", () => {
  for (const storage of ["blocked", "unreadable"] as const) {
    const page = boot(storage, SRC, "dark");
    expect(page.attributes).toEqual({ "data-theme": "dark", "data-experience": "console" });
    expect(page.published.theme.values).toEqual(["light", "dark"]);
  }
});

test("a browser that cannot say what the system prefers sets a stored theme and no other", () => {
  for (const system of [undefined, "throws"] as const) {
    expect(boot({}, SRC, system).attributes, system).toEqual({ "data-experience": "console" });
    expect(boot({ "console.theme": "midnight" }, SRC, system).attributes, system).toEqual({ "data-experience": "console" });
    const page = boot({ "console.theme": "dark" }, SRC, system);
    expect(page.attributes, system).toEqual({ "data-theme": "dark", "data-experience": "console" });
    expect(page.published.theme.values).toEqual(["light", "dark"]);
  }
});

for (const experience of ["baseline", "console", "warm-clear"]) {
  test(`${experience} applies the stored choice before the bundle in either theme`, () => {
    for (const theme of THEMES) {
      expect(boot({ "console.experience": experience, "console.theme": theme }).attributes).toEqual({ "data-theme": theme, "data-experience": experience });
    }
  });
}

test("legacy control-room stored on a device upgrades to console at first paint, whatever the default", () => {
  // Under the Console default an unknown value paints Console too, so a Classic default is what tells the upgrade apart.
  const classicDefault = SRC.replace('default: "console"', 'default: "baseline"');
  expect(classicDefault).not.toBe(SRC);
  expect(boot({}, classicDefault).attributes).toEqual({ "data-experience": "baseline" });
  for (const source of [SRC, classicDefault]) {
    expect(boot({ "console.experience": "control-room", "console.theme": "dark" }, source).attributes).toEqual({ "data-theme": "dark", "data-experience": "console" });
  }
});

test("an unknown experience never applies, and the page paints the default style", () => {
  for (const value of ["calm", "light", "dark", "Warm-clear", "baseline ", "console "]) {
    expect(boot({ "console.experience": value, "console.theme": "dark" }).attributes, value).toEqual({ "data-theme": "dark", "data-experience": "console" });
  }
});

test("with nothing stored, sign-in and every first paint before sync are Console", () => {
  expect(boot({}, SRC, "light").attributes).toEqual({ "data-theme": "light", "data-experience": "console" });
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    snapshot: () => Object.fromEntries(data),
  };
}

// What the sync stores for an organization default must paint that default on the next load, before the sync runs again.
for (const [setting, painted] of [["baseline", "baseline"], ["console", "console"]] as const) {
  test(`an organization default of ${setting} is painted as ${painted} on the next first paint`, () => {
    const resolved = resolveEffectiveExperience({
      workspaceLayout: {},
      settingsItems: [{ key: "display.experience", value: setting }],
      storedDevice: { id: null, source: null },
    });
    expect(resolved).toEqual({ id: painted, choice: "tenant", tenantId: painted, source: "tenant" });
    const store = memoryStorage();
    expect(writeStoredExperience(resolved.id, resolved.source, store)).toBe(true);
    // The default needs nothing stored; any other organization default is kept so the next load needs no swap.
    expect(store.snapshot()).toEqual(painted === "console" ? {} : { [EXPERIENCE_KEY]: painted, [EXPERIENCE_SOURCE_KEY]: "tenant" });
    expect(boot(store.snapshot(), SRC, "dark").attributes).toEqual({ "data-theme": "dark", "data-experience": painted });
  });
}

test("the bundle uses the key and the themes the boot script applies", () => {
  expect(boot({}).published.theme).toEqual({ key: THEME_KEY, values: [...THEMES] });
});

test("only the supported experiences are registered, with the bundle's default", () => {
  expect(boot({}).published.experience).toEqual({ key: EXPERIENCE_KEY, values: experiences.map(experience => experience.id), default: DEFAULT_EXPERIENCE_ID });
  expect(boot({}).published.experience.default).toBe("console");
});

test("the known experiences are exactly the ones with a token file", () => {
  // The token gates take an experience's id from its file name; a list that differed would apply nothing, or an id with no tokens.
  const dir = new URL("../../../../packages/tokens/experiences/", import.meta.url);
  expect(existsSync(new URL("../tokens.css", dir)), "the folder is looked for beside the base token file").toBe(true);
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".css")).map((name) => name.slice(0, -".css".length)) : [];
  expect(boot({}).published.experience.values.filter(id => id !== "baseline").sort()).toEqual(files.sort());
});

test("the boot script blocks the parser ahead of the entry, so it has run before anything can paint", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  // No async, defer or module type: any of them lets the page render before the script runs.
  expect(html.match(/<script\b[^>]*prefs\.js[^>]*>/g)).toEqual(['<script src="/prefs.js">']);
  expect(html.indexOf('<script src="/prefs.js">')).toBeLessThan(html.indexOf('<script type="module"'));
});

test("single keys are on unless this device stored off, and stay on when storage refuses the read", () => {
  const own = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const read = (get: () => unknown) => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get });
    return singleKeysOn();
  };
  const stored = (value: string | null) => () => ({ getItem: (key: string) => (key === SINGLE_KEYS_KEY ? value : null) });
  try {
    expect(SINGLE_KEYS_KEY).toBe("console.singleKeys");
    expect(read(stored(null))).toBe(true);
    expect(read(stored("off"))).toBe(false);
    for (const value of ["", "on", "OFF", "false", "0"]) expect(read(stored(value)), value).toBe(true);
    expect(read(() => { throw new Error("storage is blocked"); })).toBe(true);
    expect(read(() => ({ getItem() { throw new Error("storage cannot be read"); } }))).toBe(true);
    expect(read(() => undefined)).toBe(true);
  } finally {
    if (own) Object.defineProperty(globalThis, "localStorage", own);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
