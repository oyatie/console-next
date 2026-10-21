import { useMemo, useState } from "react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { TreeView } from "../../../ui/tree/tree";
import { descendants, type ChartNode, type Structure } from "../domain/model";
import { verdicts } from "../domain/rules";
import { moveEffect } from "../present";

/**
 * The keyboard twin of drag (M; WCAG 2.2 SC 2.5.7): a tree of the places that can take every moving department. Other legal entity
 * are hidden, not dimmed (department never cross a legal entity), and so is each moving department' own subtree. Nothing is preselected.
 */
export function MovePicker({ s, moving, onMove, onClose }: { s: Structure; moving: ChartNode[]; onMove: (target: ChartNode) => void; onClose: () => void }) {
  const entity = moving[0]?.entityId ? s.byId.get(moving[0].entityId) : undefined;
  const v = useMemo(() => verdicts(s, moving), [s, moving]);
  const hidden = useMemo(() => new Set(moving.flatMap((m) => [m.id, ...descendants(m).map((d) => d.id)])), [moving]);
  const [picked, setPicked] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(entity ? descendants(entity).map((d) => d.id) : []));
  const target = picked ? s.byId.get(picked) : undefined;
  const verdict = target && v.get(target.id);
  const mixed = new Set(moving.map((m) => m.entityId)).size > 1;
  const name = moving.length === 1 ? moving[0]!.name : t("structure.move.many", { count: moving.length });
  return (
    <Dialog open title={t("structure.move.title", { name })} onClose={onClose}>
      <p className="muted">{t("structure.move.hint")}</p>
      {entity && !mixed ? (
        <TreeView
          id="move-targets"
          label={t("structure.move.treeLabel")}
          roots={entity.children}
          childrenOf={(n) => n.children.filter((c) => !hidden.has(c.id))}
          textValue={(n) => [n.name, t(`structure.level.${n.kind}`), v.get(n.id)?.ok === false ? t("structure.drop.here") : ""].filter(Boolean).join(", ")}
          row={(n) => <span>{n.name} <span className="muted">{t(`structure.level.${n.kind}`)}{v.get(n.id)?.ok === false ? ` · ${t("structure.drop.here")}` : ""}</span></span>}
          selected={picked}
          onSelect={setPicked}
          expanded={expanded}
          onExpandedChange={setExpanded}
        />
      ) : (
        <p role="alert">{t("structure.move.mixedEntities")}</p>
      )}
      <p className="muted" role="status">{target && verdict?.ok ? moveEffect(moving, target) : t("structure.move.pick")}</p>
      <div className="form__actions">
        <Button variant="ghost" onClick={onClose}>{t("structure.cancel")}</Button>
        {target && verdict?.ok ? (
          <Button variant="primary" onClick={() => onMove(target)}>{t("structure.move.submit", { name: target.name })}</Button>
        ) : (
          <DisabledReason control={(p) => <Button variant="primary" {...p}>{t("structure.move.submitIdle")}</Button>} reason={target ? t("structure.drop.here") : t("structure.move.pick")} />
        )}
      </div>
    </Dialog>
  );
}
