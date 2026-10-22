import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { Receipt } from "../../../ui/receipt/receipt";
import { Sheet } from "../../../ui/sheet/sheet";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { CommandError } from "../../../lib/react/command-error";
import { announce } from "../../../lib/react/announce";
import { todayKst } from "../../../lib/pure/today";
import { LIFECYCLE_EVENT, label } from "../../../lib/labels";
import { orgStructureRef } from "../../../reference/entity/api";
import { withinEntity } from "../../../reference/entity/domain/placement";
import { unitsQuery } from "../../../reference/org/api";
import { UnitPicker } from "../../../reference/org/ui/unit-picker";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { reasonCodesQuery, useReasonCodesReady } from "../../../lib/reason-codes";
import { bulkBlock, groupRows, monthEnd, nextMonthFirst, whenOf, type Kind, type Row } from "../domain/bulk";
import { jobTitlesQuery, type BulkRequest } from "../api";
import { bulkDemotion, bulkPromotion } from "../domain/bulk-promotion";
import { DEMOTION_REASON } from "../domain/titles";
import { BulkIssues, BulkLines, Section } from "./bulk-lines";
import { useBulkCommand, type Recorded } from "./use-bulk-command";
import { useBulkRows, type Source } from "./use-bulk-rows";
import s from "./bulk.module.css";
import { Muted } from "../../../ui/muted/muted";

type Draft = { text: string; kind: Kind | null; unitId: string; position: string; date: string; code: string | null; comment: string };
const EMPTY: Draft = { text: "", kind: null, unitId: "", position: "", date: "", code: null, comment: "" };
// drafts live in memory per tab, one for the paste and one per selection: Back or a stray close keeps the
// input until it is recorded or cleared; a reload loses it.
const drafts = new Map<string, Draft>();
const draftKey = (source: Source) => ("paste" in source ? "paste" : [...source.picked.keys()].sort().join(","));
// The documented sign-offs for a same-company transfer or promotion; the bulk endpoint lists none per batch
// (backend flag, design §10), and refuses the batch, naming each employee, when one is missing.
const REASON_MAX = 1000;

/** The message for what was recorded (the roster's receipt). */
const recordedText = (kind: Kind, date: string, rs: Recorded[]) =>
  t(`bulk.recorded.${kind}.${rs.some((r) => r.scheduled) ? "future" : "now"}`, { count: rs.reduce((n, r) => n + r.count, 0), date: fmtDate(date) });

/**
 * Bulk appointment: one transfer or promotion for many people, from a roster selection or a paste keyed by employee number.
 * Nothing is preselected (type, target, date). Lines are matched and checked before commit; the batch is sent as one
 * all-or-nothing request per target, and a refusal keeps every input, marks the refused people and offers to resend
 * without them.
 */
