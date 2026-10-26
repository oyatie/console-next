// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { GateRail } from "./gate-rail";

beforeAll(() => loadCatalog("ko"));
test.each([false, true])("the current step is announced, including failed=%s", failed => {
  const steps = ["first", "second", "third"].map(key => ({ key, label: key }));
  const out = html(<GateRail steps={steps} current="second" failed={failed} />);
  expect(out).toContain('data-state="done"');
  expect(out).toContain(`data-state="${failed ? "failed" : "current"}" aria-current="step"`);
  expect(out).toContain('data-state="todo"');
});
