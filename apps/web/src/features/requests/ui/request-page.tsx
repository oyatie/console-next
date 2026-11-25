import { lazy, Suspense, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { chunk } from "../../../lib/chunk-guard";
import { QueryState } from "../../../lib/react/query-state";
import { failureText } from "../../../lib/refusal";
import { Field, TextInput } from "../../../ui/field/field";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Skeleton, ReadSkeleton } from "../../../ui/skeleton/skeleton";
import { Banner } from "../../../ui/banner/banner";
import { Card } from "../../../ui/card/card";
import { PageHead } from "../../../ui/page-head/page-head";
import { buttonClass } from "../../../ui/button/button-class";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { ApiError, outcomeQuery, recordHref } from "../api";
import { requestKey } from "../../../lib/pure/request-key";

const RequestLookupConsole = lazy(() => chunk(import("./request-console")).then((m) => ({ default: m.RequestLookupConsole })));
const RequestPageConsole = lazy(() => chunk(import("./request-console")).then((m) => ({ default: m.RequestPageConsole })));

export function RequestLookup() {
  const [key,setKey]=useState(""); const nav=useNavigate();
  const input=useRef<HTMLInputElement>(null);
  const valid=requestKey(key);
  const fieldNode = (
    <>
      <p>{t("requestOutcome.empty")}</p>
      <Field label={t("requestOutcome.lookup")} required hint={t("requestOutcome.invalid")}>{c=><TextInput {...c} ref={input} value={key} onChange={e=>setKey(e.target.value)} autoComplete="off" />}</Field>
    </>
  );
  const actionNode = (disclosure: boolean) => valid
    ? <Button onClick={()=>void nav({to:"/requests/$id",params:{id:valid}})}>{t("requestOutcome.find")}</Button>
    : <DisabledReason layout={disclosure ? "disclosure" : "stacked"} reason={t("requestOutcome.invalid")} control={p=><Button {...p} onClick={e=>{p.onClick(e);input.current?.focus();}}>{t("requestOutcome.find")}</Button>} />;
  return (
    <ExperienceSwitch
      baseline={() => (
        <main className="page">
          <PageHead title={t("requestOutcome.title")} />
          <Card><div className="form">{fieldNode}{actionNode(false)}</div></Card>
        </main>
      )}
    >
      {() => (
        <Suspense fallback={<ReadSkeleton layout="form" />}>
          <RequestLookupConsole sections={fieldNode} actions={actionNode(true)} onSubmit={() => { if (valid) void nav({ to: "/requests/$id", params: { id: valid } }); }} />
        </Suspense>
      )}
    </ExperienceSwitch>
  );
}
const requestRoute = getRouteApi("/app/requests/$id");
export function RequestPage() {
  // Every field re-renders: the Console screen reads the state behind a lazy chunk, after this render's tracking.
  const {id}=requestRoute.useParams(); const q=useQuery({...outcomeQuery(id),refetchOnMount:"always",notifyOnChangeProps:"all"});
  const own = (code: string) => code === "request_not_found" ? `${t("requestOutcome.notFound")} ${t("requestOutcome.remedy")}` : undefined;
  const renderOutcome = (out: NonNullable<typeof q.data>) => (
    <>
      <h2 role="status">{t(`requestOutcome.${out.state}`)}</h2>
      <p className="code">{out.id}</p>
      <dl><dt>{t("requestOutcome.created")}</dt><dd>{fmtDateTime(out.created_at)}</dd>
        {out.deadline && <><dt>{t("requestOutcome.deadline")}</dt><dd>{fmtDateTime(out.deadline)}</dd></>}</dl>
      {out.masked && <Banner tone="warn">{t("requestOutcome.masked")}</Banner>}
      {out.refusal_code && <Banner tone="danger" actions={out.refusal_code.startsWith("change_request_") && <Link to="/people/requests" className={buttonClass("ghost")}>{t("requests.title")}</Link>}>{failureText(new ApiError(409,out.refusal_code,out.refusal_code))}</Banner>}
      {out.state === "PROCESSING" && <p>{t("requestOutcome.remedy")}</p>}
      <h3>{t("requestOutcome.result")}</h3>
      {out.result==null ? <p>{t("requestOutcome.none")}</p> : <p>{resultText(out.result)}</p>}
      {out.touched.length>0 && <><h3>{t("requestOutcome.touched")}</h3><ul>{out.touched.map((ref,i)=>
        <li key={`${ref.audit_id}-${i}`}>{recordHref(ref.type,ref.id) ? <Link to={recordHref(ref.type,ref.id) as "/"}>{t("requestOutcome.history")} · <code className="code">{ref.id}</code></Link> : <code className="code">{ref.id}</code>}</li>)}</ul></>}
    </>
  );
  return (
    <ExperienceSwitch
      baseline={() => (
        <main className="page">
          <PageHead title={t("requestOutcome.title")} />
          <Link to="/requests" className={buttonClass("ghost")}>{t("requestOutcome.lookup")}</Link>
          <QueryState q={q} own={own} loading={<Skeleton label={t("common.loading")} bones={["title","line","row","row"]} />}>
            {out => <Card><div className="form">{renderOutcome(out)}</div></Card>}
          </QueryState>
        </main>
      )}
    >
      {() => (
        <Suspense fallback={<ReadSkeleton layout="record" />}>
          <RequestPageConsole q={q} own={own} sections={q.data ? renderOutcome(q.data) : null} />
        </Suspense>
      )}
    </ExperienceSwitch>
  );
}


function resultText(value: unknown): string {
  if (value && typeof value === "object") {
    const result = value as { go_live_at?: unknown; items?: unknown };
    if (typeof result.go_live_at === "string") return t("requestOutcome.resultLive", { at: fmtDateTime(result.go_live_at) });
    if (Array.isArray(result.items)) return t("requestOutcome.resultItems", { count: result.items.length });
  }
  return t("requestOutcome.resultRecorded");
}
