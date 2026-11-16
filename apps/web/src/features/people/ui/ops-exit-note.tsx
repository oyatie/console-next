// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { Banner } from "../../../ui/banner/banner";
import { directorySearch } from "./use-linked-account";

/**
 * The ops account's banner on this employee's exit (governance-03): the same lookup as the card below. There is no
 * ops handover yet, so the exit is not blocked; the sheet says the account stays and where its link is changed.
 */
export function OpsExitNote({ employeeId, search }: { employeeId: string; search: string }) {
  const q = useQuery(directorySearch(search, true));
  if (!q.data?.items.some((p) => p.employee_id === employeeId && p.is_tenant_ops)) return null;
  return <Banner tone="warn">{t("accounts.ops.exitNote")}</Banner>;
}
