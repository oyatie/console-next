import type { LegalEntity } from "@console/api/pending";
import { entityNames } from "./domain/names";
// Words for the legal entity facts other slices show: a workplace kind's label (decision #18: a label only).
import type { WorkplaceKind } from "@console/api/pending";
import { codeText } from "../../lib/labels";

/** A workplace kind's label: the tenant's own, else the platform default's catalog label. */
export const kindLabel = (k: Pick<WorkplaceKind, "code" | "label">) => k.label || codeText(`workplace.kind.${k.code}`, k.code);
/** The label of the kind `code` names, looked up in the list (a tenant kind's code is an id, never shown). */
export const kindName = (kinds: readonly WorkplaceKind[] | undefined, code: string) => kindLabel(kinds?.find((k) => k.code === code) ?? { code });

/** The legal name with its short and English names, as plain text: a picker label its aliases also find. */
export const entityNameText = (e: Pick<LegalEntity, "current">) => {
  const v = entityNames(e);
  return [v.name, ...v.aliases].join(" · ");
};
