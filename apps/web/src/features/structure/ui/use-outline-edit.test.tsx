// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { ChartNode, Structure } from "../domain/model";
import type { Commands } from "./use-structure-commands";
import { UnitEdit } from "../../../reference/org/ui/use-unit-edit";
import { useStructureEdit } from "./use-structure-gestures";
import { useStructureGesturesBare } from "./use-outline-edit";

const access = vi.hoisted(() => ({ allowed: false }));
vi.mock("../../../reference/authz/ui/use-can", () => ({ useCan: () => () => access.allowed }));
beforeAll(() => loadCatalog("ko"));
test.each([false, true])("outline/list honor the existing draft decision: %s", (allowed) => {
  access.allowed = allowed;
  const propose = vi.fn();
  const apply = vi.fn();
  const node = { id: "unit", kind: "dept", name: "unit" } as ChartNode;
  const values = { effectiveDate: "2026-12-01", reason: "Growth", submit: true };
  function Probe() {
    const gestures = useStructureGesturesBare({ phase: "OPERATING", readOnly: false } as Structure, { propose, apply, readOnly: false } as unknown as Commands);
    expect(gestures.canEdit).toBe(allowed);
    gestures.create(node, "child", values, () => {});
    gestures.rename(node, "renamed", values);
    return null;
  }
  function Gate() {
    const decision = useStructureEdit(false);
    return <UnitEdit.Provider value={decision}><Probe /></UnitEdit.Provider>;
  }
  renderToStaticMarkup(<Gate />);
  expect(propose).toHaveBeenCalledTimes(allowed ? 2 : 0);
  expect(apply).not.toHaveBeenCalled();
});
