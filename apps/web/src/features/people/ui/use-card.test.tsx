// SPDX-License-Identifier: LicenseRef-Proprietary
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { useCard } from "./use-card";
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { items: [] } }) }));
vi.mock("../../../reference/authz/ui/use-can", () => ({ useCan: () => () => false }));

test("an unplaced card never uses a physical site as its statutory workplace", () => {
  function Card() {
    const card = useCard({ employee: { id: "unplaced", company: "법인 미정", worksite_name: "고객가 현장" } } as Parameters<typeof useCard>[0]);
    expect(card.place.workplace).toBeNull();
    return createElement("span", null, card.place.workplace);
  }
  renderToStaticMarkup(createElement(Card));
});
