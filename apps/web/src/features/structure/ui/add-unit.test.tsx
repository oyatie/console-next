// SPDX-License-Identifier: LicenseRef-Proprietary
import type { MouseEvent, ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { Button } from "../../../ui/button/button";
import type { ChartNode } from "../domain/model";
import { AddUnit } from "./add-unit";

let click: ComponentProps<typeof Button>["onClick"];
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useNavigate: () => vi.fn() }) }));
vi.mock("../../../ui/button/button", () => ({ Button: (props: ComponentProps<typeof Button>) => { click = props.onClick; return null; } }));
beforeAll(() => loadCatalog("ko"));

test("inline add keeps the parent row's selection handler from also receiving its click", () => {
  const add = vi.fn();
  const stop = vi.fn();
  const parentSelection = vi.fn();
  renderToStaticMarkup(<AddUnit n={{ id: "parent", kind: "dept", name: "parent" } as ChartNode} onAdd={add} />);
  click?.({ stopPropagation: stop } as unknown as MouseEvent<HTMLButtonElement>);
  if (!stop.mock.calls.length) parentSelection();
  expect(add).toHaveBeenCalledOnce();
  expect(parentSelection).not.toHaveBeenCalled();
});
