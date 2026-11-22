// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useParams } from "@tanstack/react-router";
import type { PrivacyRightsReceipt } from "@console/api/pending";
import { t } from "@console/i18n";
import { ReadReference } from "../../../lib/react/read-reference";
import { Button } from "../../../ui/button/button-base";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Page } from "../../../ui/page/page";
import { RecordPattern } from "../../../ui/patterns/record";
import { SettingsPattern } from "../../../ui/patterns/settings";
import { ApiError, privacyReceipt, privacyRequestPages } from "../api";
import { privacyIntakeDetailQuery, type PrivacyRightKind } from "../api/privacy-intake";
import { PrivacyConsolePanel, PrivacySummary } from "./privacy-console-panel";
import { PrivacyReceipt } from "./privacy-receipt";
import { PrivacyRequest } from "./privacy-request";
import { PrivacyRequestsView } from "./privacy-requests";
import s from "./account.module.css";

const PrivacyIntakeWorkbench = lazy(() =>
  import("./privacy-intake-workbench").then(m => ({ default: m.PrivacyIntakeWorkbench })),
);
const PrivacyIntakeQueue = lazy(() =>
  import("./privacy-intake-queue").then(m => ({ default: m.PrivacyIntakeQueue })),
);
const PrivacyObjectionComposer = lazy(() =>
  import("./privacy-objection-composer").then(m => ({ default: m.PrivacyObjectionComposer })),
);

const privacyRoute = getRouteApi("/app/account/privacy");

const PRIVACY_VIEWS = [
  { id: "privacy-rights", labelKey: "account.privacy.nav.rights" },
  { id: "privacy-intake", labelKey: "account.privacy.nav.intake" },
  { id: "privacy-access-log", labelKey: "account.privacy.nav.accessLog" },
  { id: "privacy-consent", labelKey: "account.privacy.nav.consent" },
  { id: "privacy-retention", labelKey: "account.privacy.nav.retention" },
] as const;

type PrivacyViewId = (typeof PRIVACY_VIEWS)[number]["id"];

export function PrivacyIntake() {
  const { id } = useParams({ from: "/app/account/privacy/intake/$id" });
  const q = useQuery(privacyIntakeDetailQuery(id));
  const head = {
    title: t("account.privacy.intake"),
    actions: (
      <Link to="/account/privacy" search={{ view: "intake" }} className={buttonClass()}>
        {t("privacy.intake.backToQueue")}
      </Link>
    ),
  };
  const receipt = q.data ? <PrivacyReceipt request={privacyReceipt(q.data.request, q.data.as_of)} /> : null;
  const workbench = q.data ? (
    <Suspense fallback={null}>
      <PrivacyIntakeWorkbench request={q.data.request} />
    </Suspense>
  ) : null;
  const subjectStrip = q.data
    ? <KeyValue readOnly items={[{ key: "subject", label: t("account.privacy.subject"), value: q.data.subject_name }]} />
    : undefined;

  return (
    <RecordPattern
      q={q}
      head={{ ...head, meta: q.data?.request.receipt_no }}
      strip={subjectStrip}
      sections={
        <>
          <Card title={t("account.privacy.intake")}>
            {receipt}
          </Card>
          {workbench}
        </>
      }
      baseline={() => (
        <Page floorplan="P-01" head={head} q={q} layout="record">
          {() => (
            <>
              {subjectStrip}
              {receipt}
              {workbench}
            </>
          )}
        </Page>
      )}
    />
  );
}

export function PrivacyRequests() {
  const search = privacyRoute.useSearch();
  const navigate = privacyRoute.useNavigate();
  const q = useInfiniteQuery(privacyRequestPages);
  const [filed, setFiled] = useState<PrivacyRightsReceipt>();
  const [selectedId, select] = useState<string | undefined>();
  const [seen, setSeen] = useState(filed);
  const [objectionOpen, setObjectionOpen] = useState(false);
  const [activeView, setActiveView] = useState<PrivacyViewId>(
    search.view === "intake" ? "privacy-intake" : "privacy-rights",
  );
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
  const intakeViewActive = activeView === "privacy-intake" || search.view === "intake";

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
                if (view.id === "privacy-intake") {
                  void navigate({ search: { view: "intake" }, replace: true, resetScroll: false });
                  return;
                }
                if (search.view === "intake") {
                  void navigate({ search: { view: undefined }, replace: true, resetScroll: false });
                }
                document.getElementById(view.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              {t(view.labelKey)}
            </Button>
          ))}
        </nav>
      }
      panel={
        intakeViewActive ? (
          <Suspense fallback={null}>
            <PrivacyIntakeQueue />
          </Suspense>
        ) : (
          <PrivacyConsolePanel
            items={items}
            selectedId={selected?.id}
            onSelect={select}
            filingSection={filingSection}
            loadMoreRequests={loadMoreRequests}
          />
        )
      }
      record={
        selected
          ? {
              id: selected.id,
              label: selected.receipt_no,
              title: selected.receipt_no,
              meta: selected.controller_label,
              onClose: () => {
                setObjectionOpen(false);
                select(undefined);
              },
              returnFocus: () =>
                document.querySelector<HTMLElement>(
                  `[data-id="${CSS.escape(selected.id)}"], [data-row-id="${CSS.escape(selected.id)}"]`,
                ),
              children: (
                <>
                  <PrivacyReceipt request={selected} />
                  {selected.status.code === "DECIDED" && selected.kinds.length > 0 && (
                    <div className={s.pad}>
                      <Button onClick={() => setObjectionOpen(true)}>
                        {t("privacy.intake.objectionOpen")}
                      </Button>
                    </div>
                  )}
                  {objectionOpen && (
                    <Suspense fallback={null}>
                      <PrivacyObjectionComposer
                        requestId={selected.id}
                        availableKinds={selected.kinds.map(k => k.code as PrivacyRightKind)}
                        onClose={() => setObjectionOpen(false)}
                        onSubmitted={() => {
                          setObjectionOpen(false);
                          void q.refetch();
                        }}
                      />
                    </Suspense>
                  )}
                </>
              ),
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
