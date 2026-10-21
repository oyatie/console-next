// SPDX-License-Identifier: LicenseRef-Proprietary
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const source = fileURLToPath(new URL("../..", import.meta.url));
const catalogs = resolve(source, "../../../packages/i18n/src/catalogs");
const files = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.[jt]sx?$/.test(entry.name) && !/\.(?:test|spec)\.[^.]+$/.test(entry.name) ? [path] : [];
  });

test("date UI has no native date inputs or ad hoc locale formatters", () => {
  const violations = files(source).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    const nativeDate = /\btype\s*=\s*(?:["']date["']|\{\s*["']date["']\s*\}|date\b)/i.exec(text);
    const localeFormatter = /\.toLocale(?:DateString|TimeString|String)\s*\(/.exec(text);
    return [
      nativeDate && `${path}: native input type=date`,
      localeFormatter && `${path}: ad hoc toLocale date formatting`,
    ].filter(Boolean);
  });
  expect(violations).toEqual([]);
});

test("date catalog messages do not hard-code ISO dates", () => {
  const violations = files(catalogs).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return [...text.matchAll(/^\s*["'][^"']+["']:\s*["'][^"']*\b\d{4}-\d{2}-\d{2}\b[^"']*["']/gm)]
      .map((match) => `${path}: ${match[0].trim()}`);
  });
  expect(violations).toEqual([]);
});
