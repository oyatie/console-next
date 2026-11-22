// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { PrivacyRightsReceipt } from "@console/api/pending";
import { t } from "@console/i18n";
import { get } from "../../../lib/query";
import { ReadReference } from "../../../lib/react/read-reference";
import { Button } from "../../../ui/button/button-base";
import { Card } from "../../../ui/card/card";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Page } from "../../../ui/page/page";
import { RecordPattern } from "../../../ui/patterns/record";
import { SettingsPattern } from "../../../ui/patterns/settings";
import { ApiError, privacyReceipt, privacyRequestPages } from "../api";
import { PrivacyConsolePanel, PrivacySummary } from "./privacy-console-panel";
import { PrivacyReceipt } from "./privacy-receipt";
import { PrivacyRequest } from "./privacy-request";
import { PrivacyRequestsView } from "./privacy-requests";
import s from "./account.module.css";

const PRIVACY_VIEWS = [
  { id: "privacy-rights", labelKey: "account.privacy.nav.rights" },
  { id: "privacy-access-log", labelKey: "account.privacy.nav.accessLog" },
  { id: "privacy-consent", labelKey: "account.privacy.nav.consent" },
  { id: "privacy-retention", labelKey: "account.privacy.nav.retention" },
] as const;

type PrivacyViewId = (typeof PRIVACY_VIEWS)[number]["id"];

export function PrivacyIntake() {
  const { id } = useParams({ from: "/app/account/privacy/intake/$id" });
  const q = useQuery(get("/api/v1/privacy/rights-requests/{id}", { params: { path: { id } } }));
  const head = { title: t("account.privacy.intake") };
  const receipt = q.data ? <PrivacyReceipt request={privacyReceipt(q.data.request, q.data.as_of)} /> : null;
  const subjectStrip = q.data
    ? <KeyValue readOnly items={[{ key: "subject", label: t("account.privacy.subject"), value: q.data.subject_name }]} />
    : undefined;

  return (
    <RecordPattern
      q={q}
      head={{ ...head, meta: q.data?.request.receipt_no }}
      strip={subjectStrip}
      sections={
        <Card title={t("account.privacy.intake")}>
          {receipt}
        </Card>
      }
      baseline={() => (
        <Page floorplan="P-01" head={head} q={q} layout="record">
          {() => (
            <>
              {subjectStrip}
              {receipt}
            </>
          )}
        </Page>
      )}
    />
  );
}

export function PrivacyRequests() {
  const q = useInfiniteQuery(privacyRequestPages);
  const [filed, setFiled] = useState<PrivacyRightsReceipt>();
  const [selectedId, select] = useState<string | undefined>();
  const [seen, setSeen] = useState(filed);
  const [activeView, setActiveView] = useState<PrivacyViewId>("privacy-rights");
  if (filed !== seen) {
    setSeen(filed);
    select(filed?.id);
  }
  const head = { title: t("account.privacy.title") };

  if (q.error instanceof ApiError && q.error.status === 403) {
    const refused = (
      <EmptyState
        alert
        title={t("account.privacy.refused.title")}
        reason={t("account.privacy.refused")}
        actions={<Button onClick={() => void q.refetch()}>{t("common.retry")}</Button>}
        meta={<ReadReference error={q.error} />}
      />
    );
    return (
      <SettingsPattern
        q={{ isPending: false, error: null, data: true, refetch: () => q.refetch() }}
        head={head}
        panel={refused}
        baseline={() => <Page floorplan="P-01" head={head}>{refused}</Page>}
      />
    );
  }

  const items = q.data?.pages.flatMap(page => page.items) ?? [];
  const selected = items.find(item => item.id === selectedId) ?? (filed?.id === selectedId ? filed : undefined);
  const filingSection = <PrivacyRequest onFiled={setFiled} />;
  const loadMoreRequests = q.hasNextPage ? (
    <div className={s.pad}>
      <Button disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
        {t("account.privacy.more")}
      </Button>
    </div>
  ) : null;

  return (
    <SettingsPattern
      q={q}
      head={head}
      summary={<PrivacySummary items={items} />}
      views={
        <nav className={s.viewsNav} aria-label={t("account.privacy.title")}>
          {PRIVACY_VIEWS.map(view => (
            <Button
              key={view.id}
              type="button"
              variant={activeView === view.id ? "secondary" : "ghost"}
              aria-current={activeView === view.id ? "true" : undefined}
              onClick={() => {
                setActiveView(view.id);
                document.getElementById(view.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              {t(view.labelKey)}
            </Button>
          ))}
        </nav>
      }
      panel={
        <PrivacyConsolePanel
          items={items}
          selectedId={selected?.id}
          onSelect={select}
          filingSection={filingSection}
          loadMoreRequests={loadMoreRequests}
        />
      }
      record={
        selected
          ? {
              id: selected.id,
              label: selected.receipt_no,
              title: selected.receipt_no,
              meta: selected.controller_label,
              onClose: () => select(undefined),
              returnFocus: () =>
                document.querySelector<HTMLElement>(
                  `[data-id="${CSS.escape(selected.id)}"], [data-row-id="${CSS.escape(selected.id)}"]`,
                ),
              children: <PrivacyReceipt request={selected} />,
            }
          : null
      }
      baseline={() => (
        <Page floorplan="P-01" head={head} q={q} layout="list">
          {data => (
            <>
              {filingSection}
              <PrivacyRequestsView filed={filed} items={data.pages.flatMap(page => page.items)} />
              {loadMoreRequests}
            </>
          )}
        </Page>
      )}
    />
  );
}
