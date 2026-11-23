// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { assertPatternLifecycle, makeHead, makeTabs, mark, notFoundRead, readyRead, renderPatternMarkup } from "./pattern-test-helpers";
import { RegisterTotals } from "./register-totals";
import { RegisterToolbarSelect } from "./register-totals-parts";
import { registerTotalsOptionalRegions } from "./register-totals-contract";

beforeAll(() => loadCatalog("ko"));

test("RegisterTotals satisfies placement, conditional blockers, refusal, and 404 data-detail contracts", async () => {
  const renderRegister = (q = readyRead) => (
    <RegisterTotals
      q={q}
      head={makeHead("register-contract-title", { filters: mark("filters") })}
      tabs={makeTabs()}
      totals={mark("totals")}
      blockers={mark("blockers")}
      notes={mark("notes")}
      register={mark("register")}
      preview={mark("preview")}
      record={{ id: "emp-1", label: "Payslip", onClose() {}, children: mark("record") }}
      foot={mark("foot")}
      facts={mark("facts")}
      overlays={mark("overlays")}
    />
  );

  await assertPatternLifecycle({
    pattern: "register-totals",
    optionalRegions: registerTotalsOptionalRegions,
    render: renderRegister,
    placed: ["head", "asOf", "tabs", "filters", "totals", "blockers", "notes", "register", "preview", "record", "foot", "overlays"],
    stripped: ["asOf", "filters", "totals", "blockers", "notes", "register", "preview", "record", "foot", "facts", "overlays"],
    withheld: ["totals", "blockers", "register", "preview", "record"],
  });

  const noBlockers = await renderPatternMarkup(
    <RegisterTotals q={readyRead} head={{ title: mark("head") }} register={mark("register")} blockers={null} />,
  );
  const emptyArrayBlockers = await renderPatternMarkup(
    <RegisterTotals q={readyRead} head={{ title: mark("head") }} register={mark("register")} blockers={[]} />,
  );
  const emptyFragmentBlockers = await renderPatternMarkup(
    <RegisterTotals q={readyRead} head={{ title: mark("head") }} register={mark("register")} blockers={<></>} />,
  );
  expect(noBlockers).toContain('data-contract-region="register"');
  expect(noBlockers).not.toContain('data-contract-region="blockers"');
  expect(emptyArrayBlockers).toBe(noBlockers);
  expect(emptyFragmentBlockers).toBe(noBlockers);

  const notFound = await renderPatternMarkup(renderRegister(notFoundRead("missing-run")));
  expect(notFound).not.toContain("data-detail");
});

test("RegisterToolbarSelect renders a custom SelectField button instead of a visible native select", async () => {
  const html = await renderPatternMarkup(
    <RegisterToolbarSelect
      label="Legal entity"
      value="ent-1"
      options={[
        { value: "ent-1", label: "Saeon Precision" },
        { value: "ent-2", label: "Saeon Robotics" },
      ]}
      onChange={() => {}}
    />,
  );
  expect(html).toContain("<button");
  expect(html).toContain("Saeon Precision");
  expect(html).toContain('aria-haspopup="listbox"');
});
