// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { settingsOptionalRegions } from "./settings-contract";
import { SettingsPattern } from "./settings";
import { assertPatternLifecycle, makeHead, makeTabs, mark, notFoundRead, readyRead, renderPatternMarkup } from "./pattern-test-helpers";

beforeAll(() => loadCatalog("ko"));

test("SettingsPattern satisfies placement, SidePaneSpec detail, refusal, loading, and minimal contracts", async () => {
  await assertPatternLifecycle({
    pattern: "settings",
    optionalRegions: settingsOptionalRegions,
    render: (q = readyRead) => (
      <SettingsPattern
        q={q}
        head={makeHead("settings-contract-title")}
        tabs={makeTabs()}
        summary={mark("summary")}
        views={mark("views")}
        notes={mark("notes")}
        panel={mark("panel")}
        foot={mark("foot")}
        facts={mark("facts")}
        overlays={mark("overlays")}
        record={{ id: "item-1", label: "Inspector", onClose() {}, children: mark("record") }}
      />
    ),
    placed: ["head", "asOf", "tabs", "summary", "views", "notes", "panel", "foot", "record", "overlays"],
    stripped: ["asOf", "summary", "views", "notes", "panel", "foot", "record", "facts", "overlays"],
    withheld: ["summary", "views", "panel", "record"],
  });

  const withSidePane = await renderPatternMarkup(
    <SettingsPattern
      q={readyRead}
      head={{ title: mark("head") }}
      panel={mark("panel")}
      record={{ id: "s-1", label: "Inspector", onClose() {}, children: mark("record") }}
    />,
  );
  expect(withSidePane).toContain('data-detail="true"');

  const notFound = await renderPatternMarkup(
    <SettingsPattern
      q={notFoundRead("missing-settings")}
      head={{ title: mark("head") }}
      panel={mark("panel")}
      record={{ id: "s-1", label: "Inspector", onClose() {}, children: mark("record") }}
    />,
  );
  expect(notFound).not.toContain("data-detail");

  const minimal = await renderPatternMarkup(
    <SettingsPattern q={readyRead} head={{ title: mark("head") }} panel={mark("panel")} />,
  );
  expect(minimal).toContain('data-pattern="settings"');
  expect(minimal).not.toContain("data-detail");
});
