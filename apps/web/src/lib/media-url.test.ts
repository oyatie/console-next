// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { safeMediaUrl } from "./media-url";

beforeEach(() => vi.stubGlobal("location", { origin: "https://console.example" }));
afterEach(() => vi.unstubAllGlobals());

test.each(["https://console.example", "http://localhost:5173", "http://192.168.1.10:5173"])("root-relative photos are parsed against the browser origin: %s", (origin) => {
  vi.stubGlobal("location", { origin });
  expect(safeMediaUrl("/photos/../photo.png?version=1#preview")).toBe(`${origin}/photo.png?version=1#preview`);
});

test.each([
  "https://media.example/photo.png", "/api/photo.png?version=1",
  "http://127.0.0.1:28433/photo.png", "http://[::1]:28433/photo.png", "http://localhost:28433/photo.png",
  "blob:https://console.example/photo", "data:image/png;base64,aGVsbG8=",
])("image allowlist preserves a supported URL: %s", (url) => {
  expect(safeMediaUrl(url)).toBe(new URL(url, "https://console.example").href);
});

test.each([
  "http://media.example/photo.png", "http://192.168.1.1/photo.png", "http://127.0.0.2/photo.png",
  "http://localhost.example/photo.png", "http://127.0.0.1.example/photo.png", "http://localhost@media.example/photo.png",
  "javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zy8+", "data:text/html;base64,aGVsbG8=",
  "//media.example/photo.png", "/\\media.example/photo.png", "blob:null/photo", undefined, null, "",
])("image allowlist refuses an unsafe URL: %s", (url) => {
  expect(safeMediaUrl(url)).toBeNull();
});
