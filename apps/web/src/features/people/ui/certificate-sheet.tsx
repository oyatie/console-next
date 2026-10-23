// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Checks } from "../../../ui/choice/checks";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { Field, TextInput } from "../../../ui/field/field";
import { Sheet } from "../../../ui/sheet/sheet";
import { issueCertificate, certificateError, type IssueCertificate } from "../api/certificates";
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
  const ready = kind && items.length && purpose.trim();
  return <Sheet open pending={issue.isSending} locked={issue.isChecking} kicker={<Who c={c} />} title={t("empDoc.cert.title")} onClose={onClose}
    notice={<CommandError error={issue.error} own={certificateError} />}
    consequence={<><b>{kind ? t("empDoc.cert.cons", { kind: t(`empDoc.cert.kind.${kind}`), count: items.length }) : t("empDoc.cert.pick")}</b><span>{t("empDoc.certificate.issueEffect")}</span></>}
    actions={<><Button variant="primary" aria-disabled={!ready || issue.isPending} onClick={() => { if (kind && ready && !issue.isPending) issue.mutate({ employee_id: c.e.id, kind, items, purpose: purpose.trim() }); }}>{t("empDoc.cert.commit")}</Button></>}>
    <ChipChoice label={t("empDoc.cert.kind")} options={(["EMPLOYMENT", "CAREER", "EXIT"] as const).map((k) => ({ value: k, label: t(`empDoc.cert.kind.${k}`), disabled: k === "EXIT" ? c.e.status !== "EXITED" : k === "EMPLOYMENT" && c.e.status === "EXITED" }))} value={kind} onChange={(v) => { if (v === "EMPLOYMENT" || v === "CAREER" || v === "EXIT") setKind(v); }} />
    <p>{t("empDoc.cert.request")}</p>
    <Checks label={t("empDoc.cert.items")} items={ITEMS.map((k) => ({ id: k, label: t(`empDoc.cert.item.${k}`) }))} value={items} onChange={(v) => setItems(v.filter((x): x is typeof ITEMS[number] => ITEMS.some((i) => i === x)))} />
    <Field label={t("empDoc.certificate.purpose")} required>{(p) => <TextInput {...p} maxLength={200} value={purpose} onChange={(e) => setPurpose(e.target.value)} />}</Field>
    <Banner>{t("empDoc.cert.always", { entity: c.place.entity })}</Banner>
    <Link to="/people/certificates" search={{ employee: c.e.id }}>{t("empDoc.certificate.register")}</Link>
  </Sheet>;
}
