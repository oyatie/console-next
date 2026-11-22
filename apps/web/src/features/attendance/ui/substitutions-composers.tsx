// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Composer } from "../../../ui/composer/composer";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { TextInput } from "../../../ui/field/text-input";
import { SelectField, type SelectOption } from "../../../ui/select/select-field";
import { assignSubstitution, cancelSubstitution, peopleQuery, substitutionCandidatesQuery } from "../api";

export function AssignSubstitutionComposer({
  date,
  branchId,
  onClose,
}: {
  date: string;
  branchId?: string;
  onClose: () => void;
}) {
  const [coveredSearch, setCoveredSearch] = useState("");
  const [coveredId, setCoveredId] = useState<string | null>(null);
  const [workerId, setWorkerId] = useState<string | null>(null);
  const [site, setSite] = useState("");
  const [role, setRole] = useState("");
  const [reasonKind, setReasonKind] = useState("LEAVE");
  const [fromMinutes, setFromMinutes] = useState("540");
  const [toMinutes, setToMinutes] = useState("1080");

  const coveredPeople = useQuery({ ...peopleQuery(coveredSearch.trim()), enabled: coveredSearch.trim().length > 0 });
  const fromNum = Number(fromMinutes);
  const toNum = Number(toMinutes);
  const candidates = useQuery({
    ...substitutionCandidatesQuery({
      branch_id: branchId ?? "",
      covered_employee_id: coveredId ?? "",
      cover_date: date,
      from_minutes: Number.isFinite(fromNum) ? fromNum : 540,
      to_minutes: Number.isFinite(toNum) ? toNum : 1080,
    }),
    enabled: Boolean(branchId && coveredId && Number.isFinite(fromNum) && Number.isFinite(toNum) && toNum > fromNum),
    retry: false,
  });

  const coveredOptions: SelectOption[] = (coveredPeople.data?.items ?? []).map((p) => ({
    id: p.id,
    label: p.employee_number ? `${p.name} (${p.employee_number})` : p.name,
  }));
  const workerOptions: SelectOption[] = (candidates.data?.items ?? []).map((c) => ({
    id: c.employee_id,
    label: c.employee_name,
  }));

  const cmd = useCommand({
    run: (_input: void, key) =>
      assignSubstitution(
        {
          site: site.trim(),
          ...(branchId ? { branch_id: branchId } : {}),
          role: role.trim(),
          cover_date: date,
          from_minutes: fromNum,
          to_minutes: toNum,
          covered_employee_id: coveredId!,
          reason_kind: reasonKind.trim() || "LEAVE",
          worker_employee_id: workerId!,
        },
        key,
      ),
    invalidates: ["/api/v1/attendance"],
    awaitFirstRead: true,
    announce: () => t("attendance.sub.assignedDone"),
    onSuccess: () => onClose(),
  });

  const blocked = !coveredId || !workerId || !site.trim() || !role.trim() || !Number.isFinite(fromNum) || !Number.isFinite(toNum) || toNum <= fromNum;

  return (
    <Composer
      open
      title={t("attendance.sub.assignButton")}
      subtitle={date}
      action={{ kind: "attendanceSubstitution", mode: "assign" }}
      onClose={onClose}
      pending={cmd.isPending}
      error={cmd.error}
      notice={<CommandError error={cmd.error} />}
      dirty={Boolean(coveredId || workerId || site || role)}
      blocked={blocked ? { reason: t("attendance.issues.missingReason") } : undefined}
      onSubmit={() => {
        cmd.mutate(undefined);
      }}
    >
      <Field label={t("attendance.sub.coveredEmployee")} required>
        {(props) => <TextInput {...props} value={coveredSearch} onChange={(e) => setCoveredSearch(e.target.value)} />}
      </Field>
      <SelectField
        label={t("attendance.sub.coveredEmployee")}
        options={coveredOptions}
        value={coveredId}
        onChange={(id) => {
          setCoveredId(id);
          setWorkerId(null);
        }}
        placeholder={t("attendance.sub.coveredEmployee")}
      />
      <SelectField
        label={t("attendance.sub.workerEmployee")}
        options={workerOptions}
        value={workerId}
        onChange={setWorkerId}
        placeholder={t("attendance.sub.workerEmployee")}
      />
      <Field label={t("attendance.sub.site")} required>
        {(props) => <TextInput {...props} value={site} onChange={(e) => setSite(e.target.value)} />}
      </Field>
      <Field label={t("attendance.sub.role")} required>
        {(props) => <TextInput {...props} value={role} onChange={(e) => setRole(e.target.value)} />}
      </Field>
      <Field label={t("attendance.sub.reasonKind")} required>
        {(props) => <TextInput {...props} value={reasonKind} onChange={(e) => setReasonKind(e.target.value)} />}
      </Field>
      <Field label={t("attendance.sub.fromTime")} required>
        {(props) => <TextInput {...props} type="number" value={fromMinutes} onChange={(e) => setFromMinutes(e.target.value)} />}
      </Field>
      <Field label={t("attendance.sub.toTime")} required>
        {(props) => <TextInput {...props} type="number" value={toMinutes} onChange={(e) => setToMinutes(e.target.value)} />}
      </Field>
    </Composer>
  );
}

export function CancelSubstitutionComposer({
  substitutionId,
  summary,
  onClose,
}: {
  substitutionId: string;
  summary: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const cmd = useCommand({
    run: () => cancelSubstitution(substitutionId, reason.trim()),
    invalidates: ["/api/v1/attendance"],
    awaitFirstRead: true,
    announce: () => t("attendance.sub.cancelledDone"),
    onSuccess: () => onClose(),
  });

  return (
    <Composer
      open
      title={t("attendance.sub.cancelButton")}
      subtitle={summary}
      action={{ kind: "attendanceSubstitution", mode: "cancel" }}
      tone="danger"
      onClose={onClose}
      pending={cmd.isPending}
      error={cmd.error}
      notice={<CommandError error={cmd.error} />}
      dirty={Boolean(reason)}
      blocked={!reason.trim() ? { reason: t("attendance.issues.missingReason") } : undefined}
      onSubmit={() => {
        cmd.mutate(undefined);
      }}
    >
      <Field label={t("attendance.sub.cancelReason")} required>
        {(props) => <TextArea {...props} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </Composer>
  );
}
