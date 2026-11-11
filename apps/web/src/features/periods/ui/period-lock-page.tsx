import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { focusSoon } from "../../../lib/react/announce";
import { QueryState } from "../../../lib/react/query-state";
import { EmptyState } from "../../../ui/empty-state";
import { Card } from "../../../ui/card/card";
import { PageHead } from "../../../ui/page-head/page-head";
import { Receipt } from "../../../ui/receipt/receipt";
import { Button, ToggleButton } from "../../../ui/button/button";
import { reasonCodesQuery } from "../../../lib/reason-codes";
import { failedWith, locksQuery, settingsQuery, type Domain, type PeriodLock, type UnlockOutcome } from "../api";
import { inForce } from "../domain/period";
import { requestState, shownRequest } from "../../../reference/periods/domain/request";
import { actorName, domainText, periodText } from "../present";
import { LockForm } from "./lock-form";
import { LockTable } from "./lock-table";
import { MonthStrip } from "./month-strip";
import { UnlockDialog } from "./unlock-dialog";
import { UnlockRequestDialog } from "./unlock-request";
import s from "./period-locks.module.css";

type View = "active" | "unlocked";
const route = getRouteApi("/app/people/period-locks");

/**
 * Payroll/accounting period locks (close authority, org-wide). While a lock is active the server
 * refuses every dated write inside its window; an unlock is a time box (it locks again on its own), needs a reason
 * and a passkey step-up, and waits for a second close authority when there is one (BW-15).
 * Extension point: a close event (payroll or attendance close) proposing the lock as a work item.
 */
