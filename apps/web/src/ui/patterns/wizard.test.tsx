// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog, t } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { wizardOptionalRegions } from "./wizard-contract";
import { WizardPattern } from "./wizard";
import { assertPatternLifecycle, makeHead, makeTabs, mark, notFoundRead, readyRead, renderPatternMarkup } from "./pattern-test-helpers";

beforeAll(() => loadCatalog("ko"));

test("WizardPattern satisfies placement, refusal, loading, failure, and minimal contracts", async () => {
  await assertPatternLifecycle({
    pattern: "wizard",
    optionalRegions: wizardOptionalRegions,
    render: (q = readyRead) => (
      <WizardPattern
        q={q}
        head={makeHead("wizard-contract-title")}
        tabs={makeTabs()}
        steps={mark("steps")}
        notes={mark("notes")}
        body={mark("body")}
        aside={mark("aside")}
        asideLabel="Checklist"
        notice={mark("notice")}
        consequence={mark("consequence")}
        actions={mark("actions")}
        foot={mark("foot")}
        facts={mark("facts")}
        overlays={mark("overlays")}
      />
    ),
    placed: ["head", "asOf", "tabs", "steps", "notes", "body", "aside", "notice", "consequence", "actions", "foot", "overlays"],
    stripped: ["asOf", "steps", "notes", "body", "aside", "notice", "consequence", "actions", "foot", "facts", "overlays"],
    withheld: ["steps", "body", "aside", "notice", "consequence", "actions"],
  });

  const minimal = await renderPatternMarkup(
    <WizardPattern q={readyRead} head={{ title: mark("head") }} body={mark("body")} actions={mark("actions")} />,
  );
  expect(minimal).toContain('data-pattern="wizard"');
  expect(minimal).not.toContain("<aside");

  const notFound = await renderPatternMarkup(
    <WizardPattern q={notFoundRead("missing-wiz")} head={{ title: mark("head") }} body={mark("body")} actions={mark("actions")} />,
  );
  expect(notFound).toContain(t("common.read.notFound.title"));
  expect(notFound).not.toContain('data-contract-region="body"');
});
