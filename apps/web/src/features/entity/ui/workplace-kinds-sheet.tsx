import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Settings2 } from "lucide-react";
import type { Structure, WorkplaceKind } from "@console/api/pending";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { EntityError } from "./entity-error";
import { QueryState } from "../../../lib/react/query-state";
import { useFocusInside } from "../../../lib/react/use-focus-inside";
import { orgStructureRef } from "../../../reference/entity/api";
import { isClosed } from "../../../reference/org/domain/structure";
import { STRUCTURE_READS } from "../../../reference/org/api";
import { Button, Form } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field, TextInput } from "../../../ui/field/field";
import { Sheet } from "../../../ui/sheet/sheet";
import { Table } from "../../../ui/table";
import { kindsQuery, updateKind } from "../api";
import { kindLabel, kindTaken } from "../present";
import { AddKind } from "./workplace-kind-choice";
import css from "./workplace-kinds.module.css";
import { Muted } from "../../../ui/muted/muted";

/** Open workplaces per kind code, across every legal entity. */
function useCounts(s: Structure | undefined) {
  const n = new Map<string, number>();
  for (const e of s?.entities ?? []) for (const w of e.children) if (w.kind === "WORKPLACE" && w.workplace_kind && !isClosed(w)) n.set(w.workplace_kind, (n.get(w.workplace_kind) ?? 0) + 1);
  return n;
}

/**
 * The tenant's workplace kinds (S5-kind-manage, review R19): the platform defaults and the tenant's own, each with where it
 * came from and how many workplaces use it. A label is renamed in place (a default goes back to its catalog label), and a
 * kind no workplace uses is hidden from the picker or shown again. Kinds are labels only: nothing else changes.
 * no merge and no delete (the server serves neither); hiding covers an unused kind.
 */
export function WorkplaceKindsSheet({ onClose }: { onClose: () => void }) {
  const kinds = useQuery(kindsQuery);
  const s = useQuery(orgStructureRef);
  const counts = useCounts(s.data);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string>();
  const toggle = useCommand({
    run: (k: WorkplaceKind, key: string) => updateKind(key, k.code, { active: !k.active }),
    invalidates: ["/api/v1/workplace-kinds"],
    announce: (_, k) => t(k.active ? "workplace.kinds.hidden" : "workplace.kinds.shown", { kind: kindLabel(k) }),
  });
  return (
    <Sheet
      open
      size="lg"
      kicker={<><Settings2 size={14} aria-hidden />{t("workplace.kinds.kicker")}</>}
      title={t("workplace.kinds.title")}
      onClose={onClose}
      pending={toggle.isPending}
      notice={<EntityError error={toggle.error} />}
      consequence={<Muted>{t("workplace.kinds.consequence")}</Muted>}
      actions={<Button onClick={onClose}>{t("workplace.kinds.close")}</Button>}
    >
      <QueryState q={kinds}>
        {({ items }) => (
          <>
            <Table
              label={t("workplace.kinds.title")}
              rows={[...items]}
              rowId={(k) => k.code}
              columns={[
                { header: t("workplace.kinds.col.kind"), cell: (k) => (editing === k.code ? <Relabel k={k} kinds={items} onDone={() => setEditing(undefined)} /> : <b>{kindLabel(k)}{!k.active && <Muted> · {t("workplace.kinds.hiddenTag")}</Muted>}</b>) },
                { header: t("workplace.kinds.col.source"), fit: true, cell: (k) => <Muted>{t(k.platform ? "workplace.kinds.platform" : "workplace.kinds.tenant")}</Muted> },
                { header: t("workplace.kinds.col.used"), fit: true, cell: (k) => <span className="num">{t("workplace.kinds.usedCount", { count: counts.get(k.code) ?? 0 })}</span> },
                { header: <span className="sr-only">{t("workplace.kinds.col.actions")}</span>, cell: (k) => <RowActions k={k} used={counts.get(k.code) ?? 0} editing={editing === k.code} onRename={() => setEditing(k.code)} onToggle={() => toggle.mutate(k)} /> },
              ]}
            />
            {adding ? <AddKind kinds={items} onAdded={() => setAdding(false)} onCancel={() => setAdding(false)} /> : (
              <span className="row">
                <Button variant="ghost" id="kinds-add" onClick={() => setAdding(true)}><Plus size={16} aria-hidden /> {t("workplace.create.kindAdd")}</Button>
              </span>
            )}
          </>
        )}
      </QueryState>
    </Sheet>
  );
}

