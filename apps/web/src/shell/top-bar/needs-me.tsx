// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { Inbox } from "lucide-react";
import { session } from "@console/api";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { cursorPages } from "../../lib/query";
import { inboxFilter } from "../../features/home/domain/inbox-filter";
import { chunk } from "../../lib/chunk-guard";
import { ReadSkeleton } from "../../ui/skeleton/skeleton";
import s from "./top-bar.module.css";

type InboxPage = components["schemas"]["ActionInboxResponse"];
const NeedsMePanel = lazy(() => chunk(import("./needs-me-panel")).then(m => ({ default: m.NeedsMePanel })));

/** Header 'needs me' badge and popover task panel driven by `/api/v1/me/action-inbox` (`filter: "turn"`). */
export function NeedsMeMenu({ id, seed }: { id: string; seed?: InboxPage }) {
  const claims = useSyncExternalStore(session.subscribe, () => session.claims);
  const platform = !seed && !!claims?.platform;
  const { pathname, search } = useLocation();
  const [open, setOpen] = useState(false);
  const home = pathname === "/";
  const fullInbox = pathname === "/inbox";
  const shared = home || fullInbox;
  const filter = fullInbox ? inboxFilter(search.tab) : "turn";
  // Queue pages start their arrival read; keep the shared observer live after that answer.
  const inbox = useInfiniteQuery({ ...cursorPages("/api/v1/me/action-inbox", home ? { filter, attention: "all" } : { filter }), enabled: query => !seed && !platform && (!shared || !!query.state.data), staleTime: Infinity, placeholderData: keepPreviousData, notifyOnChangeProps: "all" });
  const separate = fullInbox && filter !== "turn";
  // Other inbox tabs supply counts, but the task panel always reads my turn when opened.
  const tasks = useInfiniteQuery({ ...cursorPages("/api/v1/me/action-inbox", { filter: "turn" }), enabled: !seed && !platform && separate && open, notifyOnChangeProps: "all" });
  if (platform) return null;
  const turn = (seed ?? (inbox.isSuccess ? inbox.data.pages[0] : undefined))?.counts?.turn;
  const count = turn?.total;
  const exact = turn?.total_is_exact;
  const label = count == null ? t(inbox.isPending ? "shell.needsMe.loading" : "shell.needsMe.unknown") : t(count > 0 ? exact ? "shell.needsMe.count" : "shell.needsMe.countMore" : "shell.needsMe", { count });
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button id={id} className={s.needsMe} aria-label={label}><Inbox size={16} aria-hidden /><span className={s.name}>{t("home.inbox.title")}</span>{!!count && <span className={s.badge} data-count>{exact ? count : `${count}+`}</span>}</Button>
      <Popover className={s.taskPop} placement="bottom end">
        <Dialog className={s.taskPanel} aria-label={t("shell.needsMe")}>
          {({ close }) => <Suspense fallback={<ReadSkeleton layout="list" />}><NeedsMePanel seed={seed} inbox={separate ? tasks : inbox} onNavigate={close} /></Suspense>}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
