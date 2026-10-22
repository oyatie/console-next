import { useState } from "react";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { actor } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Table } from "../../../ui/table";
import { Card as Surface } from "../../../ui/card/card";
import type { LifecycleEvent } from "../api";
import type { VerbState } from "../domain/lifecycle";
import { describeEvent, eventField, eventWhat } from "../present";
import { AccountLinkCard } from "./account-link-card";
import { PersonHistory } from "./person-history";
import type { Done } from "./person-act";
import type { CardTab } from "./card-head";
import type { Card } from "./use-card";
import { tx } from "../present";
import { Banner } from "../../../ui/banner/banner";
import s from "./card.module.css";

type Kind = "rev" | "plan" | "fix" | "first";
type Row = { id: string; at: string; from?: string; kind: Kind; what: string; change: string; how: string; who: string; why: string; event?: LifecycleEvent };

/** The tabs beside the personnel card: action history, documents, change history (the person's ledger, E2-history), access. */
export function CardTabs({ c, tab, verbs, today, done, onAct, onDismiss }: { c: Card; tab: Exclude<CardTab, "card">; verbs: VerbState[]; today: string; done: Done | null; onAct: (act: string) => void; onDismiss: () => void }) {
  return (
    <div className={s.pad}>
      {tab === "events" && <PersonHistory employee={c.e} events={c.events} verbs={verbs} manage={c.manage} today={today} done={done} onAct={onAct} onDismiss={onDismiss} />}
      {tab === "docs" && <Banner>{t("empCard.docs.unserved")}</Banner>}
      {tab === "ledger" && <Ledger c={c} onAct={onAct} />}
      {tab === "access" && (
        <>
          <AccountLinkCard employee={c.e} manage={c.users} />
        </>
      )}
    </div>
  );
}

/**
 * change history (E2-history): recorded date (when it was written) apart from effective date (when it holds), newest written first. The personnel action
 * record and the section rows are served; field corrections (MR-8 ledger) and read rows are not readable yet, which
 * the head says instead of showing a short history as if it were whole.
 */
function Ledger({ c, onAct }: { c: Card; onAct: (act: string) => void }) {
  const [only, setOnly] = useState<Kind | "all">("all");
  const events = c.events.data?.items ?? [];
  const byId = (id: string) => events.find((x) => x.id === id);
  const rows: Row[] = [
    ...events.filter((x) => x.state !== "CANCELLED").map((x): Row => {
      const { title, detail } = describeEvent(x, c.e.name, byId);
      const kind: Kind = x.state === "SCHEDULED" ? "plan" : x.event_type === "ONBOARD" ? "first" : x.voids_event_id || x.event_type === "RESCIND" ? "fix" : "rev";
      // A field and its before → after where the act names one (duty title · lead → foreman), else the act's sentence.
      const field = eventField(x);
      const what = eventWhat(x, c.title) || (x.event_type === "RETURN_FROM_LEAVE" ? t("empCard.ledger.returned") : "");
      return { id: x.id, at: x.created_at, from: x.effective_date, kind, what: field ?? title, change: field && what ? what : detail, how: t(x.batch_id ? "empCard.ledger.batch" : "empCard.ledger.sheet"), who: actor(x.created_by_name), why: x.comment, event: x };
    }),
    ...(c.records.data?.items ?? []).map((x): Row => ({ id: x.id, at: x.created_at, kind: "first", what: tx(`empRec.${x.section.toLowerCase()}`), change: t(x.voided ? "empCard.ledger.voided" : "empCard.ledger.added"), how: t(x.source === "IMPORT" ? "empCard.ledger.import" : "empCard.ledger.card"), who: "—", why: "" })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const shown = only === "all" ? rows : rows.filter((r) => r.kind === only);
  const count = (k: Kind) => rows.filter((r) => r.kind === k).length;
  const tone = { rev: "info", plan: "info", fix: "warn", first: "ok" } as const;
  return (
    <>
      <div className={s.filters} role="group" aria-label={t("empCard.ledger.filter")}>
        <Button variant="ghost" aria-pressed={only === "all"} onClick={() => setOnly("all")}>{t("empCard.ledger.all", { count: rows.length })}</Button>
        {(["rev", "fix", "plan", "first"] as const).map((k) => <Button key={k} variant="ghost" aria-pressed={only === k} onClick={() => setOnly(k)}>{t(`empCard.ledger.kind.${k}`)} {count(k)}</Button>)}
        <span className="grow" />
      </div>
      <Surface label={t("empCard.tab.ledger")}>
        <Table
          label={t("empCard.tab.ledger")}
          rows={shown}
          rowId={(r) => r.id}
          columns={[
            { header: t("empCard.ledger.at"), cell: (r) => <span className={s.num}>{fmtDateTime(r.at)}</span>, fit: true },
            { header: t("empCard.ledger.from"), cell: (r) => <span className={s.num}>{r.from ? fmtDate(r.from) : "—"}</span>, fit: true },
            { header: t("empCard.ledger.kind"), cell: (r) => <Chip tone={tone[r.kind]}>{t(`empCard.ledger.kind.${r.kind}`)}</Chip>, fit: true },
            { header: t("empCard.ledger.what"), cell: (r) => <b>{r.what}</b> },
            { header: t("empCard.ledger.change"), cell: (r) => r.change },
            { header: t("empCard.ledger.how"), cell: (r) => r.how, fit: true },
            { header: t("empCard.ledger.who"), cell: (r) => r.who, fit: true },
            { header: t("empCard.ledger.why"), cell: (r) => r.why || "—", wide: true },
            { header: "", cell: (r) => (r.event?.state === "SCHEDULED" ? <Button variant="ghost" onClick={() => onAct(`cancel:${r.event!.id}`)}>{t("empCard.spine.cancel")}</Button> : null), fit: true },
          ]}
        />
        <div className={s.foot}>{t("empCard.ledger.foot", { count: shown.length })}</div>
      </Surface>
    </>
  );
}
