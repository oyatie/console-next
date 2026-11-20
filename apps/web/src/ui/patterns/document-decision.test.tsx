// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { DocumentDecision } from "./document-decision";
import { documentDecisionOptionalRegions } from "./document-decision-contract";
import { assertPatternLifecycle, makeHead, makeTabs, mark, notFoundRead, readyRead, renderPatternMarkup } from "./pattern-test-helpers";

beforeAll(() => loadCatalog("ko"));

test("DocumentDecision satisfies docked and SidePaneSpec contracts including keepPreviousData 404 guard", async () => {
  const renderDocked = (q = readyRead) => (
    <DocumentDecision
      q={q}
      head={makeHead("doc-contract-title")}
      tabs={makeTabs()}
      notes={mark("notes")}
      start={mark("start")}
      document={mark("document")}
      decision={mark("decision")}
      decisionLabel="Decision"
      foot={mark("foot")}
      facts={mark("facts")}
      overlays={mark("overlays")}
    />
  );

  await assertPatternLifecycle({
    pattern: "document-decision",
    optionalRegions: documentDecisionOptionalRegions,
    render: renderDocked,
    placed: ["head", "asOf", "tabs", "notes", "start", "document", "decision", "foot", "overlays"],
    stripped: ["asOf", "notes", "start", "document", "decision", "foot", "facts", "overlays"],
    withheld: ["start", "document", "decision"],
  });

  const sidePaneReady = await renderPatternMarkup(
    <DocumentDecision
      q={readyRead}
      head={{ title: mark("head") }}
      document={mark("document")}
      decision={{ id: "doc-1", label: "Decision", onClose() {}, children: mark("decision") }}
    />,
  );
  expect(sidePaneReady).toContain('data-detail="true"');
  expect(sidePaneReady.match(/<aside\b/g)).toHaveLength(1);

  const sidePaneNotFound = await renderPatternMarkup(
    <DocumentDecision
      q={notFoundRead("missing-doc")}
      head={{ title: mark("head") }}
      document={mark("document")}
      decision={{ id: "doc-1", label: "Decision", onClose() {}, children: mark("decision") }}
    />,
  );
  expect(sidePaneNotFound).not.toContain("data-detail");

  const emptyFragmentDecision = await renderPatternMarkup(
    <DocumentDecision
      q={readyRead}
      head={{ title: mark("head") }}
      document={mark("document")}
      decision={<></>}
      decisionLabel="Decision"
    />,
  );
  const emptyArrayDecision = await renderPatternMarkup(
    <DocumentDecision
      q={readyRead}
      head={{ title: mark("head") }}
      document={mark("document")}
      decision={[]}
      decisionLabel="Decision"
    />,
  );
  expect(emptyFragmentDecision).not.toContain("<aside");
  expect(emptyArrayDecision).not.toContain("<aside");
});
