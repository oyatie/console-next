// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { isAnswer } from "../../../lib/react/query-defaults";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import type { Receipt } from "./use-receipt";
import s from "./go-live.module.css";

/**
 * Post-go-live receipt link on Home (ideal-v2 §1, §4): replaces the setup tracker within the receipt window and links
 * permitted viewers to the receipt and setup history.
 */
export function SetupReceipt({ r }: { r: Receipt }) {
  const { band, data, access, canOpenReceipt, canOpenHistory, receipt } = r;
  if (band !== "started" || !data?.go_live_at || !access) return null;
  if (!canOpenReceipt && !canOpenHistory) return null;
  const record = !canOpenReceipt || receipt.isError && isAnswer(receipt.error) ? undefined : receipt.data;
  const counts = record?.facts_snapshot_version === 1 ? record.facts_snapshot : null;
  const register = counts?.employees === 0 && data.steps.some(step => step.key === "employees" && step.can_act);
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
            {register && <><Link to="/people/new" search={{}} className={buttonClass("primary")}>{t("setup.action.employees")}</Link>
              <Link to="/people/import" className={buttonClass()}>{t("setup.action.import")}</Link></>}
            {canOpenReceipt && <Link to="/setup/go-live" className={buttonClass()}>{t("setup.receipt.open")}</Link>}
            {canOpenHistory && <Link to="/org/history" className={buttonClass("ghost")}>{t("setup.bulk.history")}</Link>}
          </div>
        </div>
      </Card>
    </div>
  );
}
