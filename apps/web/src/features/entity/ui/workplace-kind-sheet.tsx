import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock, MapPin, Settings2 } from "lucide-react";
import type { Workplace, WorkplaceKind } from "@console/api/pending";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { EntityError } from "./entity-error";
import { QueryState } from "../../../lib/react/query-state";
import { STRUCTURE_READS } from "../../../reference/org/api";
import { Button } from "../../../ui/button/button";
import { Sheet } from "../../../ui/sheet/sheet";
import { kindsQuery, setKind } from "../api";
import { workplaceName } from "../domain/view";
import { kindName } from "../present";
import { KindChoice } from "./workplace-kind-choice";
import css from "../../../reference/org/ui/structure.module.css";

/**
 * A workplace's kind (S5 change kind, MR-19): a label only, so it changes at once in either phase and nothing else
 * follows. Nothing is preselected; the current kind is named. Managing kinds opens the tenant's list.
 */
export function WorkplaceKindSheet({ w, onClose, onManage }: { w: Workplace; onClose: () => void; onManage: () => void }) {
  const kinds = useQuery(kindsQuery);
  return <QueryState q={kinds}>{(d) => <Body w={w} kinds={d.items} onClose={onClose} onManage={onManage} />}</QueryState>;
}

function Body({ w, kinds, onClose, onManage }: { w: Workplace; kinds: readonly WorkplaceKind[]; onClose: () => void; onManage: () => void }) {
  const [to, setTo] = useState<string | null>(null);
  const name = workplaceName(w);
  const ready = to !== null && to !== w.kind_code;
  const save = useCommand({
    run: (code: string, key: string) => setKind(key, w.id, code),
    invalidates: [...STRUCTURE_READS, "/api/v1/workplace-kinds"],
    announce: (_, code) => t("workplace.kind.done", { name, kind: kindName(kinds, code) }),
    onSuccess: onClose,
  });
  const reasonId = "wp-kind-reason";
  return (
    <Sheet
      open
      kicker={<><MapPin size={14} aria-hidden />{name}</>}
      title={t("workplace.kind.title", { name })}
      subtitle={w.kind_code ? t("workplace.kind.now", { kind: kindName(kinds, w.kind_code) }) : t("workplace.kind.none")}
      onClose={onClose}
      pending={save.isPending}
      notice={<EntityError error={save.error} />}
      consequence={
        ready ? <span>{t("workplace.kind.consequence", { name, kind: kindName(kinds, to) })}</span>
        : <span id={reasonId} className={css.footReason}><Lock size={14} aria-hidden />{t("workplace.kind.pick")}</span>
      }
      actions={
        <>
          <Button onClick={onClose}>{t("orgStructure.cancel")}</Button>
          {ready ? <Button variant="primary" onClick={() => save.mutate(to)}>{t("workplace.kind.save")}</Button>
          : <Button variant="primary" aria-disabled aria-describedby={reasonId}>{t("workplace.kind.save")}</Button>}
        </>
      }
    >
      <KindChoice kinds={kinds} value={to} onChange={setTo} />
      <Button variant="ghost" id="act-wp-kinds" onClick={onManage}><Settings2 size={16} aria-hidden /> {t("workplace.kinds.title")}</Button>
    </Sheet>
  );
}
