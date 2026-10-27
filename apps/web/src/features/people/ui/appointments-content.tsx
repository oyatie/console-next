// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { Receipt } from "../../../ui/receipt/receipt";
import { Button } from "../../../ui/button/button";
import { BulkPage } from "./bulk-page";
import { BulkSheet } from "./bulk-sheet";
import { NoticeListPage } from "./notice-list-page";

const route = getRouteApi("/app/people");

/** Host the existing governed appointment flow and its notices. */
export function AppointmentsContent() {
  const { bulk } = route.useSearch();
  const { peopleAccess } = route.useRouteContext();
  const navigate = route.useNavigate();
  const [receipt, setReceipt] = useState<string>();
  const close = () => void navigate({ search: previous => ({ ...previous, bulk: undefined }), replace: true });
  return <>
    <AccessGate {...peopleAccess.appointments}>
      <Button onClick={() => void navigate({ search: previous => ({ ...previous, bulk: "paste" }) })}>{t("bulk.openPaste")}</Button>
      {receipt && <Receipt state="recorded" message={receipt} />}
      <BulkPage />
      {bulk === "paste" && <BulkSheet source={{ paste: "" }} onClose={close} onDone={message => { setReceipt(message); close(); }} />}
    </AccessGate>
    <AccessGate {...peopleAccess.notices} layout="list"><NoticeListPage /></AccessGate>
  </>;
}
