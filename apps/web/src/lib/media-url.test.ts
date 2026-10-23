// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { safeMediaUrl } from "./media-url";

test.each([
  "https://media.example/photo.png", "/api/photo.png?version=1",
  "http://127.0.0.1:28433/photo.png", "http://[::1]:28433/photo.png", "http://localhost:28433/photo.png",
  "blob:https://console.example/photo", "data:image/png;base64,aGVsbG8=",
])("image allowlist preserves a supported URL: %s", (url) => {
  expect(safeMediaUrl(url, "image")).toBe(url);
});

test.each([
  "http://media.example/photo.png", "http://192.168.1.1/photo.png", "http://127.0.0.2/photo.png",
  "http://localhost.example/photo.png", "http://127.0.0.1.example/photo.png", "http://localhost@media.example/photo.png",
  "javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zy8+", "data:text/html;base64,aGVsbG8=",
  "//media.example/photo.png", "/\\media.example/photo.png", "blob:null/photo", undefined, null, "",
])("image allowlist refuses an unsafe URL: %s", (url) => {
  expect(safeMediaUrl(url, "image")).toBeNull();
});

test.each([
  "https://media.example/document.pdf", "/api/document.pdf", "http://127.0.0.1/document.pdf",
  "http://[::1]/document.pdf", "http://localhost/document.pdf", "javascript:alert(1)",
  "data:image/png;base64,aGVsbG8=", "data:image/svg+xml;base64,PHN2Zy8+", "blob:null/document",
])("document allowlist refuses remote, root-relative and data URLs: %s", (url) => {
  expect(safeMediaUrl(url, "document")).toBeNull();
});

test("document allowlist preserves a local object URL", () => {
  const url = "blob:https://console.example/document";
  expect(safeMediaUrl(url, "document")).toBe(url);
});
