// SPDX-License-Identifier: LicenseRef-Proprietary
import { t, type MessageId } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Sheet } from "../../../ui/sheet/sheet";
import { Table, type Column } from "../../../ui/table";
import type { PasteRefusal, PasteResult } from "../domain/grid";

export type PastePerson = { employee_id: string; employee_number: string | null; name: string; own: boolean; closed: boolean };
type PreviewRow = { key: string; employeeNumber: string | null; name: string; sourceName: string | null; department: string | null; writable: boolean; values: Record<string, string> };

const refusalKey: Record<PasteRefusal, MessageId> = {
  employeeNumberHeader: "attendanceRecords.paste.refusal.employeeNumberHeader",
  employeeNumberRequired: "attendanceRecords.paste.refusal.employeeNumberRequired",
  dayHeaderRequired: "attendanceRecords.paste.refusal.dayHeaderRequired",
  wrongMonth: "attendanceRecords.paste.refusal.wrongMonth",
  dayOutsideMonth: "attendanceRecords.paste.refusal.dayOutsideMonth",
  duplicateDay: "attendanceRecords.paste.refusal.duplicateDay",
  unlabelledMultiRow: "attendanceRecords.paste.refusal.unlabelledMultiRow",
  unsupportedRowType: "attendanceRecords.paste.refusal.unsupportedRowType",
  clockOutOnly: "attendanceRecords.paste.refusal.clockOutOnly",
  noCells: "attendanceRecords.paste.refusal.noCells",
};

/** Every attendance paste stops here until the user reviews the target people, dates, values, and skipped input. */
export function PastePreviewSheet({ plan, people, month, onClose, onAccept }: { plan: PasteResult; people: readonly PastePerson[]; month: string; onClose: () => void; onAccept: () => void }) {
  const identities = new Map(plan.identities.map((identity) => [identity.r, identity] as const));
  const groups = new Map<string, PreviewRow>();
  for (const cell of plan.cells) {
    const person = people[cell.r];
    if (!person) continue;
    const identity = identities.get(cell.r);
    const row = groups.get(person.employee_id) ?? { key: person.employee_id, employeeNumber: person.employee_number, name: person.name, sourceName: identity?.name || null, department: identity?.department || null, writable: !person.own && !person.closed, values: {} };
    row.values[cell.date] = cell.value;
    groups.set(person.employee_id, row);
  }
  const rows = [...groups.values()];
  const dates = [...new Set(plan.cells.map((cell) => cell.date))].sort();
  const cells = plan.cells.length;
  const writable = plan.cells.filter((cell) => {
    const person = people[cell.r];
    return person && !person.own && !person.closed;
  }).length;
  const accept = !plan.refusal && writable > 0;
  const columns: Column<PreviewRow>[] = [
    { header: t("attendanceRecords.grid.number"), cell: (row) => row.employeeNumber ?? "–", fit: true },
    { header: t("attendanceRecords.paste.preview.name"), cell: (row) => row.sourceName && row.sourceName !== row.name ? `${row.sourceName} → ${row.name}` : row.name },
    { header: t("attendanceRecords.paste.preview.department"), cell: (row) => row.department ?? "–" },
    { header: t("attendanceRecords.paste.preview.status"), cell: (row) => t(row.writable ? "attendanceRecords.paste.preview.writable" : "attendanceRecords.paste.preview.locked"), fit: true },
    ...dates.map((date) => ({ header: date.slice(5), cell: (row: PreviewRow) => row.values[date] ?? "–", fit: true })),
  ];
  return (
    <Sheet
      open
      title={t("attendanceRecords.paste.preview.title")}
      onClose={onClose}
      consequence={t("attendanceRecords.paste.preview.summary", { month, people: rows.length, cells, writable, locked: cells - writable })}
      notice={plan.refusal && <p role="alert">{t(refusalKey[plan.refusal])}</p>}
      actions={
        <>
          <Button onClick={onClose}>{t("attendance.close")}</Button>
          {accept && <Button variant="primary" onClick={onAccept}>{t("attendanceRecords.paste.preview.accept", { cells: writable })}</Button>}
        </>
      }
    >
      <KeyValue items={[
        ...(plan.missing.length ? [{ key: "missing", label: t("attendanceRecords.paste.preview.missing"), value: plan.missing.join(" · ") }] : []),
        ...(plan.ignoredColumns.length ? [{ key: "ignored", label: t("attendanceRecords.paste.preview.ignored"), value: plan.ignoredColumns.join(" · ") }] : []),
      ]} />
      {rows.length > 0 && (
        <Table
          label={t("attendanceRecords.paste.preview.table")}
          rows={rows}
          rowId={(row) => row.key}
          columns={columns}
        />
      )}
    </Sheet>
  );
}
