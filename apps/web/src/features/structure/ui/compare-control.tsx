import { useState } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { Button, ToggleButton } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { DateField } from "../../../ui/date/date-field";
import { isDate } from "../../../ui/date/days";
import { Chip } from "../../../ui/chip";
import { Banner } from "../../../ui/banner/banner";
import css from "./chart.module.css";

const route = getRouteApi("/app/org");
const MARKS = ["new", "moved", "renamed", "gone"] as const;
export function CompareControl() {
  const q = route.useSearch();
  const nav = route.useNavigate();
  const today = todayKst();
  const active = Boolean(q.compare_a || q.compare_b);
  const [a, setA] = useState(q.compare_a ?? `${today.slice(0, 8)}01`);
  const [b, setB] = useState(q.compare_b ?? today);
  const [source, setSource] = useState({ a: q.compare_a, b: q.compare_b });
  if (source.a !== q.compare_a || source.b !== q.compare_b) {
    setSource({ a: q.compare_a, b: q.compare_b });
    if (q.compare_a) setA(q.compare_a);
    if (q.compare_b) setB(q.compare_b);
  }
  const valid = isDate(a) && isDate(b) && a <= b;
  const apply = (from: string, to: string) => {
    if (isDate(from) && isDate(to) && from <= to) void nav({ search: (search) => ({ ...search, compare_a: from, compare_b: to, act: undefined }) });
  };
  return <section aria-label={t("asof.compare")}>
    <ToggleButton pressed={active} onClick={() => active
      ? void nav({ search: (search) => ({ ...search, compare_a: undefined, compare_b: undefined }) }) : apply(a, b)}>{t("asof.compare")}</ToggleButton>
    {active && <>
      <div className="row">
        <DateField label={t("asof.compareFrom")} today={today} required value={a} onChange={(chosen) => { setA(chosen); apply(chosen, b); }} error={!isDate(a) ? t("asof.dateInvalid") : undefined} />
        <DateField label={t("asof.compareTo")} today={today} required value={b} onChange={(chosen) => { setB(chosen); apply(a, chosen); }} error={!isDate(b) ? t("asof.dateInvalid") : undefined} />
      </div>
      {!valid && <Banner tone="warn" placement="page" title={t("asof.rangeError")} actions={<Button onClick={() => { setB(a); apply(a, a); }}>{t("asof.rangeRemedy")}</Button>} />}
      <div className="row" role="group" aria-label={t("asof.compare")}>{MARKS.map((mark) => <Chip key={mark} data-diff={mark}>{t(`asof.${mark}`)}</Chip>)}</div>
    </>}
  </section>;
}

export function CompareResults({ result }: { result: components["schemas"]["StructureDiff"] }) {
  return <section aria-label={t("asof.changes")} className={css.compareResults}>
    {result.marks.length === 0 ? <p className="muted">{t("asof.compareEmpty")}</p> : <ul>{result.marks.map((n) => <li key={n.id}>{n.before_name && n.before_name !== n.name ? `${n.before_name} → ` : ""}{n.name} {n.marks.map((m) => <Chip key={m}>{t(`asof.${m}`)}</Chip>)} {n.changes.map((c) => <Link key={c.change_id} to="/org/changes/$id" params={{ id: c.change_id }}>{c.code}</Link>)}</li>)}</ul>}
    <h2>{t("asof.changes")}</h2>
    <ul>{result.changes.map((c) => <li key={c.change_id}><Link to="/org/changes/$id" params={{ id: c.change_id }}>{c.code}</Link> · {c.effective_date}</li>)}</ul>
    <Link className={buttonClass("ghost")} to="/org/changes" search={{ view: "done", effective_from: result.a, effective_to: result.b }}>{t("asof.changes")}</Link>
  </section>;
}
