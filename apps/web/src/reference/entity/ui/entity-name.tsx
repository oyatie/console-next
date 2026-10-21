import { t } from "@console/i18n";
import type { LegalEntity } from "@console/api/pending";
import { entityNames } from "../domain/names";
/**
 * One presentation for lists, pickers, cards and headers: the legal name first, the short and English names only as
 * secondary labels. Without an entity record (`entity` null) it says so, with the text it came from (`alias`) beside it.
 */
export function EntityName({ entity, name, alias }: { entity?: Pick<LegalEntity, "current"> | null; name?: string | null; alias?: string | null }) {
  const v = entity ? entityNames(entity) : { name: name ?? "", aliases: alias && alias !== name ? [alias] : [] };
  return <>{v.name || t("entity.name.unconfirmed")}{v.aliases.map((a) => <small key={a} className="muted"> · {a}</small>)}</>;
}
