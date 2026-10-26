import { getRouteApi } from "@tanstack/react-router";
import { AccessGate } from "../reference/authz/ui/access-gate";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { chunk } from "../lib/chunk-guard";
import { WorkplaceSidePanel } from "../features/entity/ui/workplace-side-panel";
import { FixLink } from "../features/onboarding/ui/fix-link";
import { useFreshOnArrival } from "../lib/react/arrival";
import { StructurePanel } from "../features/org/ui/structure-selection";
import { StructurePage } from "../features/structure/ui/structure-page";
import { unitsQuery } from "../reference/org/api";
import { StructureSlots, type StructureSlotsValue } from "../reference/org/ui/use-structure-slots";

const WorkplaceSheet = lazy(() => chunk(import("../features/entity/ui/workplace-sheets")).then(m => ({ default: m.WorkplaceSheet })));
const ProposeSlot = lazy(() => chunk(import("../features/org/ui/propose-card")).then(m => ({ default: m.ProposeSlot })));
const StructureSheets = lazy(() => chunk(import("../features/org/ui/structure-sheets")).then(m => ({ default: m.StructureSheets })));

const slots: StructureSlotsValue = {
  workplacePanel: (p) => <WorkplaceSidePanel {...p} />,
  workplaceSheet: (p) => <Suspense fallback={null}><WorkplaceSheet {...p} /></Suspense>,
};

/** A proposal card for `?act=` (the org slice's governed path, kept for links that name one). */
function Proposal() {
  // Units a command changed since they were cached are read again first, so the card never opens on a stale tree.
  const units = useFreshOnArrival(useQuery(unitsQuery), unitsQuery);
  return <Suspense fallback={null}><ProposeSlot units={units.data?.items ?? []} /></Suspense>;
}

/**
 * /org: the company structure chart (structure slice) composed with the selection's side panel and the structure
 * sheets (org slice, the entity slice's workplace panel and sheets through the slots), the setup checklist's fix links
 * (onboarding) and the proposal card a link may name. Routes compose slices; slices never import each other.
 */
const route = getRouteApi("/app/org");
export function OrgScreen() {
  const { act } = route.useSearch();
  const content = (
    <StructureSlots.Provider value={slots}>
      <StructurePage
        fixLink={(code) => <FixLink code={code} />}
        proposal={<Proposal />}
        panel={(sel, snapshot, readOnly) => <StructurePanel sel={sel} snapshot={snapshot} readOnly={readOnly} />}
        sheets={act && <Suspense fallback={null}><StructureSheets /></Suspense>}
      />
    </StructureSlots.Provider>
  );
  return act?.startsWith("wp-") ? <AccessGate domain="org" level="edit" layout="grid">{content}</AccessGate> : content;
}
