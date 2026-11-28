// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { Inbox } from "lucide-react";
import { session } from "@console/api";
import { t } from "@console/i18n";
import { cursorPages } from "../../lib/query";
import { inboxReadFilter, inboxView } from "../../features/home/domain/inbox-filter";
import { chunk } from "../../lib/chunk-guard";
import { ReadSkeleton } from "../../ui/skeleton/skeleton";
import { countRead, useCountAfterArrival, useNewestPage, type InboxPage } from "./inbox-count";
import s from "./top-bar.module.css";

const NeedsMePanel = lazy(() => chunk(import("./needs-me-panel")).then(m => ({ default: m.NeedsMePanel })));

/** Header 'needs me' badge and popover task panel driven by `/api/v1/me/action-inbox` (`filter: "turn"`). */
export function NeedsMeMenu({ id, seed }: { id: string; seed?: InboxPage }) {
  const claims = useSyncExternalStore(session.subscribe, () => session.claims);
  const platform = !seed && !!claims?.platform;
  const { pathname, search, state } = useLocation();
  const [open, setOpen] = useState(false);
  const home = pathname === "/";
  const fullInbox = pathname === "/inbox";
  const shared = home || fullInbox;
  const backgroundReady = useCountAfterArrival(!seed && !platform && !shared, state.__TSR_key);
  const filter = fullInbox ? inboxReadFilter(inboxView(search.tab)) : "turn";
  // Queue pages start their arrival read; keep the shared observer live after that answer.
  const inbox = useInfiniteQuery({ ...(shared ? cursorPages("/api/v1/me/action-inbox", home ? { filter, attention: "all" } : { filter }) : countRead), enabled: query => !seed && !platform && (shared ? !!query.state.data : open || backgroundReady), staleTime: Infinity, placeholderData: keepPreviousData, notifyOnChangeProps: "all" });
  const separate = fullInbox && filter !== "turn";
  // Other inbox tabs supply counts, but the task panel always reads my turn when opened.
  const tasks = useInfiniteQuery({ ...cursorPages("/api/v1/me/action-inbox", { filter: "turn" }), enabled: !seed && !platform && separate && open, notifyOnChangeProps: "all" });
  const page = useNewestPage(inbox);
  if (platform) return null;
  const turn = (seed ?? page)?.counts?.turn;
  const count = turn?.total;
  const exact = turn?.total_is_exact;
  const label = count == null ? t(inbox.isPending ? "shell.needsMe.loading" : "shell.needsMe.unknown") : t(count > 0 ? exact ? "shell.needsMe.count" : "shell.needsMe.countMore" : "home.inbox.title", { count });
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button id={id} className={s.needsMe} aria-label={label} aria-describedby={count ? `${id}-description` : undefined}>
        <Inbox size={16} aria-hidden />
        <span className={s.name}>{t("home.inbox.title")}</span>{" "}
        <span className={s.badge} data-count={count ? "" : undefined} aria-hidden>
          {count ? (exact ? count : `${count}+`) : null}
        </span>
      </Button>
      {!!count && <span id={`${id}-description`} className="sr-only">{t(exact ? "shell.needsMe.countDescription" : "shell.needsMe.countMoreDescription", { count })}</span>}
      <Popover className={s.taskPop} placement="bottom end">
        <Dialog className={s.taskPanel} aria-label={t("shell.needsMe")}>
          {({ close }) => <Suspense fallback={<ReadSkeleton layout="list" />}><NeedsMePanel seed={seed} inbox={separate ? tasks : inbox} onNavigate={close} /></Suspense>}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
