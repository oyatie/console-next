// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { evidenceRecordQuery, evidenceVerificationQuery } from "../api";
import { vaultCode } from "../present";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { authzQuery } from "../../../reference/authz/api";
import { Button } from "../../../ui/button/button";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { EvidenceHolds } from "./evidence-holds";

export function EvidenceRecord({ id }: { id: string }) {
  const detail = useQuery(evidenceRecordQuery(id));
  const auth = useQuery(authzQuery);
  const manage = !auth.isError && auth.data?.capabilities.some(cap => cap.feature === "role_manage" && cap.org_wide && cap.permission !== "request_only");
  const verify = useQuery(evidenceVerificationQuery(id));
  return <QueryState q={detail} layout="record">{data => <>
    <KeyValue items={[
      { key: "stage", label: t("audit.vault.stage"), value: vaultCode(data.object.current_custody_stage) },
      { key: "classification", label: t("audit.vault.classification"), value: vaultCode(data.object.classification) },
      { key: "hold", label: t("audit.vault.hold"), value: vaultCode(data.object.legal_hold_state) },
      { key: "admissibility", label: t("audit.vault.admissibility"), value: vaultCode(data.object.admissibility_status) },
    ]} />
    {data.object.description && <p>{data.object.description}</p>}
    <RecordPaneSection title={t("audit.vault.fixity")} trailing={<Button disabled={verify.isFetching} onClick={() => { void verify.refetch(); }}>{t("audit.vault.verify")}</Button>}>
    {verify.error && <CommandError error={verify.error} own={code => code === "evidence_store_unavailable" ? t("audit.vault.storageUnavailable") : undefined} read />}
    {verify.isSuccess && <div role="status"><strong>{vaultCode(verify.data.outcome)}</strong> · {fmtDateTime(verify.data.verified_at)}
      <ul>{verify.data.copies.map(copy => <li key={copy.copy_id}>{vaultCode(copy.copy_kind)} · {vaultCode(copy.status)}
        <KeyValue density="dense" items={[
          { key: "recorded", label: t("audit.vault.recordedDigest"), value: <code>{copy.recorded_digest_sha256}</code> },
          ...(copy.storage_checksum_sha256 ? [{ key: "observed", label: t("audit.vault.storageDigest"), value: <code>{copy.storage_checksum_sha256}</code> }] : []),
        ]} />
      </li>)}</ul></div>}
    </RecordPaneSection>
    <EvidenceHolds id={id} holds={data.legal_holds} manage={!!manage} />
    <RecordPaneSection title={t("audit.vault.history")}>
    {data.custody_history.length ? <ol>{data.custody_history.map(event =>
      <li key={event.id}><time dateTime={event.occurred_at}>{fmtDateTime(event.occurred_at)}</time> · {vaultCode(event.stage)} · {event.reason}</li>
    )}</ol> : <p>{t("audit.vault.noHistory")}</p>}
    </RecordPaneSection>
  </>}</QueryState>;
}
