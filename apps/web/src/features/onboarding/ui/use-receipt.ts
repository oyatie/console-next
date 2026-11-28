// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isAnswer } from "../../../lib/react/query-defaults";
import { myAccessQuery } from "../../../reference/authz/api";
import { accessRefusal, type AccessRequirement } from "../../../reference/authz/domain/access";
import { settingsQuery } from "../../../reference/settings/api";
import { goLiveReceiptQuery } from "../api";
import { phaseBand, receiptDuration } from "../domain/phase";
import { useSetupChecklist } from "./use-setup";

export type Receipt = ReturnType<typeof useReceipt>;

/**
 * The go-live receipt as Home shows it: its window (the server's `onboarding.receipt_days` from go-live), which links
 * the viewer may open, and the receipt record. `arriving` while the record the window calls for has no first answer:
 * Home holds its arrival on it, since the card grows above the queue when it lands. Home reads it once and hands it to
 * `SetupReceipt`.
 */
export function useReceipt(receiptNeed: AccessRequirement, historyNeed: AccessRequirement) {
  const { phaseQ: q } = useSetupChecklist();
  const access = useQuery(myAccessQuery);
  const settings = useQuery(settingsQuery);
  const duration = receiptDuration(settings.data?.items);
  const [now, setNow] = useState(Date.now);
  const data = q.isError && isAnswer(q.error) ? undefined : q.data;
  const band = access.data ? phaseBand(access.data.phase, data?.go_live_at, Math.max(now, q.dataUpdatedAt), duration) : null;
  useEffect(() => {
    if (band !== "started" || !data?.go_live_at) return;
    const remaining = Date.parse(data.go_live_at) + duration - Math.max(now, Date.now());
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(2147483647, Math.max(0, remaining)));
    return () => window.clearTimeout(timer);
  }, [band, data?.go_live_at, duration, now]);
  const canOpenReceipt = !!access.data && accessRefusal(access.data, receiptNeed) === null;
  const canOpenHistory = !!access.data && accessRefusal(access.data, historyNeed) === null;
  const receipt = useQuery({ ...goLiveReceiptQuery, enabled: band === "started" && canOpenReceipt });
  // Home can outlast the shared phase band's brief hold. Wait for the first
  // operating-phase checklist to determine whether its receipt will sit above the inbox.
  const phaseArriving = (access.isPending && access.failureCount === 0)
    || (access.data?.phase === "OPERATING" && q.isPending && q.failureCount === 0);
  const arriving = phaseArriving || (receipt.isFetching && receipt.data === undefined && receipt.failureCount === 0);
  return { band, data, access: access.data, canOpenReceipt, canOpenHistory, receipt, arriving };
}
