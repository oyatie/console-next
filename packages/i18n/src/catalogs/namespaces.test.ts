import { readdirSync } from "node:fs";
import { expect, test } from "vitest";
import { en } from "./en";
import { ko } from "./ko";

// File name (kebab-case) ↔ id prefix (camelCase): ko/period-locks.ts holds the `periodLocks.` ids.
const files = (locale: string) => readdirSync(new URL(`./${locale}`, import.meta.url)).filter((f) => f.endsWith(".ts")).sort();
const prefix = (file: string) => file.replace(/\.ts$/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

test("ko and en have the same namespace files", () => {
  expect(files("en")).toEqual(files("ko"));
});

for (const [locale, merged] of [["ko", ko], ["en", en]] as const) {
  test(`${locale}: each namespace file holds only its own ids, and the index spreads every file once`, async () => {
    let total = 0;
    for (const file of files(locale)) {
      const exports = Object.values(await import(`./${locale}/${file}`)) as Record<string, string>[];
      expect(exports, file).toHaveLength(1);
      const ids = Object.keys(exports[0] ?? {});
      expect(ids.filter((id) => !id.startsWith(`${prefix(file)}.`)), file).toEqual([]);
      expect(ids.filter((id) => !(id in merged)), `${file} is not spread into ${locale}.ts`).toEqual([]);
      total += ids.length;
    }
    // Equal counts plus every id present means no id is defined in two files.
    expect(Object.keys(merged)).toHaveLength(total);
  });
}
