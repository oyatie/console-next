import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { failureText } from "../../../lib/refusal";
import { Field, TextInput } from "../../../ui/field/field";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Skeleton } from "../../../ui/skeleton/skeleton";
import { Banner } from "../../../ui/banner/banner";
import { Card } from "../../../ui/card/card";
import { PageHead } from "../../../ui/page-head/page-head";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { ApiError, outcomeQuery, recordHref } from "../api";

export function RequestLookup() {
  const [key,setKey]=useState(""); const nav=useNavigate();
  const input=useRef<HTMLInputElement>(null);
  const length=Array.from(key.trim()).length;
  const valid=length>=16 && length<=200;
  return <main className="page"><PageHead title={t("requestOutcome.title")} />
    <Card><div className="form">
      <p>{t("requestOutcome.empty")}</p>
      <Field label={t("requestOutcome.lookup")} required hint={t("requestOutcome.invalid")}>{c=><TextInput {...c} ref={input} value={key} onChange={e=>setKey(e.target.value)} autoComplete="off" />}</Field>
      {valid ? <Button onClick={()=>void nav({to:"/requests/$id",params:{id:key.trim()}})}>{t("requestOutcome.find")}</Button>
      : <DisabledReason reason={t("requestOutcome.invalid")} control={p=><Button {...p} onClick={e=>{p.onClick(e);input.current?.focus();}}>{t("requestOutcome.find")}</Button>} />}
    </div></Card></main>;
}
const requestRoute = getRouteApi("/app/requests/$id");
export function RequestPage() {
  const {id}=requestRoute.useParams(); const q=useQuery({...outcomeQuery(id),refetchOnMount:"always"});
  return <main className="page"><PageHead title={t("requestOutcome.title")} />
    <Link to="/requests" className={buttonClass("ghost")}>{t("requestOutcome.lookup")}</Link>
    {q.isPending ? <Skeleton label={t("common.loading")} bones={["title","line","row","row"]} />
    : q.error instanceof ApiError && q.error.status===404 && !q.data ? <EmptyState title={t("requestOutcome.notFound")} reason={t("requestOutcome.remedy")} actions={<Link to="/requests" className={buttonClass("secondary")}>{t("requestOutcome.lookup")}</Link>} />
    : <QueryState q={q}>{out=><Card><div className="form">
      <h2 role="status">{t(`requestOutcome.${out.state}`)}</h2>
      <p className="code">{out.id}</p>
      <dl><dt>{t("requestOutcome.created")}</dt><dd>{fmtDateTime(out.created_at)}</dd>
        {out.deadline && <><dt>{t("requestOutcome.deadline")}</dt><dd>{fmtDateTime(out.deadline)}</dd></>}</dl>
      {out.masked && <Banner tone="warn">{t("requestOutcome.masked")}</Banner>}
      {out.refusal_code && <Banner tone="danger">{failureText(new ApiError(409,out.refusal_code,out.refusal_code))}</Banner>}
      {out.state === "PROCESSING" && <p>{t("requestOutcome.remedy")}</p>}
      <h3>{t("requestOutcome.result")}</h3>
      {out.result==null ? <p>{t("requestOutcome.none")}</p> : <p>{resultText(out.result)}</p>}
      {out.touched.length>0 && <><h3>{t("requestOutcome.touched")}</h3><ul>{out.touched.map((ref,i)=>
        <li key={`${ref.audit_id}-${i}`}>{recordHref(ref.type,ref.id) ? <Link to={recordHref(ref.type,ref.id) as "/"}>{t("requestOutcome.history")} · <span className="code">{ref.id}</span></Link> : <span className="code">{ref.id}</span>}</li>)}</ul></>}
    </div></Card>}</QueryState>}
  </main>;
}


function resultText(value: unknown): string {
  if (value && typeof value === "object") {
    const result = value as { go_live_at?: unknown; items?: unknown };
    if (typeof result.go_live_at === "string") return t("requestOutcome.resultLive", { at: fmtDateTime(result.go_live_at) });
    if (Array.isArray(result.items)) return t("requestOutcome.resultItems", { count: result.items.length });
  }
  return t("requestOutcome.resultRecorded");
}
