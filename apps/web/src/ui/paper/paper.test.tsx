// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { Paper, PaperHead, PaperFoot, PaperWell, PaperId } from "./paper";

test("Paper renders printed document container with size and watermark", () => {
  const [no, facts, printed] = ["No. 1234", "Employee Facts", "Printed 2026-10-21"];
  const out = html(
    <PaperWell>
      <Paper size="a4" label="Personnel Record" watermark="CONFIDENTIAL">
        <PaperHead title="Personnel Record (인사기록카드)">
          <span>{no}</span>
        </PaperHead>
        <PaperId photo={<img src="photo.jpg" alt="" />}>
          <div>{facts}</div>
        </PaperId>
        <PaperFoot>{printed}</PaperFoot>
      </Paper>
    </PaperWell>
  );
  expect(out).toContain("<article");
  expect(out).toContain('data-size="a4"');
  expect(out).toContain('data-paper="true"');
  expect(out).toContain('data-wm="CONFIDENTIAL"');
  expect(out).toContain("Personnel Record (인사기록카드)");
  expect(out).toContain("Employee Facts");
  expect(out).toContain("Printed 2026-10-21");
});
