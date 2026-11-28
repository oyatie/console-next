// SPDX-License-Identifier: LicenseRef-Proprietary
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { isMessageId, t } from "@console/i18n";
import { announce } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { personName } from "../../../reference/person/present";
import { Button, Form } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Checks } from "../../../ui/choice/checks";
import { Chip } from "../../../ui/chip";
import { Dialog } from "../../../ui/dialog";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field, TextInput } from "../../../ui/field/field";
import { KeyValue } from "../../../ui/key-value/key-value";
import { SelectField } from "../../../ui/select/select-field";
import {
  activeGrantsQuery,
  candidateUsersQuery,
  designateOpsHolder,
  opsHoldersQuery,
  recoveryStatusQuery,
  regenerateMyRecoveryCodes,
  releaseSelfOpsHolder,
  saveMyRecoveryContact,
} from "../api";
import { useOpsGroupInvitesItem } from "./ops-group-invites";
import s from "./account.module.css";

const ownCode = (code: string | undefined) => {
  const key = code ? `account.opsSecurity.code.${code}` : "";
  return key && isMessageId(key) ? t(key) : undefined;
};

export function OpsSecurityBody({ myId }: { myId: string }) {
  const consentId = useId();
  const recQ = useQuery(recoveryStatusQuery);
  const opsQ = useQuery(opsHoldersQuery);
  const groupInvitesItem = useOpsGroupInvitesItem();
  const [modal, setModal] = useState<"contact" | "designate" | "release" | null>(null);
  const [contactVal, setContactVal] = useState("");
  const [consent, setConsent] = useState<string[]>([]);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [releaseReason, setReleaseReason] = useState("");
  const [issuedCodes, setIssuedCodes] = useState<string[] | null>(null);
  const usersQ = useQuery({ ...candidateUsersQuery, enabled: modal === "designate" });
  const grantsQ = useQuery({ ...activeGrantsQuery, enabled: modal === "designate" });

  const saveContact = useCommand({
    run: () => saveMyRecoveryContact(contactVal.trim()),
    invalidates: ["/api/v1/auth/recovery/status", "/api/v1/access/ops"],
    onSuccess: () => {
      setModal(null);
      setContactVal("");
      setConsent([]);
      announce(t("account.opsSecurity.contactSaved"));
    },
  });

  const regenCodes = useCommand({
    run: () => regenerateMyRecoveryCodes(),
    invalidates: ["/api/v1/auth/recovery/status", "/api/v1/access/ops"],
    onSuccess: (batch) => setIssuedCodes(batch.codes),
    forget: true,
  });

  const holders = opsQ.data?.holders ?? [];
  const holderIds = new Set(holders.map((h) => h.account_id));
  const grantRows = Array.isArray(grantsQ.data) ? grantsQ.data : [];
  const grantedIds = new Set(grantRows.map((g) => g.account_id));
  const candidates = (usersQ.data?.items ?? []).filter(
    (u) => u.is_active && !u.is_tenant_ops && !holderIds.has(u.id) && u.has_passkey && !grantedIds.has(u.id),
  );
  const selectedCandidate = candidates.find((c) => c.id === candidateId);

  const designate = useCommand({
    run: () => designateOpsHolder(candidateId!),
    invalidates: ["/api/v1/access/ops", "/api/v1/auth/recovery/status", "/api/v1/directory", "/api/v1/users"],
    onSuccess: () => {
      const targetName = personName(selectedCandidate?.display_name);
      setModal(null);
      setCandidateId(null);
      announce(t("account.opsSecurity.designated", { name: targetName }));
    },
  });

  const release = useCommand({
    run: () => releaseSelfOpsHolder(releaseReason),
    invalidates: ["/api/v1/access/ops", "/api/v1/auth/recovery/status", "/api/v1/users/me", "/api/v1/access/me"],
    onSuccess: () => {
      setModal(null);
      setReleaseReason("");
      announce(t("account.opsSecurity.released"));
    },
  });

  const rec = recQ.data;
  const maxHolders = opsQ.data?.max_holders ?? rec?.max_holders ?? 2;
  const holderCount = holders.length || (rec?.holder_count ?? 1);
  const contact = rec?.contact;
  const codes = rec?.codes;

  const items = [
    {
      key: "contact",
      label: t("account.opsSecurity.contact"),
      value: (
        <div className="row">
          <span>{contact ? contact.masked_value : t("account.opsSecurity.contactUnset")}</span>
          {contact?.channel === "PHONE" && <span>{t("auth.setup.recovery.replacePhone")}</span>}
          {contact?.review_pending && <Chip>{t("auth.setup.recovery.reviewPending")}</Chip>}
          <Button size="sm" variant="ghost" onClick={() => setModal("contact")}>
            {t(contact ? "account.opsSecurity.contactEdit" : "account.opsSecurity.contactSet")}
          </Button>
        </div>
      ),
    },
    {
      key: "codes",
      label: t("account.opsSecurity.codes"),
      value: (
        <div className="row">
          <span>
            {codes?.generated_at
              ? t("account.opsSecurity.codesRemaining", { remaining: codes.remaining, total: codes.total })
              : t("account.opsSecurity.codesUnset")}
          </span>
          <Button size="sm" variant="ghost" disabled={regenCodes.isPending} onClick={() => regenCodes.mutate(undefined)}>
            <KeyRound size={14} aria-hidden /> {t("account.opsSecurity.codesRegenerate")}
          </Button>
        </div>
      ),
    },
    {
      key: "holders",
      label: t("account.opsSecurity.holders"),
      value: (
        <div className="form">
          <div className="row">
            <Chip tone="info">{t("account.opsSecurity.holdersCount", { count: holderCount })}</Chip>
            {holderCount >= maxHolders ? (
              <DisabledReason
                reason={t("account.opsSecurity.limitReached")}
                control={(p) => <Button size="sm" {...p}>{t("account.opsSecurity.designate")}</Button>}
              />
            ) : (
              <Button size="sm" onClick={() => setModal("designate")}>
                {t("account.opsSecurity.designate")}
              </Button>
            )}
          </div>
          {holders.map((h) => (
            <div key={h.account_id} className="row">
              <strong>{personName(h.display_name)}</strong>
              {h.sign_in_id && <span className="code muted">{h.sign_in_id}</span>}
              {h.account_id === myId && (
                holderCount <= 1 ? (
                  <DisabledReason
                    reason={t("account.opsSecurity.releaseLastDisabled")}
                    control={(p) => <Button size="sm" variant="ghost-danger" {...p}>{t("account.opsSecurity.release")}</Button>}
                  />
                ) : (
                  <Button size="sm" variant="ghost-danger" onClick={() => setModal("release")}>
                    {t("account.opsSecurity.release")}
                  </Button>
                )
              )}
            </div>
          ))}
        </div>
      ),
    },
  ];

  return (
    <>
      <KeyValue items={groupInvitesItem ? [...items, groupInvitesItem] : items} />
      <PasskeyError error={regenCodes.error} own={ownCode} />

      {modal === "contact" && (
        <Dialog open title={t(contact ? "account.opsSecurity.contactEdit" : "account.opsSecurity.contactSet")} onClose={() => setModal(null)} dismissable={!saveContact.isPending}>
          <Form className="form" onSubmit={() => contactVal.trim() && consent.includes("recovery") && saveContact.mutate(undefined)}>
            <Field label={t("auth.setup.recovery.channel.EMAIL")} required>
              {(p) => (
                <TextInput
                  {...p}
                  type="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={contactVal}
                  onChange={(e) => setContactVal(e.target.value)}
                />
              )}
            </Field>
            <Checks
              label={t("account.opsSecurity.contact")}
              items={[{ id: "recovery", label: t("auth.setup.recovery.consent"), description: consentId }]}
              value={consent}
              onChange={setConsent}
            />
            <p className="muted" id={consentId}>{t("auth.setup.recovery.consentBody")}</p>
            <PasskeyError error={saveContact.error} own={ownCode} />
            <div className="form__actions">
              <Button onClick={() => setModal(null)} disabled={saveContact.isPending}>{t("common.back")}</Button>
              <Button type="submit" variant="primary" disabled={saveContact.isPending || !contactVal.trim() || !consent.includes("recovery")}>
                <KeyRound size={16} aria-hidden /> {t(contact ? "account.opsSecurity.contactEdit" : "account.opsSecurity.contactSet")}
              </Button>
            </div>
          </Form>
        </Dialog>
      )}

      {modal === "designate" && (
        <Dialog open title={t("account.opsSecurity.designateTitle")} onClose={() => setModal(null)} dismissable={!designate.isPending}>
          <div className="form">
            {candidates.length === 0 ? (
              <p className="muted">{t("account.opsSecurity.designateNone")}</p>
            ) : (
              <SelectField
                label={t("account.opsSecurity.designatePick")}
                placeholder={t("account.opsSecurity.designatePick")}
                options={candidates.map((c) => ({
                  id: c.id,
                  label: c.sign_in_id ? `${personName(c.display_name)} (${c.sign_in_id})` : personName(c.display_name),
                }))}
                value={candidateId}
                onChange={(v) => setCandidateId(v || null)}
              />
            )}
            {selectedCandidate && (
              <p className="muted">{t("account.opsSecurity.designateConsequence", { name: personName(selectedCandidate.display_name) })}</p>
            )}
            <PasskeyError error={designate.error} own={ownCode} />
            <div className="form__actions">
              <Button onClick={() => setModal(null)} disabled={designate.isPending}>{t("common.back")}</Button>
              <Button variant="primary" disabled={designate.isPending || !candidateId} onClick={() => designate.mutate(undefined)}>
                <KeyRound size={16} aria-hidden /> {t("account.opsSecurity.designateCommit")}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {modal === "release" && (
        <Dialog open title={t("account.opsSecurity.releaseTitle")} onClose={() => setModal(null)} dismissable={!release.isPending}>
          <div className="form">
            <p className="muted">{t("account.opsSecurity.releaseConsequence")}</p>
            <Field label={t("account.opsSecurity.releaseReason")} required={false}>
              {(p) => <TextInput {...p} maxLength={200} value={releaseReason} onChange={(e) => setReleaseReason(e.target.value)} />}
            </Field>
            <PasskeyError error={release.error} own={ownCode} />
            <div className="form__actions">
              <Button onClick={() => setModal(null)} disabled={release.isPending}>{t("common.back")}</Button>
              <Button variant="danger" disabled={release.isPending} onClick={() => release.mutate(undefined)}>
                <KeyRound size={16} aria-hidden /> {t("account.opsSecurity.releaseCommit")}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {issuedCodes && (
        <Dialog open title={t("auth.setup.recovery.codesTitle")} onClose={() => setIssuedCodes(null)} dismissable={false}>
          <p className="muted">{t("auth.setup.recovery.codesOnce")}</p>
          <pre className="secret">{issuedCodes.join("\n")}</pre>
          <div className="form__actions">
            <Button
              onClick={() =>
                void navigator.clipboard
                  .writeText(issuedCodes.join("\n"))
                  .then(() => announce(t("auth.setup.recovery.copiedAll")), () => announce(t("common.copyFailed")))
              }
            >
              {t("auth.setup.recovery.copyAll")}
            </Button>
            <Button variant="primary" onClick={() => setIssuedCodes(null)}>
              {t("auth.setup.recovery.savedAck")}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

export function OpsSecurityCard({ myId }: { myId: string }) {
  return (
    <Card title={t("account.opsSecurity.title")} titleId="account-ops-security">
      <div className={s.pad}>
        <OpsSecurityBody myId={myId} />
      </div>
    </Card>
  );
}
