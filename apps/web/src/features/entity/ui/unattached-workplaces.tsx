import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { workplaceName } from "../domain/view";
import { entityName } from "../../../reference/entity/domain/names";
import { unattached } from "../domain/attach";
import { AttachHost } from "./workplace-attach-sheet";

/**
 * Workplaces that file under no certificate, people first (org-03): the go-live blocker 「attach a registration」 lands on this list,
 * so its remedy is here, one press per workplace. Drawn only when there is one.
 */
export function UnattachedWorkplaces({ entities }: { entities: readonly LegalEntity[] }) {
  const [open, setOpen] = useState<{ entityId: string; workplaceId: string } | null>(null);
  const rows = unattached(entities);
  if (rows.length === 0) return null;
  return (
    <section className="card" aria-labelledby="unattached-title">
      <div className="toolbar">
        <TriangleAlert size={16} aria-hidden />
        <h2 id="unattached-title" className="toolbar__title">{t("entityOps.attach.listTitle")}</h2>
      </div>
      <ul className="list-plain">
        {rows.map(({ e, w }) => (
          <li key={w.id} className="row">
            <span className="grow">{entityName(e)} · <b>{workplaceName(w)}</b></span>
            {w.headcount > 0 && <Chip tone="warn">{t("entityOps.attach.people", { count: w.headcount })}</Chip>}
            {w.can_manage && (
              <Button onClick={() => setOpen({ entityId: e.id, workplaceId: w.id })} aria-label={t("entityOps.attach.actionOf", { name: workplaceName(w) })}>
                {t("entityOps.attach.action")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {open && rows.some(({w}) => w.id === open.workplaceId && w.can_manage && !w.read_only) && <AttachHost {...open} onClose={() => setOpen(null)} />}
    </section>
  );
}
