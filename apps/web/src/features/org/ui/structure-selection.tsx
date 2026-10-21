import type { ReactNode } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type { StructureAct } from "../../../reference/org/domain/structure";
import { useStructure } from "../../../reference/org/ui/use-structure";
import { useStructureSlots } from "../../../reference/org/ui/use-structure-slots";
import { DeptPanel } from "./dept-panel";

const route = getRouteApi("/app/org");

/**
 * The selection's side panel on the company structure page: a workplace (by its id or its own unit's; the panel
 * comes from the page's slots) or a department. Anything the structure does not hold (the company root) keeps
 * `fallback`, and so does a dissolved unit (no `sel`): its record is read-only history.
 */
export function StructurePanel({ sel, fallback }: { sel?: string; fallback?: ReactNode }) {
  const navigate = route.useNavigate();
  const slots = useStructureSlots();
  const s = useStructure(sel);
  const close = () => void navigate({ search: (x) => ({ ...x, sel: undefined, act: undefined }), replace: true });
  const onAct = (act: StructureAct) => void navigate({ search: (x) => ({ ...x, act }) });
  if (s.at?.kind === "workplace" && slots) return <div key={s.at.node.id}>{slots.workplacePanel({ place: s.at, tenant: s.tenant, setup: s.setup, onClose: close, onAct })}</div>;
  if (s.at?.kind === "dept") return <DeptPanel key={s.at.node.id} place={s.at} setup={s.setup} onClose={close} />;
  return sel && s.q.isPending ? null : fallback;
}
