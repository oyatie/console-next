// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { CardHead } from "./card-head";
import { PhotoRow } from "./photo-row";
import type { Card } from "./use-card";
import type { Quick } from "./use-quick";

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({}) }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useNavigate: () => () => {},
  getRouteApi: () => ({ useSearch: () => ({}), useNavigate: () => () => {} }),
}));
vi.mock("./use-case-actions", () => ({ useOwnRecord: () => false }));

beforeAll(() => loadCatalog("ko"));
const noop = () => {};
const card = (url: string | null) => ({
  e: { id: "person", name: "한기록", status: "ACTIVE" },
  d: { classification: {}, warnings: [] },
  events: {}, personal: { data: { photo: { url, upload_id: "photo" } } },
  place: { entity: "", path: [] }, title: noop,
}) as unknown as Card;

test.each([null, "javascript:alert(1)"])("both personnel photo surfaces name the missing-photo fallback: %s", (url) => {
  const c = card(url);
  for (const screen of [
    <CardHead key="head" c={c} onTab={noop} onAct={noop} onGo={noop} onKeys={noop} />,
    <PhotoRow key="row" c={c} quick={{} as Quick} />,
  ]) {
    const html = renderToStaticMarkup(screen);
    expect(html).toContain(`role="img" aria-label="${t("empCard.photo.none")}"`);
    expect(html).not.toContain("<img");
    expect(html).not.toContain(t("empCard.photo", { name: c.e.name }));
  }
});

test("both personnel photo surfaces preserve the available photo and its name", () => {
  const c = card("https://media.example/photo.png");
  for (const screen of [
    <CardHead key="head" c={c} onTab={noop} onAct={noop} onGo={noop} onKeys={noop} />,
    <PhotoRow key="row" c={c} quick={{} as Quick} />,
  ]) {
    const html = renderToStaticMarkup(screen);
    expect(html).toContain('src="https://media.example/photo.png"');
    expect(html).toContain(`alt="${t("empCard.photo", { name: c.e.name })}"`);
    expect(html).not.toContain(t("empCard.photo.none"));
  }
});
