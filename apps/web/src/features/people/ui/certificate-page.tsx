// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { queryView } from "../../../lib/react/query-view";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Field, TextInput } from "../../../ui/field/field";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { FormSection } from "../../../ui/patterns/form-section";
import { RecordPattern } from "../../../ui/patterns/record";
import { Sheet } from "../../../ui/sheet/sheet";
import { certificateQuery, voidCertificate, reissueCertificate, certificateError, type Certificate } from "../api/certificates";
import { CertificatePaper } from "./certificate-paper";
import s from "./certificate.module.css";
const route = getRouteApi("/app/people/certificates/$certificateId");
export function CertificatePage() {
  const { certificateId } = route.useParams();
  const nav = route.useNavigate();
  const q = useQuery(certificateQuery(certificateId));
  const [act, setAct] = useState<"void" | "reissue" | null>(null);
  const [reason, setReason] = useState("");
  const view = queryView(q);
  const c = view === "denied" || view === "not-found" ? undefined : q.data;
  const change = useCommand({
    run: (input: { action: "void" | "reissue"; reason: string }, key: string) =>
      input.action === "void" ? voidCertificate(c!.id, input.reason, key) : reissueCertificate(c!.id, input.reason, key),
    invalidates: ["/api/v1/hr/certificates"],
    onSuccess: (doc) => { setAct(null); setReason(""); if (c && doc.id !== c.id) void nav({ to: "/people/certificates/$certificateId", params: { certificateId: doc.id } }); },
  });
  const sheet = act && c ? (
    <Sheet open pending={change.isSending} locked={change.isChecking} title={t(act === "void" ? "empDoc.certificate.void" : "empDoc.certificate.reissue")} onClose={() => setAct(null)} consequence={t(act === "void" ? "empDoc.certificate.voidEffect" : "empDoc.certificate.reissueEffect")}
      notice={<CommandError error={change.error} own={certificateError} />}
      actions={<><Button variant="primary" aria-disabled={!reason.trim() || change.isPending} onClick={() => { if (reason.trim() && !change.isPending) change.mutate({ action: act, reason: reason.trim() }); }}>{t(act === "void" ? "empDoc.certificate.void" : "empDoc.certificate.reissue")}</Button></>}>
      <Field label={t("empDoc.certificate.reason")} required>{(p) => <TextInput {...p} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
    </Sheet>
  ) : undefined;
  const renderBaseline = () => (
    <div className="page">
      <div className={s.noPrint}><PageHead title={t("empDoc.cert.title")} crumbs={<Crumbs items={[<Link key="register" to="/people/certificates" search={{}}>{t("empDoc.certificate.register")}</Link>]} />} /></div>
      <QueryState q={q} layout="record" own={certificateError}>{(loaded) => <Document certificate={loaded} onAction={setAct} sheet={sheet} />}</QueryState>
    </div>
  );
  return (
    <RecordPattern
      q={q}
      own={certificateError}
      baseline={renderBaseline}
      back={{ to: "/people/certificates", label: t("empDoc.certificate.register") }}
      head={{
        title: t("empDoc.cert.title"),
        crumbs: <Crumbs items={[<Link key="register" to="/people/certificates" search={{}}>{t("empDoc.certificate.register")}</Link>]} />,
        meta: c ? (
          <>
            <Link to="/people/$id" params={{ id: c.employee_id }} search={{}}>{c.snapshot.name}</Link>
            <bdi className="num">{fmtDateTime(c.issued_at)}</bdi>
          </>
        ) : undefined,
        actions: c ? (
          <>
            {c.replaces_id && <Link className={buttonClass("secondary", { size: "sm" })} to="/people/certificates/$certificateId" params={{ certificateId: c.replaces_id }}>{t("empDoc.certificate.original")}</Link>}
            <Button size="sm" onClick={() => setAct("reissue")}>{t("empDoc.certificate.reissue")}</Button>
            {!c.voided_at && <Button size="sm" onClick={() => setAct("void")}>{t("empDoc.certificate.void")}</Button>}
            {!c.voided_at && <Button size="sm" variant="primary" onClick={() => window.print()}>{t("notice.print")}</Button>}
          </>
        ) : undefined,
      }}
      sections={c ? <FormSection><div data-print-doc=""><CertificatePaper certificate={c} /></div></FormSection> : null}
      overlays={sheet}
      statusSegments={c ? [{ id: "no", tone: "strong", content: c.certificate_no }, { id: "name", content: c.snapshot.name }, { id: "state", content: t(c.voided_at ? "empDoc.certificate.voided" : "empDoc.certificate.issued") }] : null}
    />
  );
}
function Document({ certificate: c, onAction, sheet }: { certificate: Certificate; onAction: (act: "void" | "reissue") => void; sheet: React.ReactNode }) {
  return <>
    <div className={`${s.bar} ${s.noPrint}`}>
      <Link to="/people/$id" params={{ id: c.employee_id }} search={{}}>{c.snapshot.name}</Link>
      <span>{fmtDateTime(c.issued_at)}</span>
      {!c.voided_at && <Button variant="primary" onClick={() => window.print()}>{t("notice.print")}</Button>}
      {!c.voided_at && <Button onClick={() => onAction("void")}>{t("empDoc.certificate.void")}</Button>}
      <Button onClick={() => onAction("reissue")}>{t("empDoc.certificate.reissue")}</Button>
      {c.replaces_id && <Link to="/people/certificates/$certificateId" params={{ certificateId: c.replaces_id }}>{t("empDoc.certificate.original")}</Link>}
    </div>
    <CertificatePaper certificate={c} />
    {sheet}
  </>;
}
