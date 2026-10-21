import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { ORG_READS } from "../../../reference/org/api";
import { Button, ToggleButton } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { Kbd } from "../../../ui/kbd/kbd";
import { Receipt } from "../../../ui/receipt/receipt";
import { StepLine } from "../../../ui/step-line/step-line";
import { Card } from "../../../ui/card/card";
import { Banner } from "../../../ui/banner/banner";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { bulkAppoint, previewBulk, type BulkRequest } from "../api";
import { renewBatches, tallyChoices, type RenewBatch, type RenewChoice } from "../domain/renew";
import { RenewTable } from "./renew-table";
import { useBulkRows } from "./use-bulk-rows";
import { useBulkSelection } from "./use-bulk-selection";
import s from "./bulk-page.module.css";

const CHOICES: readonly RenewChoice[] = ["renew", "convert", "leave"];
const request = (b: RenewBatch, memo: string): BulkRequest =>
  b.choice === "renew"
    ? { event_type: "CONTRACT_RENEWAL", employee_ids: b.ids, effective_date: b.effective, contract_end_date: b.end, comment: memo }
    : { event_type: "EMPLOYMENT_TYPE_CHANGE", employee_ids: b.ids, effective_date: b.effective, to_employment_type: "REGULAR", comment: memo };

/**
 * Bulk contract renewal (spec E6-renew, BE-EMP-UI §3): the people picked in the roster, each answered with no default — renew
 * on the same term, convert to open-ended, or not renew (their exit reports open one by one after). The server checks
 * every renewal against the two-year rule first (bulk preview; a refused person is named on their row and nothing is
 * sent); then one batch per answer and contract end, each scheduled for the day after it.
 * the batches are sent one after another (each all-or-nothing on its own); one cross-batch command if the
 * server ever takes mixed acts.
 */
