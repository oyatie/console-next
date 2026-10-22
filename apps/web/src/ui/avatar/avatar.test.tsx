// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup as html } from "react-dom/server";
import { expect, test } from "vitest";
import { Avatar } from "./avatar";

test.each([
  "javascript:alert(1)", " java\tscript:alert(1)", "JaVaScRiPt:alert(1)",
  "data:text/html,<script>alert(1)</script>", "data:image/svg+xml,<svg/>",
  "http://example.com/photo.png", "//example.com/photo.png", "/\\example.com/photo.png",
  "file:///photo.png", "invalid-url",
  "blob:javascript:alert(1)", "blob:data:text/html,hello", "/\n/example.com/photo.png",
])("unsafe photo URL falls back to the named initial: %s", (src) => {
  const markup = html(<Avatar name="Kim" src={src} alt="Missing photo" />);
  expect(markup).not.toContain("<img");
  expect(markup).toContain('role="img" aria-label="Missing photo"');
  expect(markup).toContain(">K</span>");
});

test.each([
  "https://example.com/photo.png", "/photo.png",
  "blob:https://example.com/photo", "data:image/png;base64,aGVsbG8=",
])("allowed photo URL preserves the image and accessible name: %s", (src) => {
  const markup = html(<Avatar name="Kim" src={src} alt="Photo" />);
  expect(markup).toContain(`<img`);
  expect(markup).toContain(`src="${src}"`);
  expect(markup).toContain('alt="Photo"');
});
