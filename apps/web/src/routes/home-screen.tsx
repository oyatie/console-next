import { t } from "@console/i18n";
import { InboxCommand } from "../features/org/ui/inbox-command";
import { AddPasskey } from "../features/onboarding/ui/add-passkey";
import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Home } from "../features/home/Home";
import { SetupHome } from "../features/onboarding/ui/setup-home";
import { useLiveHold } from "../lib/live/hold";
import { cursorPages } from "../lib/query";
import { entitiesRef } from "../reference/entity/api";
import { unitsQuery } from "../reference/org/api";

/** Setup and operating work share the same server queue. */
export function HomeScreen() {
  const inbox = useInfiniteQuery({ ...cursorPages("/api/v1/me/action-inbox", { filter: "turn" }), refetchOnMount: "always" });
  const during = inbox.data?.pages[0]?.setup !== undefined;
  const reads = [useQuery({ ...entitiesRef, enabled: during }), useQuery({ ...unitsQuery, enabled: during })];
  const [settled, setSettled] = useState(false);
  // The setup rail's links and hints arrive in one paint; later live refreshes keep the page visible.
  const ready = inbox.isError || (!inbox.isPending && (!inbox.isFetching || inbox.isFetchedAfterMount) && (!during || reads.some((q) => q.isError) || reads.every((q) => q.isSuccess && !q.isFetching)));
  const pending = !settled && !ready;
  if (!pending && !settled) setSettled(true);
  useLiveHold(pending);
  return <Home setup={(c) => <SetupHome c={c} />} setupPending={pending} action={(item) => {
    const link = item.links[0];
    if (link?.kind === "account") return <AddPasskey count={1} primary label={t("account.second.add")} focusAfter="inbox-title" />;
    if (link?.kind === "org_change" && item.context?.command) return <InboxCommand id={link.id} command={item.context.command} />;
    return null;
  }} />;
}
