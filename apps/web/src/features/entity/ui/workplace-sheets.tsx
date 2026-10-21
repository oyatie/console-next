import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { WorkplaceSheetProps } from "../../../reference/org/ui/use-structure-slots";
import { kindsQuery, workplaceEndQuery } from "../api";
import { FreshEntity } from "./fresh-entity";
import { WorkplaceCloseSheet } from "./workplace-close-sheet";
import { WorkplaceCreateSheet } from "./workplace-create-sheet";
import { WorkplaceDeleteSheet } from "./workplace-delete-sheet";
import { WorkplacePrimarySheet } from "./workplace-primary-sheet";
import { WorkplaceKindSheet } from "./workplace-kind-sheet";
import { WorkplaceKindsSheet } from "./workplace-kinds-sheet";

/** The workplace sheet a company-structure act opens (S5): add, representative change, setup delete, close, its kind and the kind list. */
export function WorkplaceSheet({ act, at, setup, onClose, onSelect, onAct }: WorkplaceSheetProps) {
  switch (act) {
    case "wp-create":
      return at.kind === "entity" ? <CreateHost entityId={at.node.id} setup={setup} onClose={onClose} onSaved={(_, another) => !another && onSelect(undefined)} /> : null;
    case "wp-primary":
      return <WorkplacePrimarySheet entityId={at.entity.id} setup={setup} onClose={onClose} />;
    // CRUD: delete or close is decided by use, in either phase; whichever act opened it, the sheet that applies is drawn.
    case "wp-delete":
    case "wp-close":
      return at.kind === "workplace" ? <EndHost id={at.node.id}>{(erase) => (erase ? <WorkplaceDeleteSheet place={at} onClose={onClose} onDone={() => onSelect(undefined)} /> : <WorkplaceCloseSheet place={at} onClose={onClose} onAct={onAct} />)}</EndHost> : null;
    case "wp-kind":
      return at.kind === "workplace" ? (
        <FreshEntity id={at.entity.id}>{(e) => {
          const w = e.workplaces.find((x) => x.id === at.node.id);
          return w ? <WorkplaceKindSheet w={w} onClose={onClose} onManage={() => onAct("wp-kinds")} /> : null;
        }}</FreshEntity>
      ) : null;
    case "wp-kinds":
      return <WorkplaceKindsSheet onClose={onClose} />;
    default:
      return null;
  }
}

/** The workplace's end-options read, fresh on open: whether it is deleted (never used) or closed. */
function EndHost({ id, children }: { id: string; children: (erase: boolean) => ReactNode }) {
  const end = useQuery({ ...workplaceEndQuery(id), refetchOnMount: "always" });
  return end.data ? <>{children(end.data.delete.allowed)}</> : null;
}

function CreateHost({ entityId, setup, onClose, onSaved }: { entityId: string; setup: boolean; onClose: () => void; onSaved: (id: string, another: boolean) => void }) {
  // The kind list is read beside the entity, before the sheet draws: arriving later, it pushed the form down under typing.
  // Gated on the first answer only (isFetched): an unserved list (404) re-reads as pending and must not unmount the sheet.
  const kinds = useQuery({ ...kindsQuery, retry: false, refetchInterval: false });
  return <FreshEntity id={entityId}>{(e) => kinds.isFetched && <WorkplaceCreateSheet e={e} kinds={kinds.data?.items} setup={setup} onClose={onClose} onSaved={onSaved} />}</FreshEntity>;
}
