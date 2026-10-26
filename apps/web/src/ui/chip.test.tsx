// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { Chip } from "./chip";

test.each(["ok", "warn", "danger", "info", "neutral"] as const)("%s chips retain text and their tone class", tone => {
  const label = "State";
  expect(html(<Chip tone={tone}>{label}</Chip>)).toBe(`<span class="chip chip--${tone}">${label}</span>`);
});
