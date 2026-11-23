// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { RegisterBlockerItem } from "../../../ui/patterns/register-totals-parts";

export function RunOpenExceptionsBlocker({
  exceptionsOpen,
  onInspectExceptions,
}: {
  exceptionsOpen: number;
  onInspectExceptions: () => void;
}) {
  return (
    <RegisterBlockerItem
      badge={<Chip tone="warn">{t("payroll.run.attentionChip", { count: exceptionsOpen })}</Chip>}
      note={t("payrollRun.blocked.exceptionsOpen", { count: exceptionsOpen })}
      action={
        <Button size="sm" onClick={onInspectExceptions}>
          {t("payrollRun.tool.exceptions")}
        </Button>
      }
    />
  );
}
