// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { assertPatternLifecycle, makeHead, makeTabs, mark, readyRead, renderPatternMarkup } from "./pattern-test-helpers";
import { RecordPattern } from "./record";
import { recordOptionalRegions } from "./record-contract";

beforeAll(() => loadCatalog("ko"));

test("RecordPattern satisfies placement, refusal, loading, and failure contracts", async () => {
  await assertPatternLifecycle({
    pattern: "record",
    optionalRegions: recordOptionalRegions,
    render: (q = readyRead) => (
      <RecordPattern
        q={q}
        head={makeHead("record-contract-title")}
        tabs={makeTabs()}
        secNav={mark("secNav")}
        notes={mark("notes")}
        strip={mark("strip")}
        sections={mark("sections")}
        spine={mark("spine")}
        foot={mark("foot")}
        facts={mark("facts")}
        overlays={mark("overlays")}
      />
    ),
    placed: ["head", "asOf", "tabs", "secNav", "notes", "strip", "sections", "spine", "foot", "overlays"],
    stripped: ["asOf", "secNav", "notes", "strip", "sections", "spine", "foot", "facts", "overlays"],
    withheld: ["secNav", "strip", "sections", "spine"],
  });

  const minimal = await renderPatternMarkup(
    <RecordPattern q={readyRead} head={{ title: mark("head") }} sections={mark("sections")} />,
  );
  expect(minimal).toContain('data-contract-region="sections"');
  expect(minimal).not.toContain('data-has-spine');
});
