import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { PrivacyRightsReceipt } from "@console/api/pending";
import { t } from "@console/i18n";
import { ReadReference } from "../../lib/react/read-reference";
import { get } from "../../lib/query";
import { Page } from "../../ui/page/page";
import { KeyValue } from "../../ui/key-value/key-value";
import { Button } from "../../ui/button/button";
import { EmptyState } from "../../ui/empty-state";
import { ApiError, privacyReceipt, privacyRequestPages } from "./api";
import { PrivacyReceipt } from "./ui/privacy-receipt";
import { PrivacyRequest } from "./ui/privacy-request";
import { PrivacyRequestsView } from "./ui/privacy-requests";
import s from "./ui/account.module.css";
import { LocaleSelect } from "../../shell/shell";
import { MePage } from "./ui/me-page";

/** Route entry for /account: the shell's language control goes in as a prop, so ui/ never imports the shell. */
export function Account() {
  return <MePage locale={<LocaleSelect id="acct-locale" />} />;
}

export function PrivacyIntake() {
  const { id } = useParams({ from: "/app/account/privacy/intake/$id" });
  const q = useQuery(get("/api/v1/privacy/rights-requests/{id}", { params: { path: { id } } }));
  return <Page floorplan="P-01" head={{ title: t("account.privacy.intake") }} q={q} layout="record">
    {data => <>
      <KeyValue readOnly items={[{ key: "subject", label: t("account.privacy.subject"), value: data.subject_name }]} />
      <PrivacyReceipt request={privacyReceipt(data.request, data.as_of)} />
    </>}
  </Page>;
}

export function PrivacyRequests() {
  const q = useInfiniteQuery(privacyRequestPages);
  const [filed, setFiled] = useState<PrivacyRightsReceipt>();
  const head = { title: t("account.privacy.title") };
  if (q.error instanceof ApiError && q.error.status === 403) return <Page floorplan="P-01" head={head}>
    <EmptyState alert title={t("account.privacy.refused.title")} reason={t("account.privacy.refused")}
      actions={<Button onClick={() => void q.refetch()}>{t("common.retry")}</Button>} meta={<ReadReference error={q.error} />} />
  </Page>;
  return <Page floorplan="P-01" head={head} q={q} layout="list">
    {data => <>
      <PrivacyRequest onFiled={setFiled} />
      <PrivacyRequestsView filed={filed} items={data.pages.flatMap(page => page.items)} />
      {q.hasNextPage && <div className={s.pad}><Button disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t("account.privacy.more")}</Button></div>}
    </>}
  </Page>;
}
