import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { StatRow } from "../../../ui/key-value/key-value";
import { Table } from "../../../ui/table";
import type { AccessGrantPreview, Account } from "../api";
import { accountLabel, enforcementText, refusalText } from "../present";
import s from "./access.module.css";

/**
 * What an accepted row will do once applied — said before commit as "can be granted" (critique L-2), never a past-tense
 * "granted": from go-live, now, or the state the server named.
 */
const okText = (e: string | null) =>
  [t("accessGrants.bulk.ok"), e === "PREPARED" ? t("access.period.golive") : e === "ENFORCED" ? t("access.period.now") : e ? enforcementText(e) : ""].filter(Boolean).join(" · ");

/**
 * The server's receipt for a bulk grant (mockup M5): the totals, then one row per person with what happens or why it is
 * refused. The batch applies all or none, so a refused row is dropped (and the rest previewed again) before the passkey.
 */
export function BulkPreview({ preview, accounts, role, scope, end, pending, error, onBack, onDropRefused, onApply }: {
  preview: AccessGrantPreview;
  accounts: readonly Account[];
  role: string;
  scope: string;
  end: string;
  pending: boolean;
  error: ReactNode;
  onBack: () => void;
  onDropRefused: () => void;
  onApply: () => void;
}) {
  const ok = preview.items.length - preview.refused;
  const who = (id: string) => accounts.find((a) => a.id === id);
  const noKey = preview.items.filter((i) => i.outcome === "OK" && who(i.account_id)?.has_passkey === false).map((i) => accountLabel(who(i.account_id), i.account_id));
  const from = preview.items.some((i) => i.enforcement_after === "SCHEDULED") ? enforcementText("SCHEDULED") : preview.items.some((i) => i.enforcement_after === "PREPARED") ? t("access.period.golive") : t("access.period.now");
  const stats = [
    [t("access.bulk.stat.ok"), t("access.count", { count: ok })],
    [t("access.bulk.stat.skipped"), t("access.count", { count: preview.refused })],
    [t("access.col.role"), role],
    [t("access.col.until"), t("access.period", { from, to: end })],
  ] as const;
  return (
    <Card label={t("access.bulk.preview.title")} flush>
      <div className={s.pad}>
        <StatRow items={stats.map(([k, v]) => ({ key: k, label: k, value: v }))} />
      </div>
      <Table
        label={t("access.bulk.preview.title")}
        rows={preview.items}
        rowId={(i) => String(i.index)}
        columns={[
          { header: t("access.col.person"), cell: (i) => accountLabel(who(i.account_id), i.account_id) },
          { header: t("access.col.number"), fit: true, cell: (i) => who(i.account_id)?.employee_number ?? "" },
          { header: t("access.col.scope"), cell: () => scope },
          {
            header: t("access.col.result"),
            cell: (i) =>
              i.outcome !== "OK" ? <Chip tone="danger">{refusalText(i.refusal)}</Chip>
              : who(i.account_id)?.has_passkey === false ? <span className={s.chips}><Chip tone="ok">{okText(i.enforcement_after)}</Chip><Chip tone="warn">{t("accessGrants.bulk.noPasskey")}</Chip></span>
              : <Chip tone="ok">{okText(i.enforcement_after)}</Chip>,
          },
        ]}
      />
      <div className={s.pad}>
        <ActionBar
          notice={error}
          consequence={
            <>
              <strong>{preview.refused ? t("access.bulk.refused", { count: preview.refused }) : t("access.bulk.summary", { count: ok, role, scope })}</strong>
              <span className="muted">{t(preview.refused ? "access.bulk.refused.how" : preview.phase === "SETUP" ? "access.bulk.setup" : "access.bulk.live")}</span>
              {/* governance-32: who cannot sign in to use it yet, named before the passkey. */}
              {noKey.length > 0 && <span className="muted">{t("accessGrants.bulk.noPasskey.line", { count: noKey.length, names: noKey.join(", ") })}</span>}
            </>
          }
          actions={
            <>
              <Button variant="ghost" onClick={onBack}>{t("access.bulk.back")}</Button>
              {preview.refused > 0 ? (
                ok > 0 && <Button disabled={pending} onClick={onDropRefused}>{t("access.bulk.drop", { count: preview.refused })}</Button>
              ) : (
                <Button variant="primary" disabled={pending} onClick={onApply}>{t("access.bulk.apply", { count: ok })}</Button>
              )}
            </>
          }
        />
      </div>
    </Card>
  );
}
