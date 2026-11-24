import {
  consoleInlineRowAction,
  consoleRecordBody,
  consoleRecordFooter,
  inboxAction,
} from "./inbox-action";
import { useContext, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Home } from "../features/home/Home";
import { SetupHome } from "../features/onboarding/ui/setup-home";
import { PagePhase } from "../ui/page/page-scope";
import { ReadSkeleton } from "../ui/skeleton/skeleton";
import { SetupReceipt } from "../features/onboarding/ui/setup-receipt";
import { useReceipt } from "../features/onboarding/ui/use-receipt";
import { useLiveHold } from "../lib/live/hold";
import { InboxRead } from "../features/home/ui/inbox-read";
import { useInboxRead } from "../features/home/ui/use-inbox-read";
import { entitiesRef } from "../reference/entity/api";
import { unitsQuery } from "../reference/org/api";
import { readRequirement } from "./route-reads";

const RECEIPT_NEED = readRequirement("/setup/go-live");
const HISTORY_NEED = readRequirement("/org/history");
const ORG_NEED = readRequirement("/org");

/** Setup and operating work share the same server queue. */
export function HomeScreen() {
  return <InboxRead preview><HomeContent /></InboxRead>;
}

function HomeContent() {
  const { inbox } = useInboxRead();
  const phase = useContext(PagePhase);
  const during = inbox.data?.pages[0]?.setup !== undefined;
  const reads = [useQuery({ ...entitiesRef, enabled: during }), useQuery({ ...unitsQuery, enabled: during })];
  const receipt = useReceipt(RECEIPT_NEED, HISTORY_NEED);
  const [settled, setSettled] = useState(false);
  // Receipt (with its record), phase band and setup links arrive with the inbox; later refreshes keep Home visible.
  const ready = inbox.isError || (!inbox.isPending && (!inbox.isFetching || inbox.isFetchedAfterMount) && !receipt.arriving && (!during || reads.some((q) => q.isError) || reads.every((q) => q.isSuccess && !q.isFetching)));
  const pending = !settled && !ready;
  // Under the phase band's hold Home lays out unseen; it latches its arrival only once the band decides, so a receipt
  // record that the decided phase calls for is still waited on before Home shows.
  if (!pending && !settled && phase.settled) setSettled(true);
  useLiveHold(phase.settled && !pending && !!inbox.data?.pages.some((page) => page.items.length > 0), true);
  if (pending) return <ReadSkeleton layout="list" />;
  return (
    <Home
      setup={(c) => <SetupHome c={c} />}
      receipt={!during ? <SetupReceipt r={receipt} /> : undefined}
      action={inboxAction}
      inlineRowAction={consoleInlineRowAction}
      recordBody={consoleRecordBody}
      recordFooter={consoleRecordFooter}
      orgNeed={ORG_NEED}
    />
  );
}
