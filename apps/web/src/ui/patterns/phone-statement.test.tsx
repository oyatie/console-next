// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { assertPatternLifecycle, makeHead, makeTabs, mark, readyRead, renderPatternMarkup } from "./pattern-test-helpers";
import { PhoneStatement } from "./phone-statement";
import { phoneStatementOptionalRegions } from "./phone-statement-contract";

beforeAll(() => loadCatalog("ko"));

test("PhoneStatement satisfies placement, PagePhoneHeader, refusal, loading, and failure contracts", async () => {
  await assertPatternLifecycle({
    pattern: "phone-statement",
    optionalRegions: phoneStatementOptionalRegions,
    phoneHeadAware: true,
    render: (q = readyRead) => (
      <PhoneStatement
        q={q}
        head={makeHead("stmt-contract-title")}
        tabs={makeTabs()}
        period={mark("period")}
        periodMeta={mark("periodMeta")}
        hero={mark("hero")}
        stats={mark("stats")}
        notes={mark("notes")}
        ledgers={mark("ledgers")}
        contextStats={mark("contextStats")}
        actions={mark("actions")}
        foot={mark("foot")}
        facts={mark("facts")}
        overlays={mark("overlays")}
      />
    ),
    placed: ["head", "tabs", "period", "periodMeta", "hero", "stats", "notes", "ledgers", "contextStats", "actions", "foot", "overlays"],
    stripped: ["period", "periodMeta", "hero", "stats", "notes", "ledgers", "contextStats", "actions", "foot", "facts", "overlays"],
    withheld: ["period", "hero", "stats", "ledgers", "contextStats", "actions"],
  });

  const minimal = await renderPatternMarkup(
    <PhoneStatement
      q={readyRead}
      head={{ title: mark("head") }}
      hero={mark("hero")}
      ledgers={mark("ledgers")}
    />,
  );
  expect(minimal).toContain('data-contract-region="hero"');
  expect(minimal).toContain('data-contract-region="ledgers"');
});
