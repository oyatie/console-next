// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Composer } from "../../../ui/composer/composer";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { TextInput } from "../../../ui/field/text-input";
import { SelectField, type SelectOption } from "../../../ui/select/select-field";
import { peopleQuery, raiseException, resolveException } from "../api";

type ExceptionRow = components["schemas"]["AttendanceException"];
type ExceptionKind = components["schemas"]["RaiseAttendanceExceptionRequest"]["kind"];

const KINDS: readonly ExceptionKind[] = ["LATE", "NO_SHOW", "UNAPPROVED_OVERTIME", "EARLY_LEAVE"];

export function RaiseExceptionSheet({
  defaultBranchId,
  onClose,
}: {
  defaultBranchId?: string;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [kind, setKind] = useState<ExceptionKind>("LATE");
  const [workDate, setWorkDate] = useState(todayKst());
  const [detail, setDetail] = useState("");
  const people = useQuery({ ...peopleQuery(search.trim()), enabled: search.trim().length > 0 });

  const peopleOptions: SelectOption[] = (people.data?.items ?? []).map((p) => ({
    id: p.id,
    label: p.employee_number ? `${p.name} (${p.employee_number})` : p.name,
  }));
  const kindOptions: SelectOption[] = KINDS.map((k) => ({ id: k, label: t(`attendance.exception.${k}`) }));

  const cmd = useCommand({
    run: (_input: void, key) =>
      raiseException(
        {
          kind,
          employee_id: employeeId!,
          ...(defaultBranchId ? { branch_id: defaultBranchId } : {}),
          work_date: workDate,
          detail: detail.trim(),
        },
        key,
      ),
    invalidates: ["/api/v1/attendance"],
    awaitFirstRead: true,
    announce: () => t("attendance.issues.raisedDone"),
    onSuccess: () => onClose(),
  });

  const blocked = !employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate) || !detail.trim();

  return (
    <Composer
      open
      title={t("attendance.issues.raiseTitle")}
      action={{ kind: "attendanceException", mode: "record" }}
      onClose={onClose}
      pending={cmd.isPending}
      error={cmd.error}
      notice={<CommandError error={cmd.error} />}
      dirty={Boolean(employeeId || detail)}
      blocked={blocked ? { reason: t("attendance.issues.missingReason") } : undefined}
      onSubmit={() => {
        cmd.mutate(undefined);
      }}
    >
      <Field label={t("attendance.issues.employeeSearch")} required>
        {(props) => (
          <TextInput
            {...props}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("attendance.issues.employeeSearch")}
          />
        )}
      </Field>
      <SelectField
        label={t("attendance.issues.employeeSearch")}
        options={peopleOptions}
        value={employeeId}
        onChange={setEmployeeId}
        placeholder={t("attendance.issues.employeeSearch")}
      />
      <SelectField
        label={t("attendance.col.kind")}
        options={kindOptions}
        value={kind}
        onChange={(next) => {
          if ((KINDS as readonly string[]).includes(next)) setKind(next as ExceptionKind);
        }}
        placeholder={t("attendance.col.kind")}
      />
      <Field label={t("attendance.issues.workDate")} required>
        {(props) => <TextInput {...props} value={workDate} onChange={(e) => setWorkDate(e.target.value)} placeholder="YYYY-MM-DD" />}
      </Field>
      <Field label={t("attendance.issues.detail")} required>
        {(props) => <TextArea {...props} value={detail} onChange={(e) => setDetail(e.target.value)} />}
      </Field>
    </Composer>
  );
}

export function ResolveExceptionSheet({
  exception,
  onClose,
}: {
  exception: ExceptionRow;
  onClose: () => void;
}) {
  const isOvertime = exception.kind === "UNAPPROVED_OVERTIME";
  const action = isOvertime ? "APPROVE_OVERTIME" : "CONFIRM";
  const [reason, setReason] = useState("");
  const [linkedWorkRef, setLinkedWorkRef] = useState("");
  const [otHours, setOtHours] = useState("1");

  const parsedHours = Number(otHours);
  const validOvertime = !isOvertime || (linkedWorkRef.trim().length > 0 && Number.isFinite(parsedHours) && parsedHours > 0);
  const blockedReason = !reason.trim()
    ? t("attendance.issues.missingReason")
    : !validOvertime
      ? t("attendance.issues.invalidOvertime")
      : null;

  const cmd = useCommand({
    run: () =>
      resolveException(exception.id, {
        action,
        reason: reason.trim(),
        linked_work_ref: isOvertime ? linkedWorkRef.trim() : null,
        ot_hours: isOvertime ? parsedHours : null,
      }),
    invalidates: ["/api/v1/attendance"],
    awaitFirstRead: true,
    announce: () => t("attendance.issues.resolvedDone"),
    onSuccess: () => onClose(),
  });

  return (
    <Composer
      open
      title={t("attendance.issues.resolveTitle")}
      subtitle={`${exception.employee_name} · ${t(`attendance.exception.${exception.kind}`)}`}
      action={{ kind: "attendanceException", mode: "complete" }}
      onClose={onClose}
      pending={cmd.isPending}
      error={cmd.error}
      notice={<CommandError error={cmd.error} />}
      consequence={t(`attendance.issues.action.${action}`)}
      dirty={Boolean(reason || linkedWorkRef)}
      blocked={blockedReason ? { reason: blockedReason } : undefined}
      onSubmit={() => {
        cmd.mutate(undefined);
      }}
    >
      {isOvertime && (
        <>
          <Field label={t("attendance.issues.linkedWorkRef")} required>
            {(props) => <TextInput {...props} value={linkedWorkRef} onChange={(e) => setLinkedWorkRef(e.target.value)} />}
          </Field>
          <Field label={t("attendance.issues.otHours")} required>
            {(props) => <TextInput {...props} type="number" step="0.5" min="0.5" value={otHours} onChange={(e) => setOtHours(e.target.value)} />}
          </Field>
        </>
      )}
      <Field label={t("attendance.issues.resolveReason")} required>
        {(props) => <TextArea {...props} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </Composer>
  );
}
