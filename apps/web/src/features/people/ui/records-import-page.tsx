// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { downloadCsv } from "../../../lib/csv-download";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import type { ReadState } from "../../../lib/react/query-view";
import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { EXPORT_PURPOSES, type ExportPurpose } from "../../../reference/directory/domain/export";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { TextArea } from "../../../ui/field/text-area";
import { FileDrop, type Accept } from "../../../ui/file-drop/file-drop";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { WizardPattern } from "../../../ui/patterns/wizard";
import { WorklistPadded } from "../../../ui/patterns/worklist-parts";
import { Receipt } from "../../../ui/receipt/receipt";
import { StepLine } from "../../../ui/step-line/step-line";
import { applyRecordImport, exportRecordSheet, previewRecordImport, type RecordImportReport } from "../api/record-import";
import { fromFields, ROW_SPEC } from "../domain/record-spec";
import { IMPORT_SECTIONS, parseSheetText, type ImportableSection, type ParsedSheetRow } from "../domain/records-import-parse";
import { RecordsImportReportCard } from "./records-import-report";

const READY_SHELL: ReadState = { isPending: false, error: null, data: true, refetch: () => Promise.resolve() };
const ACCEPT: readonly Accept[] = [{ mime: "text/csv", ext: ".csv" }, { mime: "text/tab-separated-values", ext: ".tsv" }];
const MAX_BYTES = 4 * 1024 * 1024;
const STEPS = ["input", "preview", "done"] as const;

export function RecordsImportPage() {
  return (
    <AccessGate domain="hr_basic" level="edit" tenant>
      <RecordsImportWizard />
    </AccessGate>
  );
}