export function PeriodLockPage() {
  const locks = useQuery(locksQuery);
  // What the lock form and the unlock dialog read, before either shows: nothing lands under the pointer.
  const reasons = useQuery(reasonCodesQuery("period_lock"));
  useQuery(reasonCodesQuery("period_unlock"));
  useQuery(settingsQuery);
  const [view, setView] = useState<View>("active");
  const [formOpen, setFormOpen] = useState<boolean | null>(null);
  const [unlocking, setUnlocking] = useState<PeriodLock | null>(null);
  // The request under review is in the URL (Home links to it); the dialog follows the live list, never a stale copy.
  const { review, unlock } = route.useSearch();
  const navigate = route.useNavigate();
  const setReviewing = (id: string | null) => void navigate({ search: { review: id ?? undefined }, replace: true });
  const [preset, setPreset] = useState<{ domain: Domain; month: string } | null>(null);
  const [receipt, setReceipt] = useState<{ message: string; at: string } | null>(null);
  const items = locks.data?.items ?? [];
  const rows = { active: items.filter(inForce), unlocked: items.filter((l) => !inForce(l)) };
  // Open by default while nothing is locked; after that it follows the head button.
  const open = formOpen ?? (locks.isSuccess && rows.active.length === 0);
  // Refused (or failed) before anything loaded: the refusal alone, once. No form, list or new-lock button the viewer
  // cannot use, and nothing mounted that reads the locks again.
  const refused = locks.isError && locks.data === undefined;

  // A link to one lock's unlock (from a closed attendance month) shows its dialog, or its waiting request, while in the URL.
  const linked = unlock ? rows.active.find((x) => x.id === unlock) : undefined;
  const linkedRequest = linked && shownRequest(linked, locks.dataUpdatedAt);
  const linkedPending = !!linkedRequest && requestState(linkedRequest, locks.dataUpdatedAt) === "PENDING";
  const dropLink = () => void navigate({ search: {}, replace: true });

  // After an unlock, focus moves once the refetched list no longer holds the lock: by then the dialog
  // has closed and React Aria has restored its focus, so the move is not undone.
  const unlocked = useRef<string | null>(null);
  useEffect(() => {
    if (unlocked.current && !rows.active.some((l) => l.id === unlocked.current)) {
      unlocked.current = null;
      focusSoon("pl-list");
    }
  });

  const recorded = (key: "periodLocks.locked" | "periodLocks.unlocked" | "periodLocks.unlockPending" | "periodLocks.request.approved" | "periodLocks.request.rejected", l: PeriodLock, at: string, extra?: string) => {
    // The Receipt is the page's live region (role="status"); announcing it again would read it twice.
    const message = t(key, { actor: actorName(), domain: domainText(l.domain), period: periodText(l) });
    setReceipt({ message: extra ? `${message} ${extra}` : message, at });
  };
  // BW-15: an unlock either waits for a second close authority or, with none, opens now and is flagged for review.
  const unlockDone = (l: PeriodLock, out: UnlockOutcome) => {
    setUnlocking(null);
    const until = out.lock.relockAt ?? out.request?.relockAt;
    const relock = until ? t("periodLocks.unlock.relocksAt", { at: fmtDateTime(until) }) : undefined;
    if (out.status === "PENDING_SECOND_PERSON") return recorded("periodLocks.unlockPending", l, out.request?.requestedAt ?? l.lockedAt, relock);
    unlocked.current = l.id;
    setView("active");
    recorded("periodLocks.unlocked", out.lock, out.lock.unlockedAt ?? l.lockedAt, [relock, out.lock.unlockReviewRequired ? t("periodLocks.unlock.review") : ""].filter(Boolean).join(" "));
  };
  // The second person's decision: an approval opens the period (the lock leaves the list), a refusal keeps it.
  const decided = (l: PeriodLock, how: "approved" | "rejected") => {
    setReviewing(null);
    if (how === "approved") unlocked.current = l.id;
    recorded(how === "approved" ? "periodLocks.request.approved" : "periodLocks.request.rejected", l, new Date().toISOString());
    if (how === "rejected") focusSoon(`pl-unlock-${l.id}`);
  };
  const showLock = (id: string) => {
    setView("active");
    focusSoon(`pl-unlock-${id}`);
  };
  const viewTitle = t(view === "active" ? "periodLocks.active.section" : "periodLocks.unlocked.section", { count: rows[view].length });

  return (
    <div className="page">
      <PageHead
        title={t("periodLocks.title")}
        tools={
          !refused && <Button id="pl-new-open" variant="primary" aria-expanded={open} aria-controls="pl-new" onClick={() => (setFormOpen(!open), !open && focusSoon("pl-new-title"))}>
            {t("periodLocks.new")}
          </Button>
        }
      />
      {receipt && <Receipt state="recorded" message={receipt.message} meta={fmtDateTime(receipt.at)} />}
      {/* One loading card until the locks land: the form opens above the list when none is active, and the list
          must not be on screen first, under a pointer, to be pushed down by it. */}
      {refused && failedWith(locks.error, 403) ? <Card><EmptyState title={t("periodLocks.denied.title")} reason={t("periodLocks.denied.reason")} /></Card> : locks.isPending || reasons.isPending || refused ? <Card><QueryState q={locks}>{() => null}</QueryState></Card> : (
        <>
          <div id="pl-new" hidden={!open}>
            <Card title={t("periodLocks.new")} titleId="pl-new-title">
              <LockForm key={preset ? `${preset.domain}-${preset.month}` : "new"} preset={preset} locks={rows.active} onLocked={(l) => (setFormOpen(true), recorded("periodLocks.locked", l, l.lockedAt))} onShowLock={showLock} onClose={() => (setFormOpen(false), focusSoon("pl-new-open"))} />
            </Card>
          </div>
          <MonthStrip
            locks={items}
            onShowLock={showLock}
            onLockMonth={(domain, month) => (setPreset({ domain, month }), setFormOpen(true), focusSoon("pl-new-title"))}
            onRelocked={(l) => recorded("periodLocks.locked", l, l.lockedAt)}
          />
          <Card
            title={viewTitle}
            titleId="pl-list"
            flush
            tools={
              <div className={s.views} role="group" aria-label={t("periodLocks.views")}>
                {(["active", "unlocked"] as const).map((v) => (
                  <ToggleButton key={v} size="sm" pressed={view === v} onClick={() => setView(v)}>
                    {t(`periodLocks.view.${v}`, { count: rows[v].length })}
                  </ToggleButton>
                ))}
              </div>
            }
          >
            <QueryState
              q={locks}
              empty={() =>
                rows[view].length ? null : view === "active" ? <EmptyState title={t("periodLocks.none.title")} reason={t("periodLocks.none.reason")} /> : <EmptyState title={t("periodLocks.unlocked.none")} reason={t("periodLocks.unlocked.none.reason")} />
              }
            >
              {() => <LockTable label={viewTitle} rows={rows[view]} view={view} now={locks.dataUpdatedAt} onUnlock={setUnlocking} onRequest={(l) => setReviewing(l.id)} onRelocked={(l) => (setView("active"), recorded("periodLocks.locked", l, l.lockedAt))} />}
            </QueryState>
          </Card>
        </>
      )}
      <UnlockDialog lock={unlocking ?? (linked && !linkedPending ? linked : null)} onClose={() => (setUnlocking(null), unlock && dropLink())} onDone={(l, out) => (unlock && dropLink(), unlockDone(l, out))} />
      <UnlockRequestDialog lock={items.find((l) => l.id === (review ?? (linkedPending ? unlock : undefined))) ?? null} asOf={locks.dataUpdatedAt} onClose={() => setReviewing(null)} onDone={decided} />
    </div>
  );
}
