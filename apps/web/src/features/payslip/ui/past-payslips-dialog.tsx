// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtMonth, fmtNumber } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { EmptyState } from "../../../ui/empty-state";
import type { InboxDocSummary } from "../api";
import { formatShortMonthDay, payslipMonth } from "../domain/payslip";
import s from "./payslip-page.module.css";

/** Modal picker for previously issued employee payslips. */
export function PastPayslipsDialog({
  open,
  items,
  activeId,
  onSelect,
  onClose,
}: {
  open: boolean;
  items: readonly InboxDocSummary[];
  activeId: string | null;
  onSelect: (item: InboxDocSummary) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} title={t("payslip.past.title")} onClose={onClose} size="sm">
      {items.length === 0 ? (
        <EmptyState title={t("payslip.past.empty")} reason={null} />
      ) : (
        <div className={s.historyList}>
          <ul className="list-divided">
            {items.map(item => {
              const month = payslipMonth(item);
              const payDate = formatShortMonthDay(item.payslip_meta?.pay_date);
              const netWon = item.payslip_meta?.net_won;
              return (
                <li key={item.id}>
                  <Button
                    variant="ghost"
                    block
                    aria-current={item.id === activeId ? "true" : undefined}
                    onClick={() => onSelect(item)}
                  >
                    <div className={s.historyRow}>
                      <div className={s.historyMeta}>
                        <bdi className="t-strong t-ink">{month ? fmtMonth(month) : item.title}</bdi>
                        {payDate ? (
                          <bdi className="t-xs muted num">{t("payslip.past.payDate", { date: payDate })}</bdi>
                        ) : null}
                      </div>
                      {netWon != null ? (
                        <bdi className="t-strong t-ink num">
                          {t("payslip.netAmount", { amount: fmtNumber(netWon) })}
                        </bdi>
                      ) : null}
                    </div>
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="form__actions">
        <Button variant="secondary" onClick={onClose}>
          {t("payslip.past.close")}
        </Button>
      </div>
    </Dialog>
  );
}
