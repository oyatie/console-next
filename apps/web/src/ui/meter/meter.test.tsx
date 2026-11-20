// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { blocks } from "../../../../../scripts/check-standing-text.mjs";
import { Meter, type MeterProps } from "./meter";

test("Meter renders progress bar with aria attributes", () => {
  const props: MeterProps = { value: 75, max: 100, label: "Storage usage" };
  const out = html(<Meter {...props} />);
  expect(out).toContain('role="meter"');
  expect(out).toContain('aria-label="Storage usage"');
  expect(out).toContain('aria-valuenow="75"');
  expect(out).toContain('aria-valuemax="100"');
});

test("Meter supports warn state and aria-valuetext", () => {
  const out = html(<Meter value={95} max={100} label="Memory usage" warn valueText="95% used" />);
  expect(out).toContain('data-warn="true"');
  expect(out).toContain('aria-valuetext="95% used"');
});

test("Meter continuous mode clamps width percentage to 2%..100% and yields 0% when max <= 0", () => {
  expect(html(<Meter value={0} max={100} label="Zero" />)).toContain('data-pct="2"');
  expect(html(<Meter value={150} max={100} label="Over" />)).toContain('data-pct="100"');
  expect(html(<Meter value={5} max={0} label="Invalid" />)).toContain('data-pct="0"');
});

test("Meter segmented mode splits 30 half-day cells into exact used, pending, and rest states", () => {
  const out = html(
    <Meter
      value={5.5}
      pending={1}
      max={15}
      cells={30}
      label="Annual leave balance"
      valueText="Used 5.5 days, requesting 1 day, remaining 8.5 days of 15 days"
    />,
  );
  expect(out).toContain('data-segmented="true"');
  expect(out).toContain('aria-valuetext="Used 5.5 days, requesting 1 day, remaining 8.5 days of 15 days"');
  expect(out.match(/data-state="used"/g)).toHaveLength(11);
  expect(out.match(/data-state="pending"/g)).toHaveLength(2);
  expect(out.match(/data-state="rest"/g)).toHaveLength(17);
});

test("Meter segmented mode handles partial-used, partial-pending, clamping, and max <= 0", () => {
  const partial = html(<Meter value={1.25} pending={1.5} max={10} cells={10} label="Partial cells" />);
  expect(partial.match(/data-state="used"/g)).toHaveLength(1);
  expect(partial).toContain('data-state="partial-used" data-pct="25"');
  expect(partial).toContain('data-state="partial-pending" data-pct="75"');
  expect(partial.match(/data-state="rest"/g)).toHaveLength(7);

  const clamped = html(<Meter value={8} pending={5} max={10} cells={10} label="Clamped" warn />);
  expect(clamped).toContain('data-warn="true"');
  expect(clamped.match(/data-state="used"/g)).toHaveLength(8);
  expect(clamped.match(/data-state="pending"/g)).toHaveLength(2);

  const empty = html(<Meter value={3} pending={1} max={0} cells={5} label="No max" />);
  expect(empty.match(/data-state="rest"/g)).toHaveLength(5);
});

test("Meter maintains exactly 1 standing-text block so PeopleRoute pin stays unchanged", () => {
  const meterPath = resolve("apps/web/src/ui/meter/meter.tsx");
  const source = readFileSync(meterPath, "utf8");
  expect(blocks(meterPath, source)).toBe(1);
});
