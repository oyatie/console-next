import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { focusSoon } from "../../../lib/react/announce";
import { freshOnOpen, get } from "../../../lib/query";
import { QueryState } from "../../../lib/react/query-state";
import { targetOf, type Intent, type Unit } from "../domain/proposal";
import { UnitProposal } from "./unit-proposal";

const route = getRouteApi("/app/org");

/**
 * The proposal card (fixed-task-card anatomy): one structural change, from what it is to the decision bar.
 * `onClose` goes back to the panel it replaced.
 */
export function ProposeCard({ intent, units, onClose }: { intent: Intent; units: Unit[]; onClose: () => void }) {
  return <UnitProposal intent={intent} units={units} onClose={onClose} />;
}

/**
 * The panel slot: the card for the proposal `?act=` names, in place of the selection's panel (`children`),
 * so the tree stays in view.
 * Keyed by act and selection, so another proposal never inherits typed input.
 */
export function ProposeSlot({ units, children }: { units?: Unit[]; children?: ReactNode }) {
  const { sel, act, kind } = route.useSearch();
  const navigate = route.useNavigate();
  const target = targetOf(act, sel, kind, { units });
  // Who moves is read afresh when the card opens and only then shown: the panel's cached members can predate
  // a registration or a transfer made since (J7).
  const members = useQuery({ ...get("/api/v1/org-units/{id}", { params: { path: { id: sel ?? "" } } }), enabled: target?.kind === "reassign", refetchOnMount: "always" });
  if (!target) return children;
  const close = () => {
    void navigate({ search: (s) => ({ ...s, act: undefined, kind: undefined }) });
    // Back to the button that opened the card (`act-<act>` on the panel's action), else the panel's heading.
    focusSoon(`act-${act}`, "unit-title");
  };
  const key = `${act}:${sel ?? ""}:${kind ?? ""}`;
  if (target.kind !== "reassign") return <ProposeCard key={key} intent={target} units={units ?? []} onClose={close} />;
  return <QueryState q={freshOnOpen(members)}>{(d) => <ProposeCard key={key} intent={{ ...target, members: d.members }} units={units ?? []} onClose={close} />}</QueryState>;
}
