// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtKrw, fmtNumber } from "@console/i18n/format";
import { authzQuery } from "../../../reference/authz/api";
import { PageReadGate } from "../../../reference/authz/ui/access-gate";
import { QueryState } from "../../../lib/react/query-state";
import { Button, Form } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { KeyValue, StatRow } from "../../../ui/key-value/key-value";
import { RegisterTotals } from "../../../ui/patterns/register-totals";
import { payrollProjectionQuery, type PayrollScenario, type Projection } from "../api";

const money = (value: number) => fmtKrw(Number.isFinite(value) ? String(Math.round(value)) : null);

function Result({ result, steps }: { result: Projection; steps: number }) {
  return <section aria-label={t("payroll.outlook.result")} aria-live="polite">
    <h2>{t("payroll.outlook.resultAt", { count: steps })}</h2>
    <StatRow phoneCols={2} items={[
      { key: "point", label: t("payroll.outlook.point"), value: money(result.point_estimate) },
      { key: "low", label: t("payroll.outlook.low"), value: money(result.ci95_low) },
      { key: "high", label: t("payroll.outlook.high"), value: money(result.ci95_high) },
      { key: "tail", label: t("payroll.outlook.tail"), value: money(result.cvar95) },
    ]} />
    <details><summary>{t("payroll.outlook.assumptions")}</summary><KeyValue items={[
      { key: "simulations", label: t("payroll.outlook.simulations"), value: fmtNumber(result.assumptions.simulations) },
      { key: "drift", label: t("payroll.outlook.drift"), value: fmtNumber(result.assumptions.drift) },
      { key: "volatility", label: t("payroll.outlook.volatility"), value: fmtNumber(result.assumptions.ewma_volatility) },
      { key: "nu", label: t("payroll.outlook.nu"), value: fmtNumber(result.assumptions.student_t_nu) },
    ]} /></details>
  </section>;
}

export function PayrollOutlook() {
  const auth = useQuery(authzQuery);
  const [history, setHistory] = useState("");
  const [horizon, setHorizon] = useState("1");
  const [tried, setTried] = useState(false);
  const [submitted, setSubmitted] = useState<{ key: string; request: PayrollScenario } | null>(null);
  const projection = useQuery(payrollProjectionQuery(submitted));
  const lines = history.trim().split(/\r?\n/).map(line => line.trim());
  const series = lines.map(line => /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(line) ? Number(line.replaceAll(",", "")) : NaN);
  const validSeries = series.length >= 3 && series.every(value => Number.isSafeInteger(value) && value > 0);
  const steps = Number(horizon);
  const validSteps = Number.isInteger(steps) && steps >= 1 && steps <= 3650;
  const controls = <Form onSubmit={() => {
    setTried(true);
    if (validSeries && validSteps) setSubmitted({ key: crypto.randomUUID(), request: { series, horizon: steps } });
  }}>
    <Field required label={t("payroll.outlook.history")} hint={t("payroll.outlook.historyHint")} error={tried && !validSeries ? t("payroll.outlook.historyInvalid") : undefined}>
      {props => <TextArea {...props} rows={5} value={history} onChange={e => { setSubmitted(null); setHistory(e.target.value); }} />}
    </Field>
    <Field required label={t("payroll.outlook.horizon")} hint={t("payroll.outlook.stepsHint")} error={tried && !validSteps ? t("payroll.outlook.stepsInvalid") : undefined}>
      {props => <TextInput {...props} type="number" min={1} max={3650} step={1} value={horizon} onChange={e => { setSubmitted(null); setHorizon(e.target.value); }} />}
    </Field>
    <Button type="submit" disabled={!!submitted && projection.isFetching}>{t("payroll.outlook.calculate")}</Button>
  </Form>;
  const result = submitted && projection.isSuccess ? <Result result={projection.data} steps={submitted.request.horizon} /> : undefined;
  return <RegisterTotals q={auth} head={{ title: t("payroll.outlook.title") }} totals={result} register={submitted
    ? <PageReadGate q={projection}>{controls}{!result && <QueryState q={projection} layout="record">{() => null}</QueryState>}</PageReadGate>
    : <>{controls}<EmptyState title={t("payroll.outlook.empty")} reason={t("payroll.outlook.emptyHint")} /></>} />;
}
