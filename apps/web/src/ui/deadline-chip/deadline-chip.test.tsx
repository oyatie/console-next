// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { DeadlineChip } from "./deadline-chip";
import { Chip } from "../chip";
import { SourceChip } from "../source-chip";

beforeAll(() => loadCatalog("ko"));

test("DeadlineChip renders D-n, today, and overdue states", () => {
  const left = html(<DeadlineChip severity="due" days={5} />);
  expect(left).toContain("D-5");

  const today = html(<DeadlineChip severity="due" days={0} />);
  expect(today).toContain("D-day");

  const settlement = "Settlement";
  const over = html(<DeadlineChip severity="over" days={-3} interestAccruing>{settlement}</DeadlineChip>);
  expect(over).toContain("3일 지남");
  expect(over).toContain("지연이자 발생 중");
});

test("Chip renders with tone variants", () => {
  const [active, warning] = ["Active", "Warning"];
  const ok = html(<Chip tone="ok">{active}</Chip>);
  expect(ok).toContain("chip--ok");
  expect(ok).toContain("Active");

  const warn = html(<Chip tone="warn">{warning}</Chip>);
  expect(warn).toContain("chip--warn");
});

test("SourceChip renders source label with correct tone", () => {
  const doc = html(<SourceChip source="document" />);
  expect(doc).toContain("chip--info");

  const nts = html(<SourceChip source="nts" />);
  expect(nts).toContain("chip--ok");
});
