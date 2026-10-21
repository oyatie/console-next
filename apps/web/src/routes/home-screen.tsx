import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLiveHold } from "../lib/live/hold";
import { claims, meQuery, passkeysQuery } from "../features/account/api";
import { SecondPasskeyCard } from "../features/account/ui/second-passkey";
import { Home } from "../features/home/Home";
import { entitiesRef } from "../reference/entity/api";
import { unitsQuery } from "../reference/org/api";
import { SetupHome } from "../features/onboarding/ui/setup-home";
import { useSetupChecklist } from "../features/onboarding/ui/use-setup";

/**
 * Home composed with the setup checklist: during setup the server's rail leads; afterwards Home is the queue.
 * A server without the setup phase keeps Home's own getting-started card.
 */
export function HomeScreen() {
  // A dashboard: another session's change waits behind the held notice instead of moving rows (decision #27).
  useLiveHold(true, true);
  const s = useSetupChecklist();
  // The rail's workplace links wait for a fresh entity read; Home holds its loading line until then, so they never
  // appear under a pointer already on the page.
  // Only the read made on arrival counts: a later background refetch never hides Home again.
  const during = s.checklist !== undefined;
  const reads = [useQuery({ ...entitiesRef, enabled: during }), useQuery({ ...unitsQuery, enabled: during })];
  const [settled, setSettled] = useState(false);
  if (during && reads.every((q) => q.isSuccess && !q.isFetching) && !settled) setSettled(true);
  // After setup the second-passkey prompt (governance-20) is drawn with Home's first paint, never pushed in after it:
  // Home holds until both reads the prompt is drawn from (the passkeys, and the account for a tenant user) are in.
  const vendor = Boolean(claims()?.platform);
  const keys = useQuery({ ...passkeysQuery, enabled: s.loaded && !during });
  const me = useQuery({ ...meQuery, enabled: s.loaded && !during && !vendor });
  const pending = !s.loaded || (during && !settled && !reads.some((q) => q.isError)) || (!during && (keys.isPending || (!vendor && me.isPending)));
  return (
    <Home
      setup={s.checklist ? <SetupHome c={s.checklist} /> : s.served ? null : undefined}
      setupPending={pending}
      account={during ? undefined : <SecondPasskeyCard focusAfter="home-title" />}
    />
  );
}
