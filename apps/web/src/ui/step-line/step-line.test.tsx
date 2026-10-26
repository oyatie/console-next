// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { StepLine } from "./step-line";
import { GateRail } from "../gate-rail";

beforeAll(() => loadCatalog("ko"));

test("StepLine renders sequence of steps with current step marked", () => {
  const out = html(
    <StepLine
      label="Bulk Edit Process"
      steps={[
        { key: "select", label: "Select People", state: "done" },
        { key: "edit", label: "Edit Fields", state: "current" },
        { key: "confirm", label: "Confirm Changes", state: "waiting" },
      ]}
    />
  );
  expect(out).toContain("Select People");
  expect(out).toContain("Edit Fields");
  expect(out).toContain('aria-current="step"');
  expect(out).toContain('data-state="done"');
  expect(out).toContain('data-state="current"');
});

test("GateRail renders lifecycle rail with current and failed indicators", () => {
  const out = html(
    <GateRail
      steps={[
        { key: "draft", label: "Draft" },
        { key: "review", label: "Review" },
        { key: "apply", label: "Apply" },
      ]}
      current="review"
      failed
    />
  );
  expect(out).toContain("Draft");
  expect(out).toContain("Review");
  expect(out).toContain('data-state="failed"');
  expect(out).toContain('aria-current="step"');
});