/** A row's verbs: rename, back to the default name, hide or show (a kind in use is not hidden, and says why). */
function RowActions({ k, used, editing, onRename, onToggle }: { k: WorkplaceKind; used: number; editing: boolean; onRename: () => void; onToggle: () => void }) {
  const name = kindLabel(k);
  return (
    <span className={css.acts}>
      {!editing && <Button variant="ghost" className="btn--sm" onClick={onRename} aria-label={t("workplace.kinds.renameOf", { kind: name })}>{t("workplace.kinds.rename")}</Button>}
      {k.platform && <span className={css.reset} data-hidden={!k.label || undefined}><ResetLabel k={k} /></span>}
      {used > 0 && k.active ? (
        <DisabledReason layout="inline" control={(p) => <Button {...p} variant="ghost" className="btn--sm" aria-label={t("workplace.kinds.hideOf", { kind: name })}>{t("workplace.kinds.hide")}</Button>} reason={t("workplace.kinds.inUse", { count: used })} />
      ) : (
        <Button variant="ghost" className="btn--sm" onClick={onToggle} aria-label={t(k.active ? "workplace.kinds.hideOf" : "workplace.kinds.showOf", { kind: name })}>{t(k.active ? "workplace.kinds.hide" : "workplace.kinds.show")}</Button>
      )}
    </span>
  );
}

/** A kind's label typed in place; a label any other kind already shows is refused before it is sent. */
function Relabel({ k, kinds, onDone }: { k: WorkplaceKind; kinds: readonly WorkplaceKind[]; onDone: () => void }) {
  const [name, setName] = useState(kindLabel(k));
  const box = useFocusInside<HTMLSpanElement>();
  const taken = name.trim() !== "" && kindTaken(kinds, name, k.code);
  const save = useCommand({
    run: (label: string, key: string) => updateKind(key, k.code, { label }),
    // The row leaves its field only once the list is read again, so it is drawn once, final (not the old row first).
    invalidates: ["/api/v1/workplace-kinds", ...STRUCTURE_READS],
    awaitFirstRead: true,
    announce: (_, label) => t("workplace.kinds.renamed", { from: kindLabel(k), to: label }),
    onSuccess: onDone,
  });
  const submit = () => name.trim() && !taken && name.trim() !== kindLabel(k) && save.mutate(name.trim());
  return (
    <span ref={box}>
      <Form className="row" onSubmit={submit}>
        <Field label={t("workplace.kinds.newName", { kind: kindLabel(k) })} required error={taken ? t("workplace.kind.taken", { name: name.trim() }) : save.error ? <EntityError error={save.error} /> : undefined}>
          {(p) => <TextInput {...p} maxLength={40} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onDone()} />}
        </Field>
        <Button type="submit" variant="primary" className="btn--sm" disabled={save.isPending}>{t("workplace.kinds.save")}</Button>
        <Button variant="ghost" className="btn--sm" onClick={onDone}>{t("orgStructure.cancel")}</Button>
      </Form>
    </span>
  );
}

/** A default the tenant relabelled goes back to its catalog label. */
function ResetLabel({ k }: { k: WorkplaceKind }) {
  const reset = useCommand({
    run: (_: undefined, key: string) => updateKind(key, k.code, { label: null }),
    invalidates: ["/api/v1/workplace-kinds", ...STRUCTURE_READS],
    awaitFirstRead: true,
    announce: () => t("workplace.kinds.resetDone", { kind: kindLabel({ code: k.code }) }),
  });
  return <Button variant="ghost" className="btn--sm" disabled={reset.isPending} onClick={() => reset.mutate(undefined)}>{t("workplace.kinds.reset", { kind: kindLabel({ code: k.code }) })}</Button>;
}
