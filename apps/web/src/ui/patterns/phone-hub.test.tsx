// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { assertPatternLifecycle, makeHead, makeTabs, mark, readyRead, renderPatternMarkup } from "./pattern-test-helpers";
import { PhoneHub } from "./phone-hub";
import { phoneHubOptionalRegions, type PhoneHubLinkItem, type PhoneHubSection } from "./phone-hub-contract";

beforeAll(() => loadCatalog("ko"));

test("PhoneHub satisfies placement, PagePhoneHeader, link rendering, refusal, and loading contracts", async () => {
  const links: readonly PhoneHubLinkItem[] = [
    { key: "l1", label: mark("links"), meta: "meta", href: "/account" },
  ];
  const sections: readonly PhoneHubSection[] = [
    { key: "s1", title: "Section", children: mark("sections") },
  ];

  await assertPatternLifecycle({
    pattern: "phone-hub",
    optionalRegions: phoneHubOptionalRegions,
    phoneHeadAware: true,
    render: (q = readyRead) => (
      <PhoneHub
        q={q}
        head={makeHead("hub-contract-title")}
        tabs={makeTabs()}
        identity={mark("identity")}
        stats={mark("stats")}
        links={links}
        notes={mark("notes")}
        sections={sections}
        foot={mark("foot")}
        facts={mark("facts")}
        overlays={mark("overlays")}
      />
    ),
    placed: ["head", "tabs", "identity", "stats", "links", "notes", "sections", "foot", "overlays"],
    stripped: ["identity", "stats", "links", "notes", "sections", "foot", "facts", "overlays"],
    withheld: ["identity", "stats", "links", "sections"],
  });

  const buttonLinks = await renderPatternMarkup(
    <PhoneHub
      q={readyRead}
      head={{ title: mark("head") }}
      links={[{ key: "btn", label: "ActionRow", onPress() {} }]}
      sections={[{ key: "s", title: "S", children: mark("sections") }]}
    />,
  );
  expect(buttonLinks).toContain("<button");
  expect(buttonLinks).toContain("ActionRow");
});
