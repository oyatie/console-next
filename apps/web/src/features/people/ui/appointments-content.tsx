// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import type { ReadState } from "../../../lib/react/query-view";
import { myAccessQuery } from "../../../reference/authz/api";
import { accessRefusal } from "../../../reference/authz/domain/access";
import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { Receipt } from "../../../ui/receipt/receipt";
import { Button } from "../../../ui/button/button";
import { ListRecord } from "../../../ui/patterns/list-record";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { BulkPage } from "./bulk-page";
import { BulkSheet } from "./bulk-sheet";
import { NoticeListPage } from "./notice-list-page";
import s from "./appointments-content.module.css";

const route = getRouteApi("/app/people");
const READY_Q: ReadState = { isPending: false, error: null, data: { ready: true }, refetch: () => {} };

/** Host the existing governed appointment flow and its notices. */
export function AppointmentsContent({ tabs }: { tabs?: ReactNode } = {}) {
  const { bulk } = route.useSearch();
  const { peopleAccess } = route.useRouteContext();
  const navigate = route.useNavigate();
  const access = useQuery(myAccessQuery);
  const [receipt, setReceipt] = useState<string>();
  const close = () => void navigate({ search: previous => ({ ...previous, bulk: undefined }), replace: true });
  const appointmentsAllowed = Boolean(access.data && accessRefusal(access.data, peopleAccess.appointments) === null);

  const renderBaseline = () => (
    <>
      <div className={s.workspace}>
        <AccessGate {...peopleAccess.appointments}>
          <Button onClick={() => void navigate({ search: previous => ({ ...previous, bulk: "paste" }) })}>{t("bulk.openPaste")}</Button>
          {receipt && <Receipt state="recorded" message={receipt} />}
          <BulkPage />
          {bulk === "paste" && <BulkSheet source={{ paste: "" }} onClose={close} onDone={message => { setReceipt(message); close(); }} />}
        </AccessGate>
      </div>
      <AccessGate {...peopleAccess.notices} layout="list"><NoticeListPage /></AccessGate>
    </>
  );

  return (
    <ExperienceSwitch baseline={renderBaseline}>
      {() => (
        <ListRecord
          tabs={tabs}
          q={READY_Q}
          head={{
            title: t("roster.page.appointments"),
            primary: appointmentsAllowed
              ? { id: "paste", label: t("bulk.openPaste"), onAction: () => void navigate({ search: previous => ({ ...previous, bulk: "paste" }) }) }
              : undefined,
          }}
          notes={
            <AccessGate {...peopleAccess.appointments}>
              {receipt && <Receipt state="recorded" message={receipt} />}
              <BulkPage embedded />
              {bulk === "paste" && <BulkSheet source={{ paste: "" }} onClose={close} onDone={message => { setReceipt(message); close(); }} />}
            </AccessGate>
          }
          list={<AccessGate {...peopleAccess.notices} layout="list"><NoticeListPage embedded /></AccessGate>}
          statusSegments={[{ id: "scope", tone: "strong", content: t("roster.page.appointments") }]}
        />
      )}
    </ExperienceSwitch>
  );
}
