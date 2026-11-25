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

test("a slot names its label before its count, as the desk bar does, and carries a count's name and description", () => {
  const markup = html(
    <PhoneBottomNav
      items={[
        { id: "/", label: "To-dos", href: "/", icon: Home, count: 1234, countMore: true, name: "To-dos 1234+", description: "1,234 or more to-dos" },
        { id: "/approvals", label: "Approvals", href: "/approvals", icon: ClipboardCheck, count: 4 },
      ]}
      renderLink={(_, props) => <a {...props}>{props.children}</a>}
    />,
  );
  const [todo = "", approvals = ""] = [...markup.matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map(match => match[0]);
  // The content reads label, then count: "Approvals 4", never "4 Approvals".
  expect(approvals.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).toBe("Approvals 4");
  expect(todo).toContain('aria-label="To-dos 1234+"');
  expect(todo).toContain(">1,234+</data>");
  const describedBy = todo.match(/aria-describedby="([^"]+)"/)?.[1];
  expect(describedBy).toBeTruthy();
  expect(markup).toContain(`<bdi id="${describedBy}" class="sr-only">1,234 or more to-dos</bdi>`);
});

test("PhoneTopBar and PhoneBottomNav add zero standing-text blocks to screens that import them", () => {
  expect(html(<PhoneBottomNav items={[]} />)).toBe("");
  const source = readFileSync("apps/web/src/ui/phone-bars/phone-bars.tsx", "utf8");
  expect(blocks("apps/web/src/ui/phone-bars/phone-bars.tsx", source)).toBe(0);
});
