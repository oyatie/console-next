// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { Sheet } from "../../../ui/sheet/sheet";
import { certificateQuery, voidCertificate, reissueCertificate, certificateError, type Certificate } from "../api/certificates";
import { CertificatePaper } from "./certificate-paper";
import s from "./certificate.module.css";
const route = getRouteApi("/app/people/certificates/$certificateId");
export function CertificatePage() {
  const { certificateId } = route.useParams();
  const q = useQuery(certificateQuery(certificateId));
  return <div className="page"><div className={s.noPrint}><PageHead title={t("empDoc.cert.title")} crumbs={<Crumbs items={[<Link key="register" to="/people/certificates" search={{}}>{t("empDoc.certificate.register")}</Link>]} />} /></div><QueryState q={q} own={certificateError}>{(c) => <Document certificate={c} />}</QueryState></div>;
}
function Document({ certificate: c }: { certificate: Certificate }) {
  const nav = route.useNavigate();
  const [act, setAct] = useState<"void" | "reissue" | null>(null);
  const [reason, setReason] = useState("");
  const change = useCommand({
    run: (input: { action: "void" | "reissue"; reason: string }, key: string) => input.action === "void" ? voidCertificate(c.id, input.reason, key) : reissueCertificate(c.id, input.reason, key),
    invalidates: ["/api/v1/hr/certificates"],
    onSuccess: (doc) => { setAct(null); setReason(""); if (doc.id !== c.id) void nav({ to: "/people/certificates/$certificateId", params: { certificateId: doc.id } }); },
  });
  return <>
    <div className={`${s.bar} ${s.noPrint}`}>
      <Link to="/people/$id" params={{ id: c.employee_id }} search={{}}>{c.snapshot.name}</Link>
      <span>{fmtDateTime(c.issued_at)}</span>
      {!c.voided_at && <Button variant="primary" onClick={() => window.print()}>{t("notice.print")}</Button>}
      {!c.voided_at && <Button onClick={() => setAct("void")}>{t("empDoc.certificate.void")}</Button>}
      <Button onClick={() => setAct("reissue")}>{t("empDoc.certificate.reissue")}</Button>
      {c.replaces_id && <Link to="/people/certificates/$certificateId" params={{ certificateId: c.replaces_id }}>{t("empDoc.certificate.original")}</Link>}
    </div>
    <CertificatePaper certificate={c} />
    {act && <Sheet open pending={change.isSending} locked={change.isChecking} title={t(act === "void" ? "empDoc.certificate.void" : "empDoc.certificate.reissue")} onClose={() => setAct(null)} consequence={t(act === "void" ? "empDoc.certificate.voidEffect" : "empDoc.certificate.reissueEffect")}
      notice={<CommandError error={change.error} own={certificateError} />}
      actions={<><Button variant="primary" aria-disabled={!reason.trim() || change.isPending} onClick={() => { if (reason.trim() && !change.isPending) change.mutate({ action: act, reason: reason.trim() }); }}>{t(act === "void" ? "empDoc.certificate.void" : "empDoc.certificate.reissue")}</Button></>}>
      <Field label={t("empDoc.certificate.reason")} required>{(p) => <TextInput {...p} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
    </Sheet>}
  </>;
}
