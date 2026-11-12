// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { cursorPages } from "../../../lib/query";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button, Form } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { addDays, inBounds } from "../../../ui/date/days";
import { Dialog } from "../../../ui/dialog";
import { EmptyState } from "../../../ui/empty-state";
import { MenuButton } from "../../../ui/menu/menu-button";
import { snoozeItem, unsnoozeItem } from "../api";
import type { AttentionInboxItem, AttentionInboxResponse, SnoozePreset } from "../domain/inbox-filter";
import { GroupedQueue } from "./grouped-queue";

const INBOX = "/api/v1/me/action-inbox";
const PICK = "pick";

/**
 * Postpones an item in my own list: the server's presets with their days, or a day I pick. A decision someone else is
 * waiting on offers no control. A legal deadline bounds the day; the server refuses what the menu does not.
 */
export function SnoozeMenu({ item, presets }: { item: AttentionInboxItem; presets: readonly SnoozePreset[] }) {
  return item.snooze?.allowed ? <Snooze item={item} latest={item.snooze.latest} presets={presets} /> : null;
}

function Snooze({ item, latest, presets }: { item: AttentionInboxItem; latest?: string; presets: readonly SnoozePreset[] }) {
  const [picking, setPicking] = useState(false);
  const [until, setUntil] = useState("");
  const snooze = useCommand({
    run: (day: string) => snoozeItem(item.id, day),
    invalidates: [INBOX],
    onSuccess: () => setPicking(false),
    announce: (_, day) => t("home.inbox.snooze.done", { date: fmtDate(day) }),
  });
  const bound = latest && t("home.inbox.snooze.latest", { date: fmtDate(latest) });
  const today = todayKst();
  const min = addDays(today, 1);
  return <>
    <MenuButton label={t("home.inbox.snooze")} items={[
      ...presets.map(preset => ({
        id: preset.key,
        label: t(`home.inbox.snooze.${preset.key}`),
        text: t(`home.inbox.snooze.${preset.key}`),
        hint: <time dateTime={preset.date}>{fmtDate(preset.date, { weekday: "short" })}</time>,
        why: latest && preset.date > latest ? bound : undefined,
      })),
      { id: PICK, label: t("home.inbox.snooze.pick"), text: t("home.inbox.snooze.pick") },
    ]} onAction={id => {
      if (snooze.isPending) return;
      const preset = presets.find(p => p.key === id);
      if (preset) snooze.mutate(preset.date);
      else { setUntil(""); snooze.reset(); setPicking(true); }
    }} />
    {!picking && <CommandError error={snooze.error} />}
    <Dialog open={picking} title={t("home.inbox.snooze.pick")} onClose={() => setPicking(false)} size="sm">
      <Form aria-busy={snooze.isSending} onSubmit={() => { if (!snooze.isPending && inBounds(until, min, latest)) snooze.mutate(until); }}>
        <DateField label={t("home.inbox.snooze.until")} required value={until} onChange={setUntil} today={today} min={min} max={latest} maxReason={bound} />
        <CommandError error={snooze.error} />
        <div className="form__actions"><Button type="submit" disabled={!inBounds(until, min, latest) || snooze.isPending}>{t("home.inbox.snooze")}</Button></div>
      </Form>
    </Dialog>
  </>;
}

/** A postponed item's day and the way back to my list now. */
function SnoozedUntil({ item }: { item: AttentionInboxItem }) {
  const back = useCommand({
    run: () => unsnoozeItem(item.id),
    invalidates: [INBOX],
    announce: () => t("home.inbox.snooze.back.done"),
  });
  return <div>
    {item.snooze?.until && <div className="muted t-sm">{t("home.inbox.snooze.returns", { date: fmtDate(item.snooze.until, { weekday: "short" }) })}</div>}
    <Button size="sm" disabled={back.isPending} onClick={() => back.mutate(undefined)}>{t("home.inbox.snooze.back")}</Button>
    <CommandError error={back.error} />
  </div>;
}

/** The items I postponed, each with the day it returns. */
export function SnoozedList() {
  const snoozed = useInfiniteQuery(cursorPages(INBOX, { snoozed: "only" }));
  return <QueryState q={snoozed} layout="list">{data => {
    const rows = (data.pages as AttentionInboxResponse[]).flatMap(page => page.items);
    if (!rows.length) return <EmptyState title={t("home.inbox.snooze.empty")} reason={null} />;
    return <>
      <GroupedQueue items={rows} extra={item => <SnoozedUntil item={item} />} />
      {snoozed.hasNextPage && <Button disabled={snoozed.isFetchingNextPage} onClick={() => void snoozed.fetchNextPage()}>{t("home.inbox.more")}</Button>}
    </>;
  }}</QueryState>;
}