function RecordsImportWizard() {
  const [section, setSection] = useState<ImportableSection>("education");
  const [purpose, setPurpose] = useState<ExportPurpose>("INTERNAL_REVIEW");
  const [raw, setRaw] = useState("");
  const [parsedRows, setParsedRows] = useState<ParsedSheetRow[]>([]);
  const [preview, setPreview] = useState<RecordImportReport | null>(null);
  const [applied, setApplied] = useState<RecordImportReport | null>(null);
  const [mismatchAck, setMismatchAck] = useState<string[]>([]);

  const step = applied ? "done" : preview ? "preview" : "input";
  const stepIndex = STEPS.indexOf(step);
  const spec = ROW_SPEC[section] ?? [];
  const sheetHeaders = ["employee_number", "employee_name", "entry_id", "expected_version", "void_reason", ...spec.map((f) => f.key)];
  const parseLabels = {
    numberCol: t("empRec.import.colNumber"),
    nameCol: t("empRec.import.colName"),
    voidCol: t("empRec.void"),
    fieldLabel: (key: string) => t(`empRec.${section}.${key}` as "empRec.education.school"),
  };

  const exportCmd = useCommand({
    run: async () => {
      const sheet = await exportRecordSheet(section, purpose);
      const rows = sheet.items.map((item) => {
        const draft = fromFields(spec, item.entry.fields);
        return [item.employee_number ?? "", item.employee_name, item.entry.id, item.entry.version, "", ...spec.map((f) => draft[f.key] ?? "")];
      });
      downloadCsv(`employee-records-${section}.csv`, sheetHeaders, rows);
      return sheet;
    },
  });

  const previewCmd = useCommand({
    run: async () => {
      const rows = parseSheetText(section, raw, parseLabels);
      setParsedRows(rows);
      const res = await previewRecordImport(section, { rows, acknowledge_name_mismatch: false });
      setPreview(res);
      setApplied(null);
      setMismatchAck([]);
      return res;
    },
  });

  const applyCmd = useCommand({
    run: async (_: undefined, key: string) => {
      if (!preview) throw new Error("missing_preview");
      const res = await applyRecordImport(section, { rows: parsedRows, plan_digest: preview.plan_digest, acknowledge_name_mismatch: mismatchAck.includes("mismatch") }, key);
      setApplied(res);
      return res;
    },
    invalidates: ["/api/v1/employees"],
    announce: (res) =>
      t("empRec.import.appliedReceipt", {
        written: res.rows.filter((r) => ["CREATE", "UPDATE", "VOID"].includes(r.outcome)).length,
        errors: res.rows.filter((r) => r.outcome === "ERROR").length,
      }),
  });

  const report = applied ?? preview;
  const rowsByNumber = new Map(parsedRows.map((r) => [r.row, r]));
  const actionableCount = report?.rows.filter((r) => ["CREATE", "UPDATE", "VOID"].includes(r.outcome)).length ?? 0;
  const errorRows = report?.rows.filter((r) => r.outcome === "ERROR") ?? [];
  const mismatchRows = report?.rows.filter((r) => r.name_mismatch) ?? [];
  const candidateRows = step === "input" ? parseSheetText(section, raw, parseLabels) : parsedRows;
  const canPreview = candidateRows.length > 0 && candidateRows.length <= 1000;
  const applyBlockReason =
    actionableCount === 0
      ? t("empRec.import.noActionable")
      : mismatchRows.length > 0 && !mismatchAck.includes("mismatch")
        ? t("empRec.import.mismatchBlocked", { count: mismatchRows.length })
        : null;

  const downloadErrorRows = () =>
    downloadCsv(
      `employee-records-${section}-skipped.csv`,
      ["row", "employee_number", "employee_name", "stored_name", "outcome", "code", "message"],
      errorRows.map((r) => {
        const src = rowsByNumber.get(r.row);
        return [r.row, src?.employee_number ?? "", src?.employee_name ?? "", r.stored_name ?? "", r.outcome, r.code ?? "", r.message ?? ""];
      }),
    );

  const reset = () => { setPreview(null); setApplied(null); setMismatchAck([]); };
  const commandError = exportCmd.error ?? previewCmd.error ?? applyCmd.error;

  return (
    <WizardPattern
      q={READY_SHELL}
      head={{
        titleId: "records-import-title",
        crumbs: <Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>, <Link key="import" to="/people/import" search={{}}>{t("import.crumb")}</Link>]} current={t("empRec.import.title")} />,
        title: t("empRec.import.title"),
      }}
      steps={<StepLine label={t("import.steps")} steps={STEPS.map((key, i) => ({ key, label: t(`empRec.import.step.${key}`), state: i < stepIndex || step === "done" ? "done" : i === stepIndex ? "current" : "waiting" }))} />}
      notes={
        <>
          {applied && <Receipt state="recorded" message={t("empRec.import.appliedReceipt", { written: actionableCount, errors: errorRows.length })} />}
          {commandError && <CommandError error={commandError} />}
        </>
      }
      body={
        step === "input" || !report ? (
          <Card titleId="records-import-input" title={t("empRec.import.step.input")}>
            <WorklistPadded>
              <div className="form">
                <Field label={t("empRec.import.sectionLabel")} required={true}>
                  {(p) => (
                    <SelectInput {...p} value={section} onChange={(e) => { setSection(e.target.value as ImportableSection); reset(); }}>
                      {IMPORT_SECTIONS.map((sec) => <option key={sec} value={sec}>{t(`empRec.${sec}`)}</option>)}
                    </SelectInput>
                  )}
                </Field>
                <FileDrop label={t("empRec.import.fileLabel")} accept={ACCEPT} maxBytes={MAX_BYTES} onFiles={(files) => { const f = files[0]; if (f) void f.text().then((txt) => setRaw(txt)); }} />
                <Field label={t("empRec.import.pasteLabel")} required={null}>
                  {(p) => <TextArea {...p} rows={8} value={raw} onChange={(e) => setRaw(e.target.value)} />}
                </Field>
              </div>
            </WorklistPadded>
          </Card>
        ) : (
          <RecordsImportReportCard step={step} report={report} parsedRows={parsedRows} mismatchAck={mismatchAck} onMismatchAck={setMismatchAck} />
        )
      }
      aside={
        <Card titleId="records-import-export" title={t("empRec.import.exportTitle")}>
          <WorklistPadded>
            <div className="form">
              <Field label={t("empRec.import.purposeLabel")} required={true}>
                {(p) => (
                  <SelectInput {...p} value={purpose} onChange={(e) => setPurpose(e.target.value as ExportPurpose)}>
                    {EXPORT_PURPOSES.map((code) => <option key={code} value={code}>{code}</option>)}
                  </SelectInput>
                )}
              </Field>
              <div className="row">
                <Button variant="secondary" onClick={() => downloadCsv(`employee-records-${section}-template.csv`, sheetHeaders, [])}>{t("empRec.import.templateAction")}</Button>
                <Button variant="secondary" disabled={exportCmd.isPending} onClick={() => exportCmd.mutate(undefined)}>{t("empRec.import.exportAction")}</Button>
              </div>
            </div>
          </WorklistPadded>
        </Card>
      }
      asideLabel={t("empRec.import.exportTitle")}
      actions={
        step === "input" ? (
          <>
            <Link to="/people/import" search={{}} className={buttonClass("secondary")}>{t("importJob.toRoster")}</Link>
            {canPreview ? <Button variant="primary" disabled={previewCmd.isPending} onClick={() => previewCmd.mutate(undefined)}>{t("empRec.import.previewAction")}</Button> : <DisabledReason reason={t("empRec.import.emptyRows")} control={(p) => <Button {...p} variant="primary">{t("empRec.import.previewAction")}</Button>} />}
          </>
        ) : step === "preview" ? (
          <>
            <Button variant="secondary" onClick={reset}>{t("import.otherFile")}</Button>
            {errorRows.length > 0 && <Button variant="secondary" onClick={downloadErrorRows}>{t("empRec.import.downloadSkippedCsv", { count: errorRows.length })}</Button>}
            {applyBlockReason ? <DisabledReason reason={applyBlockReason} control={(p) => <Button {...p} variant="primary">{t("empRec.import.applyAction", { count: actionableCount })}</Button>} /> : <Button variant="primary" disabled={applyCmd.isPending} onClick={() => applyCmd.mutate(undefined)}>{t("empRec.import.applyAction", { count: actionableCount })}</Button>}
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={reset}>{t("import.again")}</Button>
            {errorRows.length > 0 && <Button variant="secondary" onClick={downloadErrorRows}>{t("empRec.import.downloadSkippedCsv", { count: errorRows.length })}</Button>}
            <Link to="/people" search={{}} className={buttonClass("primary")}>{t("import.viewEmployees")}</Link>
          </>
        )
      }
    />
  );
}
