import { useState } from "react";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Receipt } from "../../../ui/receipt/receipt";
import { Chip } from "../../../ui/chip";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { LongTable, type LongColumn } from "../../../ui/long-table/long-table";
import { renumberApply, renumberPreview, renumberUndo, type RenumberLine, type RenumberPreview, type RenumberRequest, type RenumberResult } from "../api";
import { scopeKey, type Scope } from "../domain/numbering";
import { identifiersError } from "../present";
import { RenumberForm } from "./renumber-form";

/**
 * Renumbering a scope's current people under a new scheme (SETUP only): the server's old → new list with every
 * conflict marked, an apply bound to that list's digest, and an undo of the whole job while still in SETUP. Every old
 * number stays its person's alias.
 */
export function RenumberCard({ scopes, phase }: { scopes: readonly Scope[]; phase: "SETUP" | "OPERATING" }) {
  return <Card title={t("identifiers.renumber.title")}>
    <p className="muted">{t(phase === "SETUP" ? "identifiers.renumber.why" : "identifiers.renumber.whyAfter")}</p>
    {phase === "SETUP" && <SetupRenumber scopes={scopes} />}
  </Card>;
}

function SetupRenumber({ scopes }: { scopes: readonly Scope[] }) {
  const [shown, setShown] = useState<{ req: RenumberRequest; preview: RenumberPreview } | null>(null);
  const [done, setDone] = useState<RenumberResult | null>(null);
  const [undone, setUndone] = useState<number | null>(null);
  const preview = useCommand({
    run: (req: RenumberRequest) => renumberPreview(req).then((p) => ({ req, preview: p })),
    onSuccess: (r) => (setShown(r), setDone(null), setUndone(null)),
  });
  const apply = useCommand({
    run: () => renumberApply(shown!.req, shown!.preview.preview_digest),
    invalidates: ["/api/v1/employees", "/api/v1/employee-number-rules"],
    announce: (r) => t("identifiers.renumber.done", { count: r.changed }),
    onSuccess: (r) => (setDone(r), setShown(null)),
  });
  const undo = useCommand({
    run: () => renumberUndo(done!.batch_id),
    invalidates: ["/api/v1/employees", "/api/v1/employee-number-rules"],
    announce: (r) => t("identifiers.renumber.undone", { count: r.changed }),
    onSuccess: (r) => (setUndone(r.changed), setDone(null)),
  });
  const p = shown?.preview;
  const columns: LongColumn<RenumberLine>[] = [
    { id: "from", header: t("identifiers.renumber.col.from"), cell: (l) => <span className="code">{l.from ?? t("identifiers.number.none")}</span>, rowHeader: true },
    { id: "to", header: t("identifiers.renumber.col.to"), cell: (l) => <span className="code">{l.to}</span> },
    { id: "conflict", header: t("identifiers.renumber.col.conflict"), cell: (l) => (l.conflict ? <Chip tone="danger">{t("identifiers.renumber.conflict")}</Chip> : null), width: 160 },
  ];
  const go = t("identifiers.renumber.apply", { count: p?.lines.length ?? 0 });
  const blocked = p && p.conflicts > 0 ? t("identifiers.renumber.conflicts", { count: p.conflicts }) : null;
  return (
    <>
      <RenumberForm scopes={scopes} today={todayKst()} busy={preview.isPending} onPreview={(req) => preview.mutate(req)} onEdit={() => setShown(null)} />
      <CommandError error={preview.error ?? apply.error ?? undo.error} own={identifiersError} />
      {p && (
        <>
          <p className="muted">{t("identifiers.renumber.summary", { count: p.lines.length, conflicts: p.conflicts, scope: scopes.find((s) => scopeKey(s) === scopeKey({ kind: shown!.req.scope_kind, id: shown!.req.scope_id }))?.label ?? "" })}</p>
          <LongTable
            label={t("identifiers.renumber.lines")}
            caption={t("identifiers.renumber.caption", { count: fmtNumber(p.lines.length) })}
            columns={columns}
            rows={p.lines}
            rowId={(l) => l.employee_id}
            hasMore={false}
            onLoadMore={() => undefined}
            empty={t("identifiers.renumber.empty")}
            density="compact"
          />
          <ActionBar
            actions={
              blocked || p.lines.length === 0 ? (
                <DisabledReason control={(x) => <Button {...x} variant="primary">{go}</Button>} reason={blocked ?? t("identifiers.renumber.empty")} />
              ) : (
                <Button variant="primary" disabled={apply.isPending} onClick={() => apply.mutate(undefined)}>{go}</Button>
              )
            }
          />
        </>
      )}
      {done && (
        <Receipt
          state="recorded"
          message={t("identifiers.renumber.done", { count: done.changed })}
          actions={
            <Button disabled={undo.isPending} onClick={() => undo.mutate(undefined)}>{t("identifiers.renumber.undo")}</Button>
          }
        />
      )}
      {undone != null && <p role="status">{t("identifiers.renumber.undone", { count: undone })}</p>}
    </>
  );
}
