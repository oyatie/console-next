// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { Banner } from "../../../ui/banner/banner";
import { Card } from "../../../ui/card/card";
import { KeyValue } from "../../../ui/key-value/key-value";

type Notice = { env: string; state: "EXPIRING" | "EXPIRED" | "REJECTED"; expires_on?: string | null; days_left?: number | null };

/** Vendor-only integration notices expose configuration names and state, never configuration values. */
export function KeyNotices({ notices }: { notices: readonly Notice[] }) {
  if (!notices.length) return null;
  return <Card title={t("nts.ops.title")}>
    <KeyValue items={notices.map((notice) => ({
      key: notice.env,
      label: <code>{notice.env}</code>,
      value: <Banner tone={notice.state === "EXPIRING" ? "warn" : "danger"}>
        {t(`nts.ops.${notice.state}`, { env: notice.env })}
        <KeyValue items={[
          ...(notice.expires_on ? [{ key: "expiry", label: t("nts.ops.expiry"), value: fmtDate(notice.expires_on) }] : []),
          ...(notice.days_left != null ? [{ key: "days", label: t("nts.ops.daysLeft"), value: fmtNumber(notice.days_left) }] : []),
        ]} />
      </Banner>,
    }))} />
  </Card>;
}
