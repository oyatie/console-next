// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { ExternalLink } from "../../../ui/external-link";
import { KeyValue } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { ListRecord } from "../../../ui/patterns/list-record";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { RecordSection } from "../../../ui/record/record-section";
import { SelectField } from "../../../ui/select/select-field";
import { payGroupsQuery, payrollRatesQuery, type PayrollRate } from "../api";
import { cited, rateValue, referenceStatus } from "../present";
import s from "./payroll-console.module.css";

const PHONE_QUERY = "(max-width: 767px)";
const subscribePhone = (onChange: () => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
};
const phoneSnapshot = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches;

const rateKey = (rate: PayrollRate) => `${rate.code}:${rate.effective_from}`;
const rateTone = (rate: PayrollRate) => (!cited(rate) || rate.status === "HELD" ? "warn" : rate.status === "ACTIVE" ? "ok" : "info");

export function PayrollReferenceConsole({ baseline }: { baseline: () => ReactNode }) {
  return (
    <ExperienceSwitch baseline={baseline}>
      {() => <PayrollReferenceConsoleContent baseline={baseline} />}
    </ExperienceSwitch>
  );
}

function PayrollReferenceConsoleContent({ baseline }: { baseline: () => ReactNode }) {
  const isPhone = useSyncExternalStore(subscribePhone, phoneSnapshot, () => false);
  const groups = useQuery(payGroupsQuery);
  const { entity } = useSearch({ from: "/app/payroll/reference" });
  const navigate = useNavigate({ from: "/payroll/reference" });
  const [selectedRateId, setSelectedRateId] = useState<string | null>(null);

  const entities = groups.data?.legal_entities ?? [];
  const selected = entity ? entities.find(row => row.id === entity) : entities[0];
  const rates = useQuery({
    ...payrollRatesQuery(selected?.id ?? ""),
    enabled: Boolean(selected),
  });

  const ratesData = rates.data;
  const selectedRate = ratesData?.items.find(r => rateKey(r) === selectedRateId);

  const rail =
    entities.length > 0 ? (
      <nav aria-label={t("payroll.reference.entities")} className={s.railList}>
        {entities.map(row => {
          const active = row.id === selected?.id;
          return (
            <Button
              key={row.id}
              size="sm"
              variant={active ? "primary" : "ghost"}
              aria-pressed={active}
              className={s.railItem}
              onClick={() => {
                setSelectedRateId(null);
                void navigate({ search: { entity: row.id }, replace: true });
              }}
            >
              {row.name ?? t("payroll.entityUnnamed")}
            </Button>
          );
        })}
      </nav>
    ) : undefined;

  const list = !selected ? (
    <div className={s.mainStack}>
      <EmptyState title={t("payroll.reference.pick")} reason={t("payroll.reference.pickReason")} />
    </div>
  ) : (
    <div className={s.mainStack}>
      <QueryState q={rates} layout="list">
        {data => {
          const status = referenceStatus(data);
          if (status) {
            return (
              <EmptyState
                title={status}
                reason={
                  data.adopted
                    ? t("payroll.reference.emptyReason")
                    : t("payroll.reference.noPackReason", { country: data.country_code ?? t("payroll.rule.unknown") })
                }
              />
            );
          }
          return (
            <LongTable
              label={t("payroll.reference.title")}
              empty={null}
              rows={data.items}
              rowId={rateKey}
              activeRowId={selectedRateId ?? undefined}
              onRowAction={id => setSelectedRateId(id)}
              mobileLayout="compact"
              hasMore={false}
              onLoadMore={() => {}}
              columns={[
                {
                  id: "name",
                  header: t("payroll.reference.item"),
                  rowHeader: true,
                  card: "title",
                  minWidth: 170,
                  width: "1.3fr",
                  cell: rate => (
                    <bdi className={s.nowrap}>
                      {rate.name}{" "}
                      <Chip tone={rateTone(rate)}>
                        {t(`payroll.reference.${cited(rate) ? rate.status : "HELD"}`)}
                      </Chip>
                    </bdi>
                  ),
                },
                {
                  id: "value",
                  card: "fact",
                  header: t("payroll.reference.value"),
                  cell: rateValue,
                },
                {
                  id: "period",
                  card: "fact",
                  minWidth: 180,
                  width: "1.3fr",
                  header: t("payroll.reference.periodLabel"),
                  cell: rate => (
                    <bdi className="num">
                      {t("payroll.reference.period", {
                        from: fmtDate(rate.effective_from),
                        to: rate.effective_to_exclusive
                          ? t("payroll.reference.until", { date: fmtDate(rate.effective_to_exclusive) })
                          : t("payroll.reference.open"),
                      })}
                    </bdi>
                  ),
                },
                {
                  id: "citation",
                  card: "omit",
                  header: t("payroll.reference.citation"),
                  width: "2fr",
                  cell: rate =>
                    cited(rate) ? (
                      <ExternalLink href={rate.source_url}>
                        {rate.instrument_ko} · {rate.article_ko} · {rate.promulgation_ko}
                      </ExternalLink>
                    ) : (
                      <bdi>{t("payroll.reference.held")}</bdi>
                    ),
                },
              ]}
            />
          );
        }}
      </QueryState>
    </div>
  );

  return (
    <ListRecord
      q={groups}
      head={{
        title: t("payroll.reference.title"),
        titleId: "payroll-reference-title",
        actions: (
          <Link to="/payroll" className={buttonClass("secondary", { size: "sm", className: s.nowrap })}>
            {t("payroll.title")}
          </Link>
        ),
      }}
      filters={
        isPhone ? (
          <div className={s.entitySelect}>
            <SelectField
              label={t("payroll.entity")}
              placeholder={t("payroll.reference.pick")}
              value={selected?.id ?? null}
              options={entities.map(row => ({ id: row.id, label: row.name ?? t("payroll.entityUnnamed") }))}
              onChange={id => {
                setSelectedRateId(null);
                void navigate({ search: { entity: id }, replace: true });
              }}
            />
          </div>
        ) : undefined
      }
      rail={isPhone ? undefined : rail}
      list={list}
      record={
        selectedRate
          ? {
              id: rateKey(selectedRate),
              label: selectedRate.name,
              title: selectedRate.name,
              meta: selected?.name ?? undefined,
              onClose: () => setSelectedRateId(null),
              children: (
                <div className={s.paneDetail}>
                  <KeyValue
                    readOnly
                    items={[
                      {
                        key: "status",
                        label: t("payroll.reference.statusLabel"),
                        value: (
                          <Chip tone={rateTone(selectedRate)}>
                            {t(`payroll.reference.${cited(selectedRate) ? selectedRate.status : "HELD"}`)}
                          </Chip>
                        ),
                      },
                      { key: "value", label: t("payroll.reference.value"), value: rateValue(selectedRate) },
                      {
                        key: "period",
                        label: t("payroll.reference.periodLabel"),
                        value: t("payroll.reference.period", {
                          from: fmtDate(selectedRate.effective_from),
                          to: selectedRate.effective_to_exclusive
                            ? t("payroll.reference.until", { date: fmtDate(selectedRate.effective_to_exclusive) })
                            : t("payroll.reference.open"),
                        }),
                      },
                    ]}
                  />
                  <RecordSection id="rate-citation" title={t("payroll.reference.citation")}>
                    {cited(selectedRate) ? (
                      <div className={s.sectionStack}>
                        <ExternalLink href={selectedRate.source_url}>
                          {selectedRate.instrument_ko} · {selectedRate.article_ko} · {selectedRate.promulgation_ko}
                        </ExternalLink>
                        <bdi className="muted">{t("payroll.reference.enforced", { date: fmtDate(selectedRate.enforced_on) })}</bdi>
                        <bdi className="muted">{t("payroll.reference.retrieved", { date: fmtDate(selectedRate.retrieved_on) })}</bdi>
                      </div>
                    ) : (
                      <bdi>{t("payroll.reference.held")}</bdi>
                    )}
                  </RecordSection>
                </div>
              ),
            }
          : null
      }
      statusSegments={
        selected
          ? [
              { id: "entity", tone: "strong", content: selected.name ?? t("payroll.entityUnnamed") },
              ...(ratesData ? [{ id: "count", content: t("statutory.count", { count: ratesData.items.length }) }] : []),
            ]
          : undefined
      }
      baseline={baseline}
    />
  );
}
