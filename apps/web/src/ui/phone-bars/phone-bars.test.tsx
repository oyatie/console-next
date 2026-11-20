// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { renderToStaticMarkup as html } from "react-dom/server";
import { Building2, ClipboardCheck, Clock, FileText, Home, Settings, UserRound } from "lucide-react";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { blocks } from "../../../../../scripts/check-standing-text.mjs";
import { PhoneBottomNav, PhoneTopBar, type PhoneNavItem } from "./phone-bars";

beforeAll(async () => {
  await loadCatalog("ko");
});

const SIX_ITEMS: readonly PhoneNavItem[] = [
  { id: "home", label: "Home", href: "/", icon: Home, count: 2 },
  { id: "attendance", label: "Attendance", href: "/attendance", icon: Clock },
  { id: "payroll", label: "Payroll", href: "/payroll", icon: FileText },
  { id: "approvals", label: "Approvals", href: "/approvals", icon: ClipboardCheck },
  { id: "account", label: "Account", href: "/account", icon: UserRound },
  { id: "org", label: "Org", href: "/org", icon: Building2 },
];

test("PhoneTopBar renders chrome header, optional h1 or div title, back control, and context", () => {
  const plain = html(<PhoneTopBar title="My profile" context="Saeon Precision" />);
  expect(plain).toContain('data-surface="chrome"');
  expect(plain).toContain("<div");
  expect(plain).not.toContain("<h1");
  expect(plain).toContain("Saeon Precision");

  const withH1AndBack = html(
    <PhoneTopBar title="Leave request" headingAs="h1" back={{ label: "Go back", href: "/account" }} />,
  );
  expect(withH1AndBack).toContain("<h1");
  expect(withH1AndBack).toContain('aria-label="Go back"');
});

test("PhoneBottomNav renders five direct slots when <= 5 and folds excess into slot 5 when > 5", () => {
  const five = html(<PhoneBottomNav label="Bottom menu" items={SIX_ITEMS.slice(0, 5)} activeId="account" />);
  expect(five).toContain('aria-current="page"');
  expect(five.match(/<li\b/g)).toHaveLength(5);

  const six = html(
    <PhoneBottomNav
      label="Bottom menu"
      moreLabel="More modules"
      items={[...SIX_ITEMS, { id: "settings", label: "Settings", href: "/settings", icon: Settings }]}
      activeId="settings"
    />,
  );
  expect(six.match(/<li\b/g)).toHaveLength(5);
  expect(six).toContain('aria-label="More modules"');
  expect(six).toContain('data-active="true"');
});

test("PhoneTopBar and PhoneBottomNav add zero standing-text blocks to screens that import them", () => {
  expect(html(<PhoneBottomNav items={[]} />)).toBe("");
  const source = readFileSync("apps/web/src/ui/phone-bars/phone-bars.tsx", "utf8");
  expect(blocks("apps/web/src/ui/phone-bars/phone-bars.tsx", source)).toBe(0);
});
