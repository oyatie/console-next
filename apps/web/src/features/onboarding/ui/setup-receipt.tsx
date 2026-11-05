// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { isAnswer } from "../../../lib/react/query-defaults";
import { myAccessQuery } from "../../../reference/authz/api";
import { accessRefusal, type AccessRequirement } from "../../../reference/authz/domain/access";
import { settingsQuery } from "../../../reference/settings/api";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { goLiveReceiptQuery } from "../api";
import { phaseBand, receiptDuration } from "../domain/phase";
import { useSetupChecklist } from "./use-setup";
import s from "./go-live.module.css";

/**
 * Post-go-live receipt link on Home (ideal-v2 §1, §4): replaces the setup tracker within the server's
 * configured `onboarding.receipt_days` window and links permitted viewers to the receipt and setup history.
 */
export function SetupReceipt({ receiptNeed, historyNeed }: { receiptNeed: AccessRequirement; historyNeed: AccessRequirement }) {
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
  if (band !== "started" || !data?.go_live_at || !access.data) return null;
  if (!canOpenReceipt && !canOpenHistory) return null;
  const record = receipt.isError && isAnswer(receipt.error) ? undefined : receipt.data;
  const counts = record?.facts_snapshot_version === 1 ? record.facts_snapshot : null;
  const summary = counts
    ? `${t("setup.golive.details.legal_entity")} ${fmtNumber(counts.entities)} · ${t("setup.golive.details.workplace")} ${fmtNumber(counts.workplaces)} · ${t("setup.golive.details.units")} ${fmtNumber(counts.org_units)} · ${t("setup.stats.people")} ${fmtNumber(counts.employees)}`
    : null;
  return (
    <div data-setup-receipt>
      <Card look="outline" density="dense">
        <div className={s.homeReceipt}>
          <div className={s.homeReceiptMeta}>
            <time dateTime={record?.go_live_at ?? data.go_live_at}>{t("setup.receipt.startedAt")} · {fmtDateTime(record?.go_live_at ?? data.go_live_at)}</time>
            {record?.facts_snapshot === null && <small>{t("setup.receipt.unrecorded")}</small>}
            {summary && <small>{t("setup.receipt.recorded")} · {summary}</small>}
          </div>
          <div className={s.homeReceiptActions}>
            {canOpenReceipt && <Link to="/setup/go-live" className={buttonClass()}>{t("setup.receipt.open")}</Link>}
            {canOpenHistory && <Link to="/org/history" className={buttonClass("ghost")}>{t("setup.bulk.history")}</Link>}
          </div>
        </div>
      </Card>
    </div>
  );
}
