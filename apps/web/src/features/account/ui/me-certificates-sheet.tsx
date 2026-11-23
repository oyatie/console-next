// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useEffectEvent, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { PAY_UNIT, label } from "../../../lib/labels";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button, Check, Form } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Dialog } from "../../../ui/dialog";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { PaperGrid, type PaperCell } from "../../../ui/paper/paper-table";
import {
  issueMyCertificate,
  myCertificateQuery,
  myCertificatesQuery,
  selfEditError,
  type Certificate,
  type SelfIssueCertificateRequest,
} from "../api";
import { certificateKindEligible } from "../domain/profile";
import s from "./account.module.css";

const KINDS: readonly SelfIssueCertificateRequest["kind"][] = ["EMPLOYMENT", "CAREER", "EXIT"];
const ITEM_KEYS: readonly SelfIssueCertificateRequest["items"][number][] = [
  "period",
  "duty",
  "position",
  "wage",
  "birth",
];

function CertificatePreview({ cert, onBack }: { cert: Certificate; onBack: () => void }) {
  const f = cert.snapshot;
  const values: Record<(typeof ITEM_KEYS)[number], string> = {
    period: f.period ? t("empDoc.cert.periodValue", { from: fmtDate(f.period.from), to: fmtDate(f.period.to) }) : "—",
    duty: f.duty ?? "—",
    position: f.position ?? "—",
    birth: fmtDate(f.birth),
    wage: f.wage ? t("empDoc.certificate.wage", { won: f.wage.won, unit: label(PAY_UNIT, f.wage.unit) }) : "—",
  };
  const rows: PaperCell[] = [
    [t("empDoc.cert.item.name"), f.name],
    ...cert.items.map((key): PaperCell => [t(`empDoc.cert.item.${key}`), values[key]]),
    [t("empDoc.certificate.purpose"), cert.purpose],
  ];

  return (
    <div className={s.form}>
      <div className={s.contactRowHead}>
        <strong className="t-strong">{t(`empDoc.cert.paper.${cert.kind}`)}</strong>
        <Chip tone={cert.voided_at ? "danger" : "ok"}>
          {t(cert.voided_at ? "empDoc.certificate.voided" : "empDoc.certificate.issued")}
        </Chip>
      </div>
      <div className="t-xs muted num">{t("empDoc.certificate.number", { number: cert.certificate_no })}</div>
      <PaperGrid rows={rows} label={cert.certificate_no} />
      <div className="t-xs">{t("empDoc.certificate.attest")}</div>
      <div className="t-xs muted num">
        {fmtDate(cert.issued_at)} · {f.issuer}
      </div>
      {f.seal_png && <img width={80} height={80} src={f.seal_png} alt={t("empDoc.certificate.sealImage")} />}
      <div className="form__actions">
        <Button type="button" variant="secondary" onClick={onBack}>
          {t("account.certificates.backToList")}
        </Button>
        {!cert.voided_at && (
          <Button type="button" variant="primary" onClick={() => window.print()}>
            {t("account.certificates.print")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function MeCertificatesSheet({
  open,
  employmentStatus,
  onClose,
}: {
  open: boolean;
  employmentStatus?: string | null;
  onClose: () => void;
}) {
  const defaultKind: SelfIssueCertificateRequest["kind"] =
    employmentStatus === "EXITED" ? "EXIT" : "EMPLOYMENT";
  const [kind, setKind] = useState<SelfIssueCertificateRequest["kind"]>(defaultKind);
  const [items, setItems] = useState<SelfIssueCertificateRequest["items"]>(["period", "position"]);
  const [purpose, setPurpose] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Back closes the sheet through the address, not through close(), so a closing by either way clears what it showed.
  const [shownOpen, setShownOpen] = useState(open);
  if (shownOpen !== open) {
    setShownOpen(open);
    if (!open) setSelectedId(null);
  }

  const listQuery = useQuery({
    ...myCertificatesQuery(),
    enabled: open,
    retry: false,
  });

  const detailQuery = useQuery({
    ...myCertificateQuery(selectedId ?? ""),
    enabled: open && Boolean(selectedId),
    retry: false,
  });

  const issue = useCommand({
    run: (body: SelfIssueCertificateRequest, key: string) => issueMyCertificate(body, key),
    invalidates: ["/api/v1/me/certificates"],
    onSuccess: (cert) => {
      setSelectedId(cert.id);
      setPurpose("");
    },
    announce: () => t("account.certificates.issuedSuccess"),
  });

  // A failed issue's notice is gone when the sheet next opens; reset refuses while a sent issue's outcome is unknown.
  const resetIssue = useEffectEvent(() => issue.reset());
  useEffect(() => {
    if (!open) resetIssue();
  }, [open]);

  const close = () => {
    if (!issue.isSending) onClose();
  };

  const toggleItem = (key: SelfIssueCertificateRequest["items"][number], checked: boolean) => {
    setItems((prev) => {
      if (checked) return prev.includes(key) ? prev : [...prev, key];
      return prev.filter((x) => x !== key);
    });
  };

  const canSubmit = items.length > 0 && purpose.trim().length > 0 && certificateKindEligible(kind, employmentStatus);

  return (
    <Dialog open={open} title={t("account.certificates.title")} onClose={close}>
      {selectedId ? (
        <QueryState q={detailQuery} compact own={selfEditError}>
          {(cert) => <CertificatePreview cert={cert} onBack={() => setSelectedId(null)} />}
        </QueryState>
      ) : (
        <div className={s.form}>
          <QueryState
            q={listQuery}
            compact
            own={selfEditError}
            empty={(page) =>
              page.items.length === 0 ? (
                <div className="muted t-sm">{t("account.certificates.empty")}</div>
              ) : null
            }
          >
            {(page) => (
              <ul className="list-divided list-divided--rows" aria-label={t("account.certificates.title")}>
                {page.items.map((item) => (
                  <li key={item.id} className={s.editRow}>
                    <div className={s.editRowBody}>
                      <div className={s.fieldChips}>
                        <strong className="t-sm">{t(`empDoc.cert.kind.${item.kind}`)}</strong>
                        <Chip tone={item.voided_at ? "danger" : "neutral"} className={s.actionBtn}>
                          {t(item.voided_at ? "empDoc.certificate.voided" : "empDoc.certificate.issued")}
                        </Chip>
                      </div>
                      <div className="t-xs muted num">
                        {item.certificate_no} · {fmtDate(item.issued_at)}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className={s.actionBtn}
                      onClick={() => setSelectedId(item.id)}
                    >
                      {t("account.certificates.openPreview")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>

          <Form
            className={s.form}
            aria-busy={issue.isSending}
            onSubmit={() => {
              if (!canSubmit || issue.isPending) return;
              issue.mutate({ kind, items, purpose: purpose.trim() });
            }}
          >
            <strong className="t-sm">{t("account.certificates.issueTitle")}</strong>
            <Field label={t("empDoc.cert.kind")} required>
              {(props) => (
                <SelectInput
                  {...props}
                  value={kind}
                  onChange={(e) => setKind(e.target.value as SelfIssueCertificateRequest["kind"])}
                >
                  {KINDS.map((k) => {
                    const eligible = certificateKindEligible(k, employmentStatus);
                    return (
                      <option key={k} value={k} disabled={!eligible}>
                        {t(`empDoc.cert.kind.${k}`)}
                      </option>
                    );
                  })}
                </SelectInput>
              )}
            </Field>
            <div role="group" aria-label={t("empDoc.cert.items")} className={s.checkList}>
              <div className="t-sm t-medium">{t("empDoc.cert.items")}</div>
              {ITEM_KEYS.map((itemKey) => (
                <Check
                  key={itemKey}
                  checked={items.includes(itemKey)}
                  onChange={(checked) => toggleItem(itemKey, checked)}
                >
                  {t(`empDoc.cert.item.${itemKey}`)}
                </Check>
              ))}
            </div>
            <Field label={t("empDoc.certificate.purpose")} required>
              {(props) => (
                <TextInput
                  {...props}
                  maxLength={200}
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                />
              )}
            </Field>
            <CommandError error={issue.error} own={selfEditError} />
            <div className="form__actions">
              <Button type="button" disabled={issue.isSending} onClick={close}>
                {t("composer.dismiss")}
              </Button>
              <Button type="submit" variant="primary" disabled={!canSubmit || issue.isPending}>
                {t("account.certificates.issueCommit")}
              </Button>
            </div>
          </Form>
        </div>
      )}
    </Dialog>
  );
}
