// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { problemOf } from "../api";
import { myAccessQuery } from "../../../reference/authz/api";
import { freshOnOpen } from "../../../lib/query";
import { QueryState } from "../../../lib/react/query-state";
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Checks } from "../../../ui/choice/checks";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { Composer } from "../../../ui/composer/composer";
import { Field, TextInput } from "../../../ui/field/field";
import { issueCertificate, certificateError, certificatePreconditionQuery, type IssueCertificate } from "../api/certificates";
import type { Card } from "./use-card";
import { Who } from "./card-who";
import { Banner } from "../../../ui/banner/banner";
const ITEMS = ["period", "duty", "position", "wage", "birth"] as const;

export function CertificateSheet({ c, onClose }: { c: Card; onClose: () => void }) {
  const nav = useNavigate();
  const [kind, setKind] = useState<IssueCertificate["kind"] | null>(null);
  const [items, setItems] = useState<IssueCertificate["items"]>([]);
  const [purpose, setPurpose] = useState("");
  const issue = useCommand({
    run: (body: IssueCertificate, key: string) => issueCertificate(body, key),
    invalidates: ["/api/v1/hr/certificates"],
    onSuccess: (doc) => void nav({ to: "/people/certificates/$certificateId", params: { certificateId: doc.id } }),
  });
  const needsSettings = problemOf(issue.error)?.code === "certificate_settings_required";
  const settings = freshOnOpen(useQuery({ ...certificatePreconditionQuery(c.e.id), retry: false, refetchOnMount: "always" }));
  const access = freshOnOpen(useQuery(myAccessQuery));
  const current = settings.isSuccess && settings.data !== undefined;
  const configured = current && settings.data.settings_configured === true;
  const settingsRemedy = current && settings.data.reason_code !== "certificate_facts_missing" && access.isSuccess && access.data?.decisions?.certificate_settings_manage === true
    ? <Link to="/people/certificates" search={{ employee: c.e.id }} hash="certificate-settings">{t("empDoc.certificate.settings")}</Link>
    : null;
  const ready = Boolean(configured && kind && items.length && purpose.trim());
  const settingsReason = current && settings.data.reason_code ? certificateError(settings.data.reason_code) : undefined;
  return <Composer open pending={issue.isSending} locked={issue.isChecking} kicker={<Who c={c} />} title={t("empDoc.cert.title")} onClose={onClose}
    action={{ kind: "certificate", mode: "issue" }} incomplete={!ready} dirty={Boolean(kind || items.length || purpose.trim())}
    notice={<CommandError error={issue.error} own={certificateError}>{needsSettings && settingsRemedy}</CommandError>}
    consequence={configured ? <><b>{kind ? t("empDoc.cert.cons", { kind: t(`empDoc.cert.kind.${kind}`), count: items.length }) : t("empDoc.cert.pick")}</b><span>{t("empDoc.certificate.issueEffect")}</span></> : undefined}
    onSubmit={() => { if (kind && ready && !issue.isPending) issue.mutate({ employee_id: c.e.id, kind, items, purpose: purpose.trim() }); }}>
    <Link to="/people/certificates" search={{ employee: c.e.id }}>{t("empDoc.certificate.register")}</Link>
    <QueryState q={settings} own={certificateError} inline>{() => configured ? <>
    <ChipChoice label={t("empDoc.cert.kind")} options={(["EMPLOYMENT", "CAREER", "EXIT"] as const).map((k) => ({ value: k, label: t(`empDoc.cert.kind.${k}`), disabled: k === "EXIT" ? c.e.status !== "EXITED" : k === "EMPLOYMENT" && c.e.status === "EXITED" }))} value={kind} onChange={(v) => { if (v === "EMPLOYMENT" || v === "CAREER" || v === "EXIT") setKind(v); }} />
    <Checks label={t("empDoc.cert.items")} items={ITEMS.map((k) => ({ id: k, label: t(`empDoc.cert.item.${k}`) }))} value={items} onChange={(v) => setItems(v.filter((x): x is typeof ITEMS[number] => ITEMS.some((i) => i === x)))} />
    <Field label={t("empDoc.certificate.purpose")} required>{(p) => <TextInput {...p} maxLength={200} value={purpose} onChange={(e) => setPurpose(e.target.value)} />}</Field>
    <Banner>{t("empDoc.cert.always", { entity: c.place.entity })}</Banner>
    </> : <Banner tone="warn" actions={settingsRemedy}>{settingsReason}</Banner>}</QueryState>
  </Composer>;
}
