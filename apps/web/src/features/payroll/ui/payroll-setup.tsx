// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { Page } from "../../../ui/page/page";
import { Card } from "../../../ui/card/card";
import { Button } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { payGroupsQuery } from "../api";
import { PayGroupSheet } from "./pay-group-sheet";

export function PayrollSetup() {
  const groups = useQuery(payGroupsQuery);
  const [open, setOpen] = useState(false);
  return <Page floorplan="form" head={{ title: t("payroll.setup.page"), tools: <Link to="/payroll">{t("payroll.title")}</Link> }}>
    <QueryState q={groups} layout="list">{data => data.legal_entities.length ? <>
      <Card title={t("payroll.setup.group")} meta={t("payroll.setup.groupCount", { count: data.items.length })}>
        <Button variant="primary" onClick={() => setOpen(true)}>{t("payroll.setup.add")}</Button>
      </Card>
      {open && <PayGroupSheet entities={data.legal_entities} onClose={() => setOpen(false)} onSaved={() => setOpen(false)} />}
    </> : <EmptyState title={t("payroll.setup.noEntities")} reason={t("payroll.setup.entityDetail")} />}</QueryState>
  </Page>;
}
