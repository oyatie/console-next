// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { announce } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue } from "../../../ui/key-value/key-value";
import { PageHead } from "../../../ui/page-head/page-head";
import { ExperienceSwitch } from "../../../ui/patterns/experience-switch";
import { Worklist } from "../../../ui/patterns/worklist";
import { WorklistSearchField } from "../../../ui/patterns/worklist-parts";
import { Table } from "../../../ui/table";
import {
  myDispatchOffersQuery,
  respondDispatchOffer,
  type DispatchResponseKind,
  type MyDispatchOffer,
} from "../api/dispatch-offers";

const DESKTOP_MEDIA = "(min-width: 768px)";

function subscribeDesktop(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(DESKTOP_MEDIA);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

const getDesktopSnapshot = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(DESKTOP_MEDIA).matches
    : true;

const getDesktopServerSnapshot = () => false;

function DispatchOfferDetail({
  offer,
  isPending,
  error,
  onRespond,
}: {
  offer: MyDispatchOffer;
  isPending: boolean;
  error: unknown;
  onRespond: (kind: DispatchResponseKind) => void;
}) {
  return (
    <div className="form">
      <KeyValue
        label={t("me.dispatch.detail")}
        items={[
          { key: "req", label: t("me.dispatch.col.requestNo"), value: <code className="code">{offer.request_no}</code> },
          {
            key: "start",
            label: t("me.dispatch.col.windowStart"),
            value: <time dateTime={offer.accept_window_started_at}>{fmtDateTime(offer.accept_window_started_at)}</time>,
          },
          {
            key: "end",
            label: t("me.dispatch.col.windowEnd"),
            value: <time dateTime={offer.accept_window_ends_at}>{fmtDateTime(offer.accept_window_ends_at)}</time>,
          },
          { key: "wo", label: t("me.dispatch.workOrder"), value: <code className="code">{offer.work_order_id}</code> },
          { key: "branch", label: t("me.dispatch.branch"), value: <code className="code">{offer.branch_id}</code> },
        ]}
      />
      <CommandError error={error} />
      <div className="form__actions">
        <Button variant="secondary" disabled={isPending} onClick={() => onRespond("DECLINE")}>
          {t("me.dispatch.decline")}
        </Button>
        <Button variant="primary" disabled={isPending} onClick={() => onRespond("ACCEPT")}>
          {t("me.dispatch.accept")}
        </Button>
      </div>
    </div>
  );
}

function ConsoleDispatchOffersPage() {
  const offersQ = useQuery(myDispatchOffersQuery);
  const isDesktop = useSyncExternalStore(subscribeDesktop, getDesktopSnapshot, getDesktopServerSnapshot);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [dismissed, setDismissed] = useState(false);

  const allItems = offersQ.data?.items ?? [];
  const qNorm = search.trim().toLowerCase();
  const visible = qNorm
    ? allItems.filter((item) => item.request_no.toLowerCase().includes(qNorm))
    : allItems;
  const activeSel =
    selectedId && visible.some((o) => o.dispatch_id === selectedId)
      ? selectedId
      : isDesktop && !dismissed
        ? visible[0]?.dispatch_id
        : undefined;
  const selected = visible.find((o) => o.dispatch_id === activeSel);

  const handleSelect = (id: string) => {
    setDismissed(false);
    setSelectedId(id);
  };

  const handleClose = () => {
    setDismissed(true);
    setSelectedId(undefined);
  };

  const respondCmd = useCommand({
    run: (input: { id: string; kind: DispatchResponseKind }) => respondDispatchOffer(input.id, input.kind),
    invalidates: ["/api/v1/me/dispatch-offers", "/api/v1/me/action-inbox"],
    onSuccess: (_res, input) => {
      setSelectedId(undefined);
      announce(t("me.dispatch.responded", { response: input.kind }));
    },
  });

  const tableColumns = [
    {
      header: t("me.dispatch.col.requestNo"),
      card: "title" as const,
      cell: (item: MyDispatchOffer) => <code className="code">{item.request_no}</code>,
    },
    {
      header: t("me.dispatch.col.windowStart"),
      card: "fact" as const,
      cell: (item: MyDispatchOffer) => (
        <time dateTime={item.accept_window_started_at}>{fmtDateTime(item.accept_window_started_at)}</time>
      ),
    },
    {
      header: t("me.dispatch.col.windowEnd"),
      card: "fact" as const,
      cell: (item: MyDispatchOffer) => (
        <time dateTime={item.accept_window_ends_at}>{fmtDateTime(item.accept_window_ends_at)}</time>
      ),
    },
  ];

  return (
    <Worklist
      q={offersQ}
      viewportLock
      head={{
        title: t("me.dispatch.title"),
        titleId: "dispatch-offers-title",
        actions: (
          <Link to="/me/desk" className={buttonClass("secondary", { size: "sm" })}>
            {t("me.desk.title")}
          </Link>
        ),
      }}
      find={
        <div data-list-find="">
          <WorklistSearchField label={t("me.dispatch.search")} value={search} onChange={setSearch} />
        </div>
      }
      list={() =>
        visible.length === 0 ? (
          <EmptyState title={t("me.dispatch.emptyTitle")} reason={t("me.dispatch.emptyReason")} />
        ) : (
          <Table
            label={t("me.dispatch.title")}
            rows={visible}
            rowId={(r) => r.dispatch_id}
            selected={activeSel}
            onSelect={handleSelect}
            columns={tableColumns}
          />
        )
      }
      onSelect={handleSelect}
      record={
        selected
          ? {
              id: selected.dispatch_id,
              label: t("me.dispatch.detail"),
              title: selected.request_no,
              onClose: handleClose,
              children: (
                <DispatchOfferDetail
                  offer={selected}
                  isPending={respondCmd.isPending}
                  error={respondCmd.error}
                  onRespond={(kind) => respondCmd.mutate({ id: selected.dispatch_id, kind })}
                />
              ),
            }
          : null
      }
      statusSegments={[{ id: "count", content: t("me.dispatch.statusCount", { count: visible.length }) }]}
    />
  );
}

function BaselineDispatchOffersPage() {
  const offersQ = useQuery(myDispatchOffersQuery);
  const respondCmd = useCommand({
    run: (input: { id: string; kind: DispatchResponseKind }) => respondDispatchOffer(input.id, input.kind),
    invalidates: ["/api/v1/me/dispatch-offers"],
    onSuccess: (_res, input) => announce(t("me.dispatch.responded", { response: input.kind })),
  });
  return (
    <main className="page" data-floorplan="P-03">
      <PageHead title={t("me.dispatch.title")} />
      <QueryState q={offersQ} layout="list">
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={t("me.dispatch.emptyTitle")} reason={t("me.dispatch.emptyReason")} />
          ) : (
            data.items.map((offer) => (
              <Card key={offer.dispatch_id} title={offer.request_no}>
                <DispatchOfferDetail
                  offer={offer}
                  isPending={respondCmd.isPending}
                  error={respondCmd.error}
                  onRespond={(kind) => respondCmd.mutate({ id: offer.dispatch_id, kind })}
                />
              </Card>
            ))
          )
        }
      </QueryState>
    </main>
  );
}

export function MeDispatchOffersPage() {
  return <ExperienceSwitch baseline={() => <BaselineDispatchOffersPage />}>{() => <ConsoleDispatchOffersPage />}</ExperienceSwitch>;
}
