// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtKrw } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RecordHighlightBand, RecordPaneSection, RecordSummaryList } from "../../../ui/patterns/list-record-parts";
import { describeEvent, eventLine } from "../present";
import type { Card } from "./use-card";

type PanelItem = ComponentProps<typeof KeyValue>["items"][number];
type Detail = components["schemas"]["EmployeeDetail"];
type CertItem = components["schemas"]["CertificatePage"]["items"][number];
type LifecycleEvent = components["schemas"]["EmployeeLifecycleEvent"];
type AttMonth = components["schemas"]["AttendancePersonMonth"];

export function RosterPanelTabBody({
  active,
  d,
  c,
  monthNum,
  employmentItems,
  personalItems,
  insuranceItems,
  summaryItems,
  events,
  recentEvents,
  certsItems,
  attMonthData,
  next,
  linked,
  openCard,
}: {
  active: string;
  d: Detail;
  c: Card;
  monthNum: number;
  employmentItems: PanelItem[];
  personalItems: PanelItem[];
  insuranceItems: PanelItem[];
  summaryItems: { key: string; label: ReactNode; value: ReactNode }[];
  events: LifecycleEvent[];
  recentEvents: LifecycleEvent[];
  certsItems: CertItem[];
  attMonthData: AttMonth | undefined;
  next: { date: string; what: string } | null | undefined;
  linked: { display_name?: string | null; sign_in_id?: string | null; id: string } | undefined;
  openCard: (act?: string, tab?: "events" | "docs" | "ledger" | "access") => void;
}) {
  const e = d.employee;
  const m = d.employment ?? d.pending_employment;
  const byId = (eid: string) => events.find(x => x.id === eid);

  if (active === "history") {
    return (
      <RecordPaneSection
        title={t("people.panel.sec.recentHistory")}
        trailing={
          <Link to="/people/$id" params={{ id: e.id }} search={{ tab: "events" }}>
            {t("people.panel.sec.allHistory")}
          </Link>
        }
      >
        {recentEvents.length > 0 ? (
          <KeyValue
            density="dense"
            items={events.map(ev => ({
              key: ev.id,
              label: <bdi className="num">{ev.effective_date}</bdi>,
              value: eventLine(ev, c.title) ?? describeEvent(ev, e.name, byId).title,
            }))}
          />
        ) : (
          <bdi className="muted t-xs">{t("empCard.spine.empty")}</bdi>
        )}
      </RecordPaneSection>
    );
  }
  if (active === "attendance") {
    return (
      <RecordPaneSection title={t("people.panel.summary.monthAtt", { month: monthNum })}>
        {attMonthData ? (
          <RecordSummaryList items={summaryItems.filter(item => item.key !== "pay")} />
        ) : (
          <bdi className="muted t-xs">{"—"}</bdi>
        )}
      </RecordPaneSection>
    );
  }
  if (active === "payroll") {
    return (
      <RecordPaneSection title={t("people.panel.summary.monthPay", { month: monthNum })}>
        <KeyValue
          density="dense"
          items={[
            {
              key: "basePay",
              label: t("people.field.basePay"),
              value: !m ? t("format.notComputable") : m.base_pay === undefined ? t("people.field.restricted") : fmtKrw(m.base_pay),
            },
            ...summaryItems
              .filter(item => item.key === "pay")
              .map(item => ({ key: item.key, label: item.label, value: item.value })),
          ]}
        />
      </RecordPaneSection>
    );
  }
  if (active === "docs") {
    return (
      <RecordPaneSection title={t("people.panel.certsCount", { count: certsItems.length })}>
        {certsItems.length > 0 ? (
          <KeyValue
            density="dense"
            items={certsItems.map(cert => ({
              key: cert.id,
              label: <bdi className="num">{cert.issued_at.slice(0, 10)}</bdi>,
              value: cert.kind,
            }))}
          />
        ) : (
          <Button size="sm" variant="secondary" onClick={() => openCard("cert")}>
            {t("people.panel.act.cert")}
          </Button>
        )}
      </RecordPaneSection>
    );
  }
  if (active === "account") {
    return (
      <RecordPaneSection title={t("people.panel.tab.account")}>
        <KeyValue
          density="dense"
          items={[
            {
              key: "acct",
              label: t("people.account.title"),
              value: linked ? `${linked.display_name || linked.sign_in_id || linked.id} · ${t("people.panel.account.linked")}` : t("people.panel.account.unlinked"),
            },
          ]}
        />
      </RecordPaneSection>
    );
  }

  return (
    <>
      <RecordPaneSection
        title={t("people.panel.sec.employment")}
        foot={
          next ? (
            <RecordHighlightBand tag={t("people.panel.plannedTag")}>
              {next.what} <bdi className="num">{next.date.slice(5)}</bdi>
            </RecordHighlightBand>
          ) : null
        }
      >
        <KeyValue density="dense" items={employmentItems} />
      </RecordPaneSection>

      {personalItems.length > 0 ? (
        <RecordPaneSection title={t("people.panel.sec.personal")}>
          <KeyValue density="dense" items={personalItems} />
        </RecordPaneSection>
      ) : null}

      {insuranceItems.length > 0 && e.status !== "EXITED" ? (
        <RecordPaneSection title={t("people.panel.sec.insurance")}>
          <KeyValue density="dense" items={insuranceItems} />
        </RecordPaneSection>
      ) : null}

      {recentEvents.length > 0 ? (
        <RecordPaneSection
          title={t("people.panel.sec.recentHistory")}
          trailing={
            <Link to="/people/$id" params={{ id: e.id }} search={{ tab: "events" }}>
              {t("people.panel.sec.allHistory")}
            </Link>
          }
        >
          <KeyValue
            density="dense"
            items={recentEvents.map(ev => ({
              key: ev.id,
              label: <bdi className="num">{ev.effective_date}</bdi>,
              value: eventLine(ev, c.title) ?? describeEvent(ev, e.name, byId).title,
            }))}
          />
        </RecordPaneSection>
      ) : null}

      {summaryItems.length > 0 ? (
        <RecordPaneSection title={t("people.panel.sec.summary")}>
          <RecordSummaryList items={summaryItems} />
        </RecordPaneSection>
      ) : null}
    </>
  );
}
