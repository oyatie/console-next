import { useId, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { announce } from "../../../lib/react/announce";
import { failureText } from "../../../lib/refusal";
import { todayKst } from "../../../lib/pure/today";
import { label, PERIOD_LOCK_DOMAIN, UNIT_KIND } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { Composer } from "../../../ui/composer/composer";
import type { ActionDescription } from "../../../ui/composer/actions";
import { ORG_READS } from "../../../reference/org/api";
import { appendOp, dateDraft, submitDraft } from "../api";
import { currentName, fieldsOf, validate, type Field, type FieldError, type Intent, type Values } from "../domain/proposal";
import { EffectiveDate, ReasonText } from "./propose-fields";
import { useFreezeCheck } from "./use-freeze-check";
import { useOrgRouted } from "./use-org-routed";
import s from "./propose.module.css";

type Change = components["schemas"]["OrgChangeDetail"];
type Summary = components["schemas"]["OrgChangeSummary"];
type Op = components["schemas"]["OrgProposalOp"];
type Press = "draft" | "submit" | "append";
/** What a press did. `failed`: the draft was saved but the follow-up (date and reason, or the submit) was not. */
type Done = { draft: Change | Summary; unsent: boolean; submit: boolean; press: Press; failed?: string };
export type Check = { tone: "ok" | "caution" | "block"; text: ReactNode; action?: ReactNode };
/** What one intent puts into the card; the shell owns validation, the checks list, the decision bar and the submit flow. */
type Spec = {
  title: string;
  context: ReactNode;
  inputs: ReactNode;
  diff: ReactNode;
  checks: Check[];
  /** Open changes already on the same target: listed as cautions with a link. */
  related?: Summary[];
  consequence: string;
  action: ActionDescription["kind"];
  count?: number;
  /** A fact that makes submitting impossible now; the draft may still be saved. */
  block?: { reason: string; remedy?: ReactNode };
  /** Drafts the change. `dated`: the request already carries the date and reason (no follow-up PATCH). */
  create: (key: string) => Promise<Change>;
  dated: boolean;
  /** My open draft this op can join instead (several edits, one approval): it keeps that draft's date and reason. */
  append?: { into: Summary; op: Op };
};
/** What an intent's inputs get: the values, a setter, each field's shown error, and the wrapper that tracks blur. */
export type Kit = { v: Values; set: (f: Field, value: string) => void; error: (f: Field) => ReactNode | undefined; wrap: (f: Field, node: ReactNode) => ReactNode };

const PICKED: readonly Field[] = ["parent", "to", "date"];
const FIELD_LABEL = { parent: "orgPropose.field.parent", to: "orgPropose.field.to", date: "orgPropose.field.date", reason: "orgPropose.field.reason" } as const;
/** A field's label, as its input shows it: for errors and the missing-fields hint. */
const labelOf = (i: Intent, f: Field) =>
  f !== "name" ? t(FIELD_LABEL[f])
  : i.kind === "create" ? t("orgPropose.field.name", { kind: label(UNIT_KIND, i.child) })
  : t("orgPropose.field.newName");

/** The card around one intent: context → input → preview → checks → approval route → consequence → decision bar. */
export function ProposalForm({ intent, v, set, onClose, spec }: { intent: Intent; v: Values; set: (f: Field, value: string) => void; onClose: () => void; spec: (kit: Kit) => Spec }) {
  const nav = useNavigate();
  const appendId = useId();
  const today = todayKst();
  const [touched, setTouched] = useState<ReadonlySet<Field>>(new Set());
  const [pressed, setPressed] = useState(false);
  const fields = fieldsOf(intent);
  const errors = validate(fields, v, { today, current: currentName(intent) });
  const dirty = fields.some((f) => v[f].trim() !== "");
  const card = useRef<HTMLDivElement>(null);
  const freeze = useFreezeCheck(v.date);
  const error = (f: Field) => {
    const e = errors[f];
    return e && (pressed || touched.has(f)) ? errorText(f, e) : undefined;
  };
  const errorText = (f: Field, e: FieldError) =>
    e === "unchanged" ? t("orgPropose.field.name.unchanged")
    : e === "beforeToday" ? t("orgPropose.field.date.beforeToday")
    : t(PICKED.includes(f) ? "orgPropose.error.pick" : "orgPropose.error.type", { label: labelOf(intent, f) });
  const wrap = (f: Field, node: ReactNode) => (
    <div data-field={f} onBlur={(e: FocusEvent<HTMLDivElement>) => !e.currentTarget.contains(e.relatedTarget) && setTouched((x) => new Set(x).add(f))}>
      {node}
    </div>
  );
  const sp = spec({ v, set, error, wrap });
  // decisions #26: without approval the press applies today's change, or schedules it for its effective date.
  const routed = useOrgRouted();
  const later = v.date > today;
  const sentText = (code: string) => (routed ? t("orgPropose.done.submitted", { code }) : later ? t("orgPropose.done.scheduled", { code, date: fmtDate(v.date) }) : t("orgPropose.done.applied", { code }));

  const propose = useCommand({
    run: async (press: Press, key: string): Promise<Done> => {
      const submit = press === "submit";
      if (press === "append" && sp.append) {
        await appendOp(sp.append.into.id, sp.append.op);
        return { draft: sp.append.into, unsent: false, submit, press };
      }
      const draft = await sp.create(key);
      // From here the draft exists. A failure goes to it (its page fixes and submits it): pressing again here
      // would draft a second one.
      const saved = (what: "orgPropose.done.undated" | "orgPropose.done.notSent", e: unknown): Done =>
        ({ draft, unsent: false, submit: false, press, failed: t(what, { code: draft.code, reason: failureText(e) }) });
      // A spec whose drafting URL takes neither the date nor the reason sends them in one PATCH.
      if (!sp.dated) {
        try {
          await dateDraft(draft.id, { effectiveDate: v.date, reason: v.reason.trim() });
        } catch (e) {
          return saved("orgPropose.done.undated", e);
        }
      }
      if (!submit) return { draft, unsent: false, submit, press };
      try {
        return { draft, unsent: (await submitDraft(draft.id)) === "unsent", submit, press };
      } catch (e) {
        return saved("orgPropose.done.notSent", e);
      }
    },
    invalidates: ORG_READS,
    announce: ({ draft, unsent, submit, press, failed }) =>
      failed ?? (press === "submit" && submit && !unsent ? sentText(draft.code) : t(press === "append" ? "orgPropose.done.appended" : !submit ? "orgPropose.done.drafted" : "orgPropose.done.unsent", { code: draft.code })),
    onSuccess: ({ draft, unsent, submit }) =>
      void nav({ to: "/org/changes/$id", params: { id: draft.id }, search: { unsent: unsent || undefined, done: unsent ? undefined : submit ? "submitted" : "drafted" } }),
  });

  const go = (press: Press) => {
    if (propose.isPending) return;
    // Joining a draft takes only what this edit is; the draft keeps its own date and reason.
    const wrong = fields.filter((f) => errors[f] && !(press === "append" && (f === "date" || f === "reason")));
    if (wrong.length) {
      setPressed(true);
      announce(t("orgPropose.errors", { count: wrong.length }));
      requestAnimationFrame(() => card.current?.querySelector<HTMLElement>(`[data-field="${wrong[0]}"] :is(input, textarea, select)`)?.focus());
      return;
    }
    if (!(press === "submit" && sp.block)) propose.mutate(press);
  };
  const missing = fields.filter((f) => errors[f] === "required").map((f) => labelOf(intent, f));
  const checks: Check[] = [
    ...sp.checks,
    ...(sp.related ?? []).map((c): Check => ({ tone: "caution", text: t("orgPropose.checks.openChange"), action: <RelatedLink c={c} /> })),
    ...(freeze ? [{ tone: "caution" as const, text: t("orgPropose.checks.frozen", { domain: label(PERIOD_LOCK_DOMAIN, freeze.domain), from: fmtDate(freeze.periodStart), to: fmtDate(freeze.periodEnd) }) }] : []),
  ];

  return (
    <Composer
      title={sp.title}
      subtitle={t("orgPropose.unsaved")}
      dirty={dirty}
      onClose={onClose}
      pending={propose.isPending}
      action={{ kind: sp.action, mode: routed ? "request" : later ? "schedule" : "apply", count: sp.count ?? 1 }}
      onSubmit={() => go("submit")}
      blocked={sp.block}
      onSaveDraft={() => go("draft")}
      secondary={sp.append && <Button aria-describedby={appendId} disabled={propose.isPending} onClick={() => go("append")}>{t("orgPropose.append", { code: sp.append.into.code })}</Button>}
      notice={<>
        {sp.append && <p id={appendId} className={s.note}>{t("orgPropose.append.note", { code: sp.append.into.code, date: fmtDate(sp.append.into.effectiveDate) })}</p>}
        <CommandError error={propose.error} />
        {missing.length > 0 && <p className={s.note}>{t("orgPropose.missing", { fields: missing.join(" · ") })}</p>}
      </>}
      sections={{
        preflight: <><p className={s.note}>{t("orgPropose.checks.title")}</p><ul className={s.checks}>{checks.map((c, i) => (
          <li key={i} className={s.check} data-tone={c.tone}>
            {c.tone === "ok" ? <CheckCircle2 size={16} aria-hidden /> : c.tone === "caution" ? <AlertTriangle size={16} aria-hidden /> : <XCircle size={16} aria-hidden />}
            <span className={s.checkTag}>{t(`orgPropose.checks.tone.${c.tone}`)}</span><span>{c.text}</span>{c.action != null && <span className={s.checkAction}>{c.action}</span>}
          </li>
        ))}</ul></>,
        effects: <>{sp.diff}<p className={s.consequence}>{sp.consequence}</p></>,
        approvals: routed ? <p className={s.note}>{t("orgPropose.route")}</p> : null,
      }}
    >
      <div ref={card} className={s.section}>
        {sp.context}
        {sp.inputs}
        {wrap("date", <EffectiveDate value={v.date} onChange={(x) => set("date", x)} today={today} error={error("date")} />)}
        {wrap("reason", <ReasonText intent={intent.kind} value={v.reason} onChange={(x) => set("reason", x)} error={error("reason")} />)}
      </div>
    </Composer>
  );
}

function RelatedLink({ c }: { c: Summary }) {
  const nav = useNavigate();
  return <Button variant="ghost" onClick={() => void nav({ to: "/org/changes/$id", params: { id: c.id } })}>{t("orgPropose.openChange", { code: c.code })}</Button>;
}
