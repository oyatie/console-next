// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { PAY_UNIT, label } from "../../../lib/labels";
import { Paper, PaperHead, PaperSeal, PaperVoid } from "../../../ui/paper/paper";
import { PaperGrid, type PaperCell } from "../../../ui/paper/paper-table";
import type { Certificate } from "../api/certificates";

/** Rendering is confined to the frozen requested fields, including on a later reprint. */
export function CertificatePaper({ certificate: c }: { certificate: Certificate }) {
  const f = c.snapshot;
  const values = {
    period: f.period ? t("empDoc.cert.periodValue", { from: fmtDate(f.period.from), to: fmtDate(f.period.to) }) : "—",
    duty: f.duty ?? "—", position: f.position ?? "—", birth: fmtDate(f.birth),
    wage: f.wage ? t("empDoc.certificate.wage", { won: f.wage.won, unit: label(PAY_UNIT, f.wage.unit) }) : "—",
  };
  const rows: PaperCell[] = [[t("empDoc.cert.item.name"), f.name], ...c.items.map((key): PaperCell => [t(`empDoc.cert.item.${key}`), values[key]]), [t("empDoc.certificate.purpose"), c.purpose]];
  return <Paper size="a4" label={c.certificate_no}>
    <PaperHead title={t(`empDoc.cert.paper.${c.kind}`)} />
    <p>{t("empDoc.certificate.number", { number: c.certificate_no })}</p>
    {c.voided_at && <PaperVoid>{t("empDoc.certificate.voided")} · {c.void_reason}</PaperVoid>}
    <PaperGrid rows={rows} />
    <p>{t("empDoc.certificate.attest")}</p>
    <p>{fmtDate(c.issued_at)}</p>
    <PaperSeal label={t("empDoc.certificate.sealImage")} image={f.seal_png}><p>{f.issuer}</p><p>{f.seal_text}</p></PaperSeal>
  </Paper>;
}
