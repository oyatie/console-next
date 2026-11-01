// SPDX-License-Identifier: LicenseRef-Proprietary
// oxlint-disable react/forbid-elements -- Native links make the router mock's semantics observable.
import type { ReactNode } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { PersonLabel, PersonRecordLink } from "./person-label";
import { personOption } from "./person-option";

vi.mock("@tanstack/react-router", () => ({ Link: ({ params, children, ...props }: { params: { id: string }; children: ReactNode }) => <a {...props} href={`/people/${params.id}`}>{children}</a> }));
beforeAll(() => loadCatalog("ko"));
const person = { id: "account-a", display_name: "Namesake", employee_id: "person-a", employee_number: "E-1" };

test("the disambiguator is visible text, not only a tooltip", () => {
  const html = renderToStaticMarkup(<PersonLabel person={person} />).replace(/title="[^"]*"/g, "");
  expect(html).toMatch(/>E-1<\//);
});

test("a linked employee opens the person record; an account-only label has no invented record link", () => {
  expect(renderToStaticMarkup(<PersonLabel person={person} />)).toContain('href="/people/person-a"');
  expect(renderToStaticMarkup(<PersonLabel person={{ id: "account", name: "Person" }} />)).not.toContain("<a ");
});

test("the person card remains reachable beside an account link without nested anchors", () => {
  const html = renderToStaticMarkup(<><a href="/access/people/account-a"><PersonLabel person={person} linked={false} /></a><PersonRecordLink person={person} /></>);
  expect(html.match(/<a /g)).toHaveLength(2);
  expect(html).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/);
  expect(html).toContain('href="/people/person-a"');
});

test("empty names never produce a same-name chip", () => {
  const unnamed = [{ id: "a", name: " " }, { id: "b", name: "" }];
  expect(renderToStaticMarkup(<PersonLabel person={unnamed[0]!} peers={unnamed} />)).not.toContain(t("people.sameName.chip"));
});

test("picker options share the label without nesting record links or losing the confirmation code", () => {
  const other = { ...person, id: "b", employee_id: "person-b", employee_number: null, org_unit: "Sales" };
  const option = personOption(person, [person, other]);
  expect(option.name).toBe("Namesake");
  expect(option.code).toBe("E-1");
  const html = renderToStaticMarkup(<>{option.display}</>);
  expect(html).not.toContain("<a ");
  expect(html).toMatch(/>E-1<\//);
  expect(html).toContain(t("people.sameName.chip"));
  expect(renderToStaticMarkup(<>{personOption(other, [person, other]).display}</>)).toContain(">Sales</");
});

test("person-card actions distinguish linked namesakes in their accessible names", () => {
  const other = { ...person, id: "account-b", employee_id: "person-b", employee_number: "E-2" };
  const peers = [person, other];
  const names = peers.map((p) => renderToStaticMarkup(<PersonRecordLink person={p} peers={peers} />).match(/aria-label="([^"]+)"/)?.[1]);
  expect(names).toEqual(peers.map((p) => t("people.label.record", { name: `Namesake · ${p.employee_number}` })));
  expect(new Set(names).size).toBe(2);
});

test.each(["ko", "en"] as const)("colliding account options share the creation-time detail with list labels in %s", async locale => {
  await loadCatalog(locale);
  const first = { id: "account-a", display_name: "Namesake", sign_in_id: "worker1234@example.test", created_at: "2026-10-01T01:00:00Z" };
  const second = { ...first, id: "account-b", sign_in_id: "writer1234@example.test", created_at: "2026-10-01T02:00:00Z" };
  const peers = [first, second];
  for (const account of peers) {
    const option = personOption(account, peers);
    const html = renderToStaticMarkup(<>{option.display}</>);
    expect(option.context).toBeUndefined();
    expect(html).toBe(renderToStaticMarkup(<PersonLabel person={account} peers={peers} linked={false} />));
    expect(html).toContain(t("people.label.accountCreated", { at: fmtDateTime(account.created_at) }));
    expect(html).not.toContain(account.id);
  }
  await loadCatalog("ko");
});
