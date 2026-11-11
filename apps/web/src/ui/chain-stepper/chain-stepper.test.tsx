// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { ChainStepper, type ChainStep } from "./chain-stepper";

beforeAll(() => loadCatalog("ko"));
const step = (n: number, state: ChainStep["state"]): ChainStep => ({ key: String(n), who: `결재자${n}`, state });
const six = [step(1, "done"), step(2, "done"), step(3, "done"), step(4, "current"), step(5, "waiting"), step(6, "waiting")];

test("chips keep the current step in view, mark it in text and count the hidden steps", () => {
  const html = renderToStaticMarkup(<ChainStepper variant="chips" steps={six} />);
  expect(html.match(/<li/g)).toHaveLength(4);
  expect(html.match(/aria-current="step"/g)).toHaveLength(1);
  const current = html.slice(html.indexOf('aria-current="step"'));
  expect(current.slice(0, current.indexOf("</li>"))).toContain("지금 단계:");
  expect(current.slice(0, current.indexOf("</li>"))).toContain("결재자4");
  expect(html).toContain("+3");
  // The tooltip carries the whole chain, including the steps the row has no room for.
  const title = /title="([^"]*)"/.exec(html)![1]!;
  for (const n of [1, 2, 3, 4, 5, 6]) expect(title).toContain(`결재자${n}`);
});

test("a short chain shows every step and no overflow count", () => {
  const html = renderToStaticMarkup(<ChainStepper variant="chips" steps={six.slice(2, 5)} />);
  expect(html.match(/<li/g)).toHaveLength(3);
  expect(html).not.toContain("+");
});

test("the vertical list is unchanged", () => {
  const html = renderToStaticMarkup(<ChainStepper steps={six} />);
  expect(html.match(/<li/g)).toHaveLength(6);
  expect(html).not.toContain("title=");
});
