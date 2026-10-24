import { useQuery } from "@tanstack/react-query";
import { WorkplaceSheet } from "../features/entity/ui/workplace-sheets";
import { WorkplaceSidePanel } from "../features/entity/ui/workplace-side-panel";
import { FixLink } from "../features/onboarding/ui/fix-link";
import { useFreshOnArrival } from "../lib/react/arrival";
import { ProposeSlot } from "../features/org/ui/propose-card";
import { StructurePanel } from "../features/org/ui/structure-selection";
import { StructureSheets } from "../features/org/ui/structure-sheets";
import { StructurePage } from "../features/structure/ui/structure-page";
import { unitsQuery } from "../reference/org/api";
import { StructureSlots, type StructureSlotsValue } from "../reference/org/ui/use-structure-slots";

const slots: StructureSlotsValue = {
  workplacePanel: (p) => <WorkplaceSidePanel {...p} />,
  workplaceSheet: (p) => <WorkplaceSheet {...p} />,
};

/** A proposal card for `?act=` (the org slice's governed path, kept for links that name one). */
function Proposal() {
  // Units a command changed since they were cached are read again first, so the card never opens on a stale tree.
  const units = useFreshOnArrival(useQuery(unitsQuery), unitsQuery);
  return <ProposeSlot units={units.data?.items ?? []} />;
}

/**
 * /org: the company structure chart (structure slice) composed with the selection's side panel and the structure
 * sheets (org slice, the entity slice's workplace panel and sheets through the slots), the setup checklist's fix links
 * (onboarding) and the proposal card a link may name. Routes compose slices; slices never import each other.
 */
export function OrgScreen() {
  return (
    <StructureSlots.Provider value={slots}>
      <StructurePage
        fixLink={(code) => <FixLink code={code} />}
        proposal={<Proposal />}
        panel={(sel, snapshot, readOnly) => <StructurePanel sel={sel} snapshot={snapshot} readOnly={readOnly} />}
        sheets={<StructureSheets />}
      />
    </StructureSlots.Provider>
  );
}
