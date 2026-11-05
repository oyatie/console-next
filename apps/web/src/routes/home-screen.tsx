import { inboxAction } from "./inbox-action";
import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Home } from "../features/home/Home";
import { SetupHome } from "../features/onboarding/ui/setup-home";
import { useSetupChecklist } from "../features/onboarding/ui/use-setup";
import { myAccessQuery } from "../reference/authz/api";
import { settingsQuery } from "../reference/settings/api";
import { ReadSkeleton } from "../ui/skeleton/skeleton";
import { SetupReceipt } from "../features/onboarding/ui/setup-receipt";
import { useLiveHold } from "../lib/live/hold";
import { cursorPages } from "../lib/query";
import { entitiesRef } from "../reference/entity/api";
import { unitsQuery } from "../reference/org/api";
import { readRequirement } from "./route-reads";

const RECEIPT_NEED = readRequirement("/setup/go-live");
const HISTORY_NEED = readRequirement("/org/history");

/** Setup and operating work share the same server queue. */
export function HomeScreen() {
  const inbox = useInfiniteQuery({ ...cursorPages("/api/v1/me/action-inbox", { filter: "turn", attention: "all" }), refetchOnMount: "always" });
  const { phaseQ } = useSetupChecklist();
  const phaseReads = [phaseQ, useQuery(myAccessQuery), useQuery(settingsQuery)];
  const during = inbox.data?.pages[0]?.setup !== undefined;
  const reads = [useQuery({ ...entitiesRef, enabled: during }), useQuery({ ...unitsQuery, enabled: during })];
  const [settled, setSettled] = useState(false);
  // Receipt, phase band and setup links arrive with the inbox; later refreshes keep Home visible.
  const ready = phaseReads.every(q => !q.isPending && !q.isFetching) && (inbox.isError || (!inbox.isPending && (!inbox.isFetching || inbox.isFetchedAfterMount) && (!during || reads.some((q) => q.isError) || reads.every((q) => q.isSuccess && !q.isFetching))));
  const pending = !settled && !ready;
  if (!pending && !settled) setSettled(true);
  useLiveHold(!pending && !!inbox.data?.pages.some((page) => page.items.length > 0), true);
  if (pending) return <ReadSkeleton layout="list" />;
  return <Home setup={(c) => <SetupHome c={c} />} receipt={!during ? <SetupReceipt receiptNeed={RECEIPT_NEED} historyNeed={HISTORY_NEED} /> : undefined} action={inboxAction} />;
}
