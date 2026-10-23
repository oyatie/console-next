// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup as html } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Avatar } from "./avatar";

beforeEach(() => vi.stubGlobal("location", { origin: "https://console.example" }));
afterEach(() => vi.unstubAllGlobals());

test.each([
  "javascript:alert(1)", " java\tscript:alert(1)", "JaVaScRiPt:alert(1)",
  "data:text/html,<script>alert(1)</script>", "data:image/svg+xml,<svg/>", "data:image/svg+xml;base64,PHN2Zy8+",
  "http://example.com/photo.png", "//example.com/photo.png", "/\\example.com/photo.png",
  "file:///photo.png", "invalid-url",
  "blob:javascript:alert(1)", "blob:data:text/html,hello", "/\n/example.com/photo.png",
])("unsafe photo URL falls back without claiming to be the photo: %s", (src) => {
  const markup = html(<Avatar name="Kim" src={src} alt="Kim 사진" />);
  expect(markup).not.toContain("<img");
  expect(markup).toContain('aria-hidden="true"');
  expect(markup).not.toContain("Kim 사진");
  expect(markup).toContain(">K</span>");
});

test.each([
  "https://example.com/photo.png", "/photo.png",
  "http://127.0.0.1:28433/photo.png", "http://[::1]:28433/photo.png", "http://localhost:28433/photo.png",
  "blob:https://example.com/photo", "data:image/png;base64,aGVsbG8=",
])("allowed photo URL preserves the image and accessible name: %s", (src) => {
  const markup = html(<Avatar name="Kim" src={src} alt="Photo" />);
  expect(markup).toContain(`<img`);
  expect(markup).toContain(`src="${new URL(src, "https://console.example").href}"`);
  expect(markup).toContain('alt="Photo"');
});

test.each([undefined, "javascript:alert(1)"])("an absent or refused photo can name its initials fallback: %s", (src) => {
  const markup = html(<Avatar name="Kim" src={src} alt="Kim 사진" fallbackAlt="사진 없음" />);
  expect(markup).not.toContain("<img");
  expect(markup).toContain('role="img" aria-label="사진 없음"');
  expect(markup).not.toContain("Kim 사진");
});