export function BulkSheet({ source, matching, onClose, onDone }: {
  source: Source;
  /** A select-all-matching selection: how many the filter matched and how many were taken out. */
  matching?: { count: number; excluded: number };
  onClose: () => void;
  /** The receipt text of what was recorded, and the batch (rescindable as one). */
  onDone: (message: string, batch: { id: string; count: number }) => void;
}) {
  const today = todayKst();
  const paste = "paste" in source;
  const bodyId = useId();
  const key = draftKey(source);
  const [restored, setRestored] = useState(drafts.has(key));
  const [d, setD] = useState<Draft>(drafts.get(key) ?? EMPTY);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  useEffect(() => {
    if (JSON.stringify(d) === JSON.stringify(EMPTY)) drafts.delete(key);
    else drafts.set(key, d);
  }, [key, d]);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const [tried, setTried] = useState(false);
  const units = useQuery(unitsQuery);
  const titlesQ = useQuery(jobTitlesQuery);
  const titles = titlesQ.data?.items ?? [];
  // Both kinds' reasons, read with the sheet: the reason field must not land under the pointer once a kind is chosen.
  useQuery(reasonCodesQuery("lifecycle_transfer"));
  useQuery(reasonCodesQuery("lifecycle_promote"));
  const all = units.data?.items ?? [];
  const open = all.filter((u) => u.status === "ACTIVE" && u.kind !== "COMPANY");
  const sheet = { unitId: d.unitId || undefined, position: d.position.trim() || undefined };
  const resolved = useBulkRows(paste ? { paste: d.text } : source, d.kind, sheet, picks);
  // One place for everyone: only units of the legal entity each matched person works for (decisions #30: no transfer between legal entities).
  const roots = useQuery({ ...orgStructureRef, retry: false }).data?.entities ?? [];
  const employers = new Set(resolved.rows.map((r) => r.employee?.legal_entity_id).filter(Boolean));
  const targets = open.filter((u) => [...employers].every((id) => withinEntity(roots, u.id, id)));
  const cmd = useBulkCommand((rs) => {
    drafts.delete(key);
    onDone(recordedText(d.kind!, d.date, rs), { id: rs[0]!.batchId, count: rs[0]!.count });
  });

  const rows = resolved.rows.filter((r) => !dropped.has(r.key) && !(r.employee && cmd.recordedIds.has(r.employee.id)));
  const perLine = paste && resolved.lines.some((l) => l.target);
  const groups = d.kind ? groupRows(rows, d.kind, sheet) : [];
  const demotion = d.kind === "PROMOTE" && groups.some((g) => g.rows.some((r) => bulkDemotion(r.employee?.position, g.target, titles)));
  const invalidTitle = d.kind === "PROMOTE" && groups.some((g) => !bulkPromotion(g.target, titles));
  const count = rows.filter((r) => !r.problem).length;
  const errorLines = rows.filter((r) => r.problem).length;
  const when = whenOf(d.date, today);
  const codes = useReasonCodesReady(d.kind === "TRANSFER" ? "lifecycle_transfer" : d.kind === "PROMOTE" ? "lifecycle_promote" : null);
  const unitName = all.find((u) => u.id === d.unitId)?.name;

  const missing = {
    targets: paste && !d.text.trim() ? t("bulk.paste.missing") : undefined,
    kind: !d.kind ? t("bulk.kind.missing") : undefined,
    unit: d.kind === "TRANSFER" && !perLine && !d.unitId ? t("bulk.unit.missing") : undefined,
    position: d.kind === "PROMOTE" && !perLine && !d.position.trim() ? t("bulk.position.missing") : undefined,
    date: when === "none" ? t("bulk.date.missing") : undefined,
    catalog: invalidTitle ? t("bulk.position.catalogMissing") : undefined,
    code: codes && (!d.code || (demotion && d.code !== DEMOTION_REASON)) ? t(demotion ? "lifecycle.promote.demotionMissing" : "reason.field.missing") : undefined,
    comment: !d.comment.trim() ? t("bulk.reason.missing") : undefined,
  };
  const missingCount = Object.values(missing).filter(Boolean).length;
  const hasTargets = paste ? resolved.lines.length > 0 : source.picked.size > 0;
  const block = bulkBlock({ missingCount, errorLines, count, checking: (hasTargets && !resolved.ready) || !titlesQ.isSuccess, failed: resolved.failed, progress: resolved.progress });
  const blockedWhy = block ? t(block.id, block.params) : null;
  const shown = (m: string | undefined) => (tried ? m : undefined);

  const batches = (rs: Row[]): BulkRequest[] =>
    groupRows(rs, d.kind!, sheet).map((g) => ({
      event_type: d.kind!,
      employee_ids: g.rows.map((r) => r.employee!.id),
      to_org_unit_id: d.kind === "TRANSFER" ? g.target : undefined,
      ...(d.kind === "PROMOTE" ? bulkPromotion(g.target, titles) : {}),
      effective_date: d.date,
      reason_code: d.code ?? undefined,
      comment: d.comment.trim(),
    }));
  const submit = () => {
    setTried(true);
    if (block) {
      // The first field to fix, else the first line to fix.
      requestAnimationFrame(() => document.getElementById(bodyId)?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid] input, [data-missing] input, [data-tone="danger"] button')?.focus());
      return;
    }
    void cmd.send(batches(rows));
  };
  const clearDraft = () => {
    drafts.delete(key);
    setD(EMPTY);
    setRestored(false);
  };
  const refusedKeys = rows.filter((r) => r.employee && cmd.refused.has(r.employee.id)).map((r) => r.key);
  const retryWithout = () => {
    setDropped(new Set([...dropped, ...refusedKeys]));
    void cmd.send(batches(rows.filter((r) => !refusedKeys.includes(r.key))));
  };

  // Announced once the paste is checked, not at every progress step.
  const checked = resolved.ready ? t("bulk.paste.checked", { lines: rows.length, errors: errorLines }) : "";
  useEffect(() => {
    if (!checked) return;
    const id = setTimeout(() => announce(checked), 800);
    return () => clearTimeout(id);
  }, [checked]);

  // What the consequence names: the one target, or "the pasted units" when lines name several.
  const target = (() => {
    if (!d.kind) return "";
    if (!perLine) return (d.kind === "TRANSFER" ? unitName : sheet.position) ?? t(`bulk.target.unchosen.${d.kind}`);
    const only = groups.length === 1 ? groups[0]!.target : undefined;
    if (!only) return t(`bulk.target.pasted.${d.kind}`);
    return d.kind === "TRANSFER" ? (all.find((u) => u.id === only)?.name ?? only) : only;
  })();
  const date = fmtDate(d.date);
  const danger = when === "today" || when === "past";
  const commitLabel = d.kind ? t(`bulk.commit.${d.kind}.${when}`, { count, date }) : t("bulk.commit.none", { count });
  const presets = [
    { label: t("bulk.preset.nextMonthFirst"), date: nextMonthFirst(today) },
    ...(monthEnd(today) === today ? [] : [{ label: t("bulk.preset.monthEnd"), date: monthEnd(today) }]),
    { label: t("bulk.preset.today"), date: today },
  ];

  const lines = {
    rows,
    kind: d.kind,
    refused: cmd.refused,
    units: all,
    unitRefs: resolved.unitRefs,
    onPick: (line: string, id: string) => setPicks({ ...picks, [line]: id }),
    onDrop: (line: string) => setDropped(new Set([...dropped, line])),
    paste,
    locked: cmd.lost || cmd.busy,
  };
  return (
    <Sheet
      open
      wide
      title={t("bulk.title")}
      subtitle={paste ? t("bulk.subtitle.paste") : matching ? t("bulk.matching", matching) : t("bulk.subtitle.selection", { count: source.picked.size })}
      onClose={onClose}
      pending={cmd.busy}
      locked={cmd.lost}
      notice={
        <>
          {cmd.recorded.length > 0 && <Receipt state="recorded" message={recordedText(d.kind!, d.date, cmd.recorded)} />}
          {cmd.lost && <Receipt state="checking" message={t("bulk.lost.title")} />}
          {cmd.lost && <Muted>{t("bulk.lost.hint")}</Muted>}
          {refusedKeys.length > 0 && (
            <div className={`alert ${s.notice}`} role="alert">
              <span className="grow">{t(cmd.stale.size ? "bulk.stale.title" : "bulk.refused.title", { count: refusedKeys.length })}</span>
              {cmd.stale.size > 0 && <Button onClick={() => void cmd.send(batches(rows), cmd.stale)} disabled={cmd.busy}>{t("bulk.stale.repin", { count: cmd.stale.size })}</Button>}
              <Button onClick={retryWithout} disabled={cmd.busy}>{t("bulk.retryWithout", { count: refusedKeys.length })}</Button>
            </div>
          )}
          <CommandError error={cmd.error} />
        </>
      }
      consequence={
        <>
          <span>{d.kind ? t(`bulk.consequence.${d.kind}.${when}`, { count, date, target }) : t("bulk.consequence.none", { count })}</span>
          {when === "future" && <Muted>{t("bulk.consequence.interim")}</Muted>}
          <Muted>{groups.length > 1 && d.kind ? t(`bulk.groups.${d.kind}`, { count: groups.length }) : t("bulk.consequence.atomic")}</Muted>
        </>
      }
      actions={
        cmd.lost ? (
          <>
            <Button onClick={onClose}>{t("bulk.close")}</Button>
            <Button variant="primary" onClick={() => void cmd.send(batches(rows))}>{t("bulk.lost.check")}</Button>
          </>
        ) : (
          <>
            <Button onClick={onClose} disabled={cmd.busy}>{t("common.back")}</Button>
            {blockedWhy ? (
              <DisabledReason
                control={(p) => (
                  <Button variant={danger ? "danger" : "primary"} {...p} onClick={(e) => { p.onClick(e); submit(); }}>
                    {commitLabel}
                  </Button>
                )}
                reason={blockedWhy}
              />
            ) : (
              <Button variant={danger ? "danger" : "primary"} disabled={cmd.busy} onClick={submit}>{commitLabel}</Button>
            )}
          </>
        )
      }
    >
      <div id={bodyId} className={s.lines}>
        {restored && (
          <div className={`notice ${s.notice}`}>
            <span className="grow">{t("bulk.draft.restored")}</span>
            <Button variant="ghost" onClick={clearDraft}>{t("bulk.draft.clear")}</Button>
          </div>
        )}
        {paste && (
          <Section title={t("bulk.section.targets")}>
            <Field label={t("bulk.paste.label")} required hint={t("bulk.paste.hint")} error={shown(missing.targets)}>
              {(p) => <TextArea {...p} className="code" rows={6} value={d.text} onChange={(e) => set({ text: e.target.value })} />}
            </Field>
          </Section>
        )}
        <Section title={t("bulk.section.what")}>
          <ChoiceField
            label={t("bulk.kind")}
            required
            options={(["TRANSFER", "PROMOTE"] as const).map((k) => ({ value: k, label: label(LIFECYCLE_EVENT, k) }))}
            value={d.kind}
            onChange={(k) => set({ kind: k as Kind, code: null })}
            hint={perLine && d.kind ? t(`bulk.kind.fromPaste.${d.kind}`) : undefined}
            error={shown(missing.kind)}
          />
          {d.kind === "TRANSFER" && !perLine && (
            <div data-missing={shown(missing.unit) ? true : undefined}>
              <UnitPicker units={all} options={targets} value={d.unitId} onChange={(unitId) => set({ unitId })} labelText={t("bulk.unit")} />
              {shown(missing.unit) && <span className="field__error">{missing.unit}</span>}
            </div>
          )}
          {d.kind === "PROMOTE" && !perLine && (
            <Field label={t("bulk.position")} required error={shown(missing.catalog ?? missing.position)}>
              {(p) => <TextInput {...p} value={d.position} onChange={(e) => set({ position: e.target.value })} />}
            </Field>
          )}
        </Section>
        <Section title={t("bulk.section.when")}>
          <DateField label={t("bulk.date")} required value={d.date} onChange={(v) => set({ date: v })} today={today} presets={presets} suggestWeekday error={shown(missing.date)} />
        </Section>
        <Section title={t("bulk.section.why")}>
          {d.kind && (
            <ReasonCodeField key={d.kind} domain={d.kind === "TRANSFER" ? "lifecycle_transfer" : "lifecycle_promote"} only={demotion ? [DEMOTION_REASON] : undefined} label={t("lifecycle.reasonCode")} value={d.code} onChange={(code) => set({ code })} error={shown(missing.code)} />
          )}
          <Field label={t("bulk.reason")} required error={shown(missing.comment)}>
            {(p) => <TextArea {...p} rows={3} maxLength={REASON_MAX} value={d.comment} onChange={(e) => set({ comment: e.target.value })} />}
          </Field>
        </Section>
        {/* The lines last, above the commit: they resolve after the sheet opens (and again after each paste) and
            change as the choices above are made, so above those choices they would push them down. */}
        <Section title={paste ? t("bulk.lines") : t("bulk.section.targets")}>
          {resolved.failed && (
            <div className={`alert ${s.notice}`} role="alert">
              <span className="grow">{t("bulk.paste.failed")}</span>
              <Button onClick={resolved.retry}>{t("common.retry")}</Button>
            </div>
          )}
          {(paste ? d.text.trim() : true) && !resolved.ready && !resolved.failed && (
            <Muted>{t("bulk.paste.checking", resolved.progress)}</Muted>
          )}
          {resolved.ready && <BulkIssues {...lines} />}
          {resolved.ready && <BulkLines {...lines} />}
        </Section>
      </div>
    </Sheet>
  );
}

