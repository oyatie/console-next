import { useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { isMessageId, t } from "@console/i18n";
import { LIFECYCLE_EVENT, label } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { unitsQuery } from "../../../reference/org/api";
import { cancellable, correctable, verbStates, voidable, type Verb } from "../domain/lifecycle";
import { checklistRef, entitiesRef, orgStructureRef } from "../../../reference/entity/api";
import { LifecycleMenu } from "./lifecycle-menu";
import { reasonCodesQuery } from "../../../lib/reason-codes";
import { employeeQuery, fixedTermQuery, jobTitlesQuery } from "../api";
import { personalFactsQuery } from "../api/record";
import { fmtDay, whyText } from "../present";
import type { LifecycleEvent } from "../api";
import { CancelSheet } from "./lifecycle-cancel";
import { RescindSheet } from "./lifecycle-rescind";
import { GroupTransferSheet } from "./group-transfer-sheet";
import { LifecycleSheet } from "./lifecycle-sheet";
import { RehireSheet } from "./register-rehire";
import s from "./person.module.css";

type Detail = components["schemas"]["EmployeeDetail"];
type Allowed = Detail["allowed_events"][number];
type Events = UseQueryResult<{ items: LifecycleEvent[]; head_version: number }>;
/**
 * An action on offer, with the dates the server's lists leave it: `min` (and `after`, the reservation it must follow)
 * when it is offered only after the last reservation, `max` (and `before`) when only before it.
 */
export type Offer = Allowed & { event_type: Verb; min?: string; max?: string; after?: string; before?: string };
/**
 * A sheet started from an existing record: `edit` changes a reservation (its date kept, replacing it by name), `again`
 * records a failed or withdrawn one anew (date empty), `correct` replaces an applied change on its date (correction, BW-11).
 */
export type Seed = { from: LifecycleEvent; mode: "edit" | "again" | "correct" };
/**
 * A recorded commit: the receipt's sentence, the record to focus, the record a new one may start from, the act a
 * detour started from (`back`), and whether to offer the next renewal in Home's queue.
 */
export type Done = { reference?: string; message: string; eventId: string; again?: string; back?: string; renewal?: boolean; settlement?: { caseId: string; entity: string } };

type Resolved =
  | { kind: "form"; offer: Offer; seed?: Seed }
  | { kind: "cancel"; x: LifecycleEvent }
  | { kind: "rescind"; x: LifecycleEvent }
  | { kind: "unavailable"; code?: string; why: string };

/** The lifecycle acts this page opens; any other `act` (an exit step) belongs to the exit card. */
const LIFECYCLE_ACT = /^(?:[A-Z_]+(?::(?:job|relocate))?|rehire|menu|(?:cancel|edit|again|correct|rescind):.+)$/;
/**
 * The statements a correction re-signs when its kind is not on offer now (a leave corrected while on leave): the
 * server's standing rule for every event, plus payroll for a leave.
 * mirrors the server's list; a correction preview of required_signoffs (backend ask) would replace it.
 */
const CORRECTION_SIGNOFFS: Record<string, string[]> = { LEAVE_OF_ABSENCE: ["privacy_notice_ack", "korean_labor_law_ack", "payroll_cutoff_ack"] };
const BASE_SIGNOFFS = ["privacy_notice_ack", "korean_labor_law_ack"];

/**
 * What `?act=` opens: a verb (TRANSFER…), `cancel:<event>` (withdraw a reservation), `edit:<event>` (change a
 * reservation, its date kept) or `again:<event>` (record a failed or withdrawn one again, date empty).
 * Null while what it needs is still loading. Only what the server offers opens; anything else says why.
 */
function resolve(d: Detail, act: string, events: LifecycleEvent[] | undefined): Resolved | null {
  const [verb, id] = act.includes(":") ? act.split(":") : [null, null];
  if (!events) return null;
  const x = id ? events.find((e) => e.id === id) : undefined;
  const type = (x?.event_type ?? (act === "APPOINT:job" ? "APPOINT" : act === "TRANSFER:relocate" ? "TRANSFER" : act)) as Verb;
  const states = verbStates(d, events);
  const state = states.find((v) => v.verb === type);
  const listed = d.allowed_events.find((a) => a.event_type === type) ?? d.allowed_scheduled_events.find((a) => a.event_type === type);
  const why = state && !state.enabled ? whyText(state.why, [label(LIFECYCLE_EVENT, type)]) : undefined;
  const unavailable = (code?: string, reason?: string): Resolved => {
    const key = `person.act.unavailable.${code}`;
    return { kind: "unavailable", code, why: reason ?? (isMessageId(key) ? t(key) : t("person.act.unavailable.state")) };
  };
  if (verb && id && !x) return unavailable("not_found");
  const refusal = verb === "correct" || verb === "rescind" ? x?.action_refusals?.[verb] : undefined;
  if (refusal) return unavailable(refusal);
  if (verb === "cancel") return x && cancellable(x) ? { kind: "cancel", x } : unavailable("invalid_transition");
  if (verb === "rescind") return x && voidable(x, events) ? { kind: "rescind", x } : unavailable();
  if (verb === "correct") {
    // A group transfer is rescinded and recorded again, never corrected in place.
    if (!x || !correctable(x, events)) return unavailable();
    const signoffs = listed?.required_signoffs ?? CORRECTION_SIGNOFFS[x.event_type] ?? BASE_SIGNOFFS;
    return { kind: "form", offer: { event_type: type, required_signoffs: signoffs } as Offer, seed: { from: x, mode: "correct" } };
  }
  if (!listed || !state?.enabled) return unavailable("invalid_transition", why);
  const offer = { ...listed, event_type: type, min: state.min, max: state.max, after: state.after, before: state.before } as Offer;
  if (verb === null || act === "APPOINT:job" || act === "TRANSFER:relocate") return { kind: "form", offer };
  if (verb === "edit") return x && cancellable(x) ? { kind: "form", offer: { ...listed, event_type: type } as Offer, seed: { from: x, mode: "edit" } } : unavailable("invalid_transition");
  return x && x.state !== "APPLIED" ? { kind: "form", offer, seed: { from: x, mode: "again" } } : unavailable("invalid_transition");
}

/**
 * Opens the act in the URL once, when it first appears and its facts (history, units) have loaded: a later refresh
 * (focus, polling) never swaps an open sheet for a notice, it only says the record changed; the server still decides
 * at commit. `back` is the act a detour started from (a refusal's "cancel that reservation"): the receipt returns to it.
 */
export function ActHost({ d, act, back, events, onClose, onOpen, onRecorded }: {
  d: Detail;
  act?: string;
  back?: string;
  events: Events;
  onClose: () => void;
  onOpen: (act: string, back?: string) => void;
  onRecorded: (done: Done) => void;
}) {
  const units = useQuery(unitsQuery);
  const setup = useQuery({ ...checklistRef, retry: false }).data?.phase === "SETUP";
  const [snap, setSnap] = useState<{ act: string; back?: string; at: string; head: number; r: Resolved } | null>(null);
  const mine = act !== undefined && LIFECYCLE_ACT.test(act) ? act : undefined;
  // What the sheets read on open, fetched before one opens so nothing lands under the user's hand.
  const on = Boolean(mine);
  const facts = [
    useQuery({ ...reasonCodesQuery("lifecycle_cancel"), enabled: on }),
    useQuery({ ...reasonCodesQuery("lifecycle_transfer"), enabled: on }),
    useQuery({ ...reasonCodesQuery("lifecycle_promote"), enabled: on }),
    useQuery({ ...jobTitlesQuery, enabled: on }),
    useQuery({ ...fixedTermQuery(d.employee.id), enabled: on && d.employment?.employment_type === "CONTRACT" }),
    // group transfer: the receiving legal entity and their units, and the group start date on record.
    useQuery({ ...entitiesRef, enabled: on }),
    useQuery({ ...orgStructureRef, retry: false, enabled: on }),
    useQuery({ ...personalFactsQuery(d.employee.id), retry: false, enabled: on }),
  ];
  // The history's re-read after a change just recorded lands first: the sheet pins its version (BW-11), and the old
  // one would refuse the user's own next change as stale.
  // So does the person's own re-read: opened before it lands, the sheet would say the record changed under the user
  // (and grow by that line) for a change they made themselves.
  // (A second observer of the page's own read: it never fetches, it only sees that read's state.)
  const detailFetching = useQuery({ ...employeeQuery(d.employee.id), enabled: false }).isFetching;
  const ready = units.isSuccess && facts.every((q) => !q.isLoading) && !events.isFetching && !detailFetching;
  if (mine !== snap?.act) {
    const r = mine && ready ? resolve(d, mine, events.data?.items) : null;
    if (!mine || r) setSnap(mine && r ? { act: mine, back, at: d.employee.updated_at, head: events.data?.head_version ?? 0, r } : null);
  }
  const e = d.employee;
  if (mine === "menu") return <LifecycleMenu d={d} verbs={verbStates(d, events.data?.items ?? [])} setup={setup} onOpen={(next) => onOpen(next)} onClose={onClose} />;
  // A rehire (spec E3-rehire) opens from a retained exit; anyone else is told why.
  if (mine === "rehire")
    return e.status === "EXITED" && d.rehire_exit_case?.decision_final === false ? (
      <div className={s.notice} role="status"><strong>{t("exit.error.rehire_exit_case_open")}</strong><Button onClick={onClose}>{t("person.act.close")}</Button></div>
    ) : e.status === "EXITED" ? (
      <RehireSheet d={d} onClose={onClose} onDone={(message) => onRecorded({ message, eventId: "" })} />
    ) : (
      <div className={s.notice} role="status"><strong>{t("register.rehire.notExited")}</strong><Button variant="ghost" onClick={onClose}>{t("person.act.close")}</Button></div>
    );
  const r = snap?.act === mine ? snap?.r : undefined;
  if (r?.kind === "unavailable")
    return (
      <div className={s.notice} role="status">
        <strong>{t("person.act.unavailable")}</strong>
        <span>{r.why}</span>
        {r.code && <code className="muted">{r.code}</code>}
        <Button variant="ghost" onClick={onClose}>{t("person.act.close")}</Button>
      </div>
    );
  if (!snap || !r || !events.data || !units.data) return null;
  const changed = snap.at !== e.updated_at;
  if (r.kind === "cancel")
    return (
      <CancelSheet
        key={snap.act}
        d={d}
        x={r.x}
        act={snap.act}
        onClose={onClose}
        onOpen={onOpen}
        onRecorded={() => onRecorded({ message: t("lifecycle.receipt.cancelled", { name: e.name, action: label(LIFECYCLE_EVENT, r.x.event_type) }), eventId: r.x.id, again: r.x.id, back: snap.back })}
      />
    );
  if (r.kind === "rescind")
    return (
      <RescindSheet
        key={snap.act}
        d={d}
        x={r.x}
        act={snap.act}
        onClose={onClose}
        onOpen={onOpen}
        onRecorded={(out) => onRecorded({ message: t("lifecycle.receipt.rescinded", { name: e.name, action: label(LIFECYCLE_EVENT, r.x.event_type) }), eventId: out.id, back: snap.back })}
      />
    );
  const kind = r.offer.event_type;
  const receipt = (out: LifecycleEvent, done: string, settlement?: Done["settlement"]) =>
    onRecorded({
      message:
        r.seed?.mode === "correct" ? t("lifecycle.receipt.corrected", { name: e.name, action: label(LIFECYCLE_EVENT, kind), date: fmtDay(out.effective_date) })
        : out.state === "SCHEDULED" ? t("lifecycle.receipt.scheduled", { name: e.name, action: label(LIFECYCLE_EVENT, kind), date: fmtDay(out.effective_date) })
        : done,
      reference: out.command_id ?? out.id,
      eventId: out.id,
      back: snap.back,
      renewal: kind === "CONTRACT_RENEWAL",
      settlement,
    });
  const sheet = { d, events: events.data.items, head: snap.head, onReread: async () => (await events.refetch()).data?.head_version, units: units.data.items, act: snap.act, seed: r.seed, changed, onClose, onOpen };
  if (kind === "GROUP_TRANSFER")
    return (
      <GroupTransferSheet
        key={snap.act}
        {...sheet}
        offer={r.offer}
        onRecorded={(out) => {
          const caseId = out.group_transfer?.settlement_case_id;
          receipt(out, t("groupTransfer.receipt", { name: e.name, unit: out.to_org_unit ?? "—" }), caseId ? { caseId, entity: out.from_company ?? e.company ?? "—" } : undefined);
        }}
      />
    );
  return (
    <LifecycleSheet
      key={snap.act}
      {...sheet}
      offer={{ ...r.offer, event_type: kind }}
      onRecorded={(out) => receipt(out, t(`lifecycle.receipt.${kind}`, { name: e.name, unit: out.to_org_unit ?? "—", position: out.to_position ?? "—", endDate: out.contract_end_date ? fmtDay(out.contract_end_date) : "—" }))}
    />
  );
}
