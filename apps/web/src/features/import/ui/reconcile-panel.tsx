import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isMessageId, t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { entitiesRef } from "../../../reference/entity/api";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { EnumValue } from "../../../ui/enum-value";
import { IMPORT_SIGNOFF_STATE } from "../../../lib/labels";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { Table } from "../../../ui/table";
import { Card } from "../../../ui/card/card";
import { SectionHead } from "../../../ui/card/section-head";
import { reconcileQuery, signOff } from "../api";
import { ReconcileRows } from "./reconcile-rows";
import s from "./import.module.css";

const READS = ["/api/v1/employees/import"] as const;
const own = (code: string) => (isMessageId(`importReconcile.error.${code}`) ? t(`importReconcile.error.${code}` as never) : undefined);

/**
 * The migration check of an applied import (spec E7-reconcile, E7-row, E7-signoff; BE-EMP-UI §5): the funnel each sheet
 * went through, the people per workplace from the file against those already there and the console now, every row checked,
 * and the sign-off — honest when rows are still open (the count is recorded with it, never hidden behind a blocker).
 */
export function ReconcilePanel({ runId }: { runId: string }) {
  const q = useQuery(reconcileQuery(runId));
  const entities = useQuery(entitiesRef).data?.items ?? [];
  const [note, setNote] = useState("");
  const sign = useCommand({
    run: () => {
      const c = q.data!.counts;
      const open = c.needs_check + c.unchecked;
      return signOff(runId, { expected_open_count: open, acknowledge_open: open > 0, note: note.trim() || null });
    },
    invalidates: READS,
    settle: true,
  });
  const workplace = (id: string | null) => (id ? (entities.flatMap((e) => e.workplaces).find((w) => w.id === id)?.current?.name ?? "—") : t("importReconcile.place.unplaced"));
  return (
    // The check reads as the mockup's workspace: the file against the console on the left, the sign-off on the right.
    <section className={s.reconcileWrap} aria-labelledby="import-reconcile">
      <QueryState q={q}>
        {(r) => {
          const open = r.counts.needs_check + r.counts.unchecked;
          const total = r.placement.reduce((a, p) => ({ from: a.from + p.from_file, out: a.out + p.outside_file, now: a.now + p.now }), { from: 0, out: 0, now: 0 });
          return (
            <>
              <div className={s.reconcile}>
                <Card titleId="import-funnel" title={t("importReconcile.funnel.title")} level={3}>
                  <Table
                    label={t("importReconcile.funnel.title")}
                    rows={r.funnels}
                    rowId={(f) => f.sheet}
                    columns={(["sheet", "read", "preserved", "errors", "candidates", "inserted", "updated", "unchanged", "excluded"] as const).map((k) => ({
                      header: t(`importReconcile.funnel.col.${k}`),
                      cell: (f: (typeof r.funnels)[number]) => (k === "sheet" ? <b>{f.sheet}</b> : <span className="num">{f[k]}</span>),
                      fit: k !== "sheet",
                    }))}
                  />
                </Card>
                <Card titleId="import-place" title={t("importReconcile.place.title")} level={3}>
                  <Table
                    label={t("importReconcile.place.title")}
                    rows={[...r.placement.map((p) => ({ key: p.workplace_id ?? "none", name: workplace(p.workplace_id), from: p.from_file, out: p.outside_file, now: p.now })), { key: "total", name: t("importReconcile.place.total"), ...total }]}
                    rowId={(p) => p.key}
                    columns={[
                      { header: t("importReconcile.place.col.workplace"), cell: (p) => <b>{p.name}</b> },
                      { header: t("importReconcile.place.col.fromFile"), cell: (p) => <span className="num">{p.from}</span>, fit: true },
                      { header: t("importReconcile.place.col.outside"), cell: (p) => <span className="num">{p.out}</span>, fit: true },
                      { header: t("importReconcile.place.col.now"), cell: (p) => <span className="num">{p.now}</span>, fit: true },
                    ]}
                  />
                </Card>
                <Card>
                  <ReconcileRows runId={runId} frozen={r.signoff !== null} />
                </Card>
              </div>
              {/* The sign-off side: a plain surface (not a second region); its h2 names the whole check above. */}
              <Card>
                <SectionHead level={2} id="import-reconcile" tools={<EnumValue e={IMPORT_SIGNOFF_STATE} value={r.signoff ? "stateDone" : "stateOpen"} />}>{t("importReconcile.title")}</SectionHead>
                <div className={s.filters}>
                  <Chip tone="ok">{t("importReconcile.counts.confirmed", { n: r.counts.confirmed })}</Chip>
                  <Chip tone={r.counts.needs_check ? "warn" : "neutral"}>{t("importReconcile.counts.needs", { n: r.counts.needs_check })}</Chip>
                  <Chip tone={r.counts.unchecked ? "info" : "neutral"}>{t("importReconcile.counts.open", { n: r.counts.unchecked })}</Chip>
                </div>
                <SectionHead>{t("importReconcile.sign.title")}</SectionHead>
                {r.signoff ? (
                  <p role="status">{t("importReconcile.sign.done", { name: r.signoff.signed_by_name ?? "—", at: fmtDateTime(r.signoff.signed_at), rows: r.signoff.total_rows, ok: r.signoff.confirmed, bad: r.signoff.needs_check, open: r.signoff.unchecked })}</p>
                ) : (
                  <>
                    <Field label={t("importReconcile.sign.note")} required={false}>
                      {(p) => <TextArea {...p} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
                    </Field>
                    <CommandError error={sign.error} own={own} />
                    <Button variant={open > 0 ? "secondary" : "primary"} aria-disabled={sign.isPending || undefined} onClick={() => !sign.isPending && sign.mutate(undefined)}>
                      {open > 0 ? t("importReconcile.sign.commitOpen", { open }) : t("importReconcile.sign.commit", { n: r.counts.rows })}
                    </Button>
                  </>
                )}
              </Card>
            </>
          );
        }}
      </QueryState>
    </section>
  );
}
