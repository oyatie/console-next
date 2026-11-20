// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { PageMain } from "../page/page-main";
import { PagePhoneHeader } from "../page/page-scope";
import { FormPattern } from "./form";
import { formOptionalRegions } from "./form-contract";
import { assertPatternLifecycle, makeHead, makeTabs, mark, readyRead, renderPatternMarkup } from "./pattern-test-helpers";

beforeAll(() => loadCatalog("ko"));

test("FormPattern satisfies placement, PagePhoneHeader h1 ownership, refusal, loading, and failure contracts", async () => {
  await assertPatternLifecycle({
    pattern: "form",
    optionalRegions: formOptionalRegions,
    phoneHeadAware: true,
    render: (q = readyRead) => (
      <FormPattern
        q={q}
        head={makeHead("form-contract-title")}
        tabs={makeTabs()}
        summary={mark("summary")}
        notes={mark("notes")}
        sections={mark("sections")}
        notice={mark("notice")}
        consequence={mark("consequence")}
        actions={mark("actions")}
        onSubmit={() => undefined}
        foot={mark("foot")}
        facts={mark("facts")}
        overlays={mark("overlays")}
      />
    ),
    placed: ["head", "asOf", "tabs", "summary", "notes", "sections", "notice", "consequence", "actions", "foot", "overlays"],
    stripped: ["asOf", "summary", "notes", "sections", "notice", "consequence", "actions", "foot", "facts", "overlays"],
    withheld: ["summary", "sections", "consequence", "actions"],
  });

  const phoneTitleOnly = await renderPatternMarkup(
    <PagePhoneHeader value={{ shellOwnsH1: true }}>
      <PageMain>
        <FormPattern
          q={readyRead}
          head={{ title: mark("head") }}
          sections={mark("sections")}
          actions={mark("actions")}
          onSubmit={() => undefined}
        />
      </PageMain>
    </PagePhoneHeader>,
  );
  expect(phoneTitleOnly.match(/<h1\b/g)).toBeNull();
  expect(phoneTitleOnly).not.toContain('data-contract-region="head"');
});