export function RenewPage() {
  const picked = useBulkSelection();
  const { rows } = useBulkRows({ picked }, null, {}, {});
  const people = rows.flatMap((r) => (r.employee ? [r.employee] : []));
  const [choices, setChoices] = useState<Record<string, RenewChoice>>({});
  const [months, setMonths] = useState<number | null>(null);
  const [memo, setMemo] = useState("");
  const [tried, setTried] = useState(false);
  const [refused, setRefused] = useState<ReadonlyMap<string, string>>(new Map());
  const [done, setDone] = useState<RenewBatch[] | null>(null);
  const keys = useState(() => new Map<string, string>())[0];
  const ps = people.map((e) => ({ id: e.id, end: e.contract_end_date ?? null }));
  const n = tallyChoices(ps, choices);
  const batches = renewBatches(ps, choices, months ?? 12);
  const run = useCommand({
    run: async () => {
      // Every renewal is checked first: the server names whoever it would refuse, and nothing is sent.
      const checks = await Promise.all(batches.map((b) => previewBulk(request(b, memo.trim()))));
      const no = new Map(checks.flatMap((c) => c.refusals.map((r) => [r.employee_id, r.code] as const)));
      if (no.size) return { refused: no, sent: [] as RenewBatch[] };
      for (const b of batches) {
        const body = request(b, memo.trim());
        const id = JSON.stringify(body);
        if (!keys.has(id)) keys.set(id, crypto.randomUUID());
        await bulkAppoint(body, keys.get(id)!);
      }
      return { refused: no, sent: batches };
    },
    invalidates: ["/api/v1/employees", ...ORG_READS],
    onSuccess: (r) => (setRefused(r.refused), r.sent.length && setDone(r.sent)),
  });
  if (picked.size === 0 && !done) return <div className="page"><EmptyState title={t("renew.empty.title")} reason={t("renew.empty.reason")} actions={<Link className={buttonClass("primary")} to="/people" search={{}}>{t("people.title")}</Link>} /></div>;
  const leaving = people.filter((e) => choices[e.id] === "leave");
  const gaps = [n.open > 0 && t("renew.missing.open", { n: n.open }), n.renew > 0 && !months && t("renew.missing.term"), !memo.trim() && t("renew.missing.memo")].filter(Boolean) as string[];
  const submit = () => (setTried(true), !gaps.length && !run.isPending && run.mutate(undefined));
  const steps = [
    { key: "people", label: t("renew.step.people"), state: "done" as const },
    { key: "how", label: t("renew.step.how"), state: n.open ? ("current" as const) : ("done" as const) },
    { key: "check", label: t("renew.step.check"), state: done ? ("done" as const) : n.open ? ("waiting" as const) : ("current" as const) },
    { key: "schedule", label: t("renew.step.schedule"), state: done ? ("current" as const) : ("waiting" as const) },
  ];
  const setAll = (c: RenewChoice) => setChoices((x) => ({ ...Object.fromEntries(people.filter((e) => e.contract_end_date).map((e) => [e.id, c])), ...x }));
  return (
    <div className={s.page}>
      <PageHead
        band
        crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} current={t("renew.crumb")} />}
        title={t("renew.title", { n: people.length })}
        tools={<StepLine steps={steps} label={t("renew.steps")} />}
      />
      <div role="group" aria-label={t("renew.same")} className={s.kinds}>
        <span className={s.steel}>{t("renew.same")}</span>
        {CHOICES.map((c) => <ToggleButton key={c} pressed={false} onClick={() => setAll(c)}>{t(`renew.choice.${c}`)}</ToggleButton>)}
        <span className={s.steel}>{t("renew.sameNote")}</span>
      </div>
      <div className={s.renewCols}>
        <RenewTable people={people} choices={choices} onChoice={(id, c) => (setChoices((x) => ({ ...x, [id]: c })), setRefused((m) => (m.has(id) ? new Map([...m].filter(([k]) => k !== id)) : m)))} refused={refused} months={months ?? 12} tried={tried} />
        <Card titleId="renew-side" title={t("renew.side.title")}>
          <dl className={s.stats}>{(["renew", "convert", "leave", "open"] as const).map((k) => <div key={k}><dt>{t(`renew.count.${k}`)}</dt><dd className={k === "open" && n.open ? s.err : undefined}>{n[k]}</dd></div>)}</dl>
          <ChoiceField label={t("renew.term")} required look="chips" options={[{ value: "12", label: t("renew.term.y1") }, { value: "24", label: t("renew.term.y2") }]} value={months ? String(months) : null} onChange={(v) => setMonths(Number(v))} error={tried && n.renew > 0 && !months ? t("renew.missing.term") : undefined} />
          <p className={s.steel}>{t("renew.law")}</p>
          <Field label={t("renew.memo")} required error={tried && !memo.trim() ? t("renew.missing.memo") : undefined}>
            {(p) => <TextInput {...p} maxLength={1000} value={memo} onChange={(e) => setMemo(e.target.value)} />}
          </Field>
        </Card>
      </div>
      <footer className={s.bar}>
        <div className={s.barText}>
          {refused.size > 0 && <Banner tone="danger" live="assertive">{t("renew.refused", { n: refused.size })}</Banner>}
          {done ? (
            <Receipt
              state="recorded"
              message={t("renew.done", { n: done.length })}
              actions={leaving.length > 0 && <span className={s.steel}>{t("renew.done.exits", { n: leaving.length })}</span>}
            />
          ) : tried && gaps.length ? <b className={s.err}>{gaps.join(" · ")}</b> : <span>{n.open ? t("renew.commitNone") : t("renew.law")}</span>}
          {done && done.map((b) => <Chip key={`${b.choice}${b.effective}`} tone="info">{t("renew.done.batch", { kind: t(`renew.choice.${b.choice}`), count: b.ids.length, date: fmtDate(b.effective) })}</Chip>)}
          {done && leaving.map((e) => <Link key={e.id} className={buttonClass("ghost")} to="/people/$id" params={{ id: e.id }} search={{ act: "exit.report" }}>{t("renew.exit", { name: e.name })}</Link>)}
          <CommandError error={run.error} />
        </div>
        {!done && <Button variant="primary" aria-disabled={run.isPending || undefined} onClick={submit}>{t("renew.commit", { renew: n.renew, convert: n.convert })}<Kbd keys="⌘↵" /></Button>}
      </footer>
    </div>
  );
}
