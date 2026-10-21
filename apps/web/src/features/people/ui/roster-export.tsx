import { useState } from "react";
import { t } from "@console/i18n";
import { saveFile } from "../../../lib/download";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button, Form } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Dialog } from "../../../ui/dialog";
import { EXPORT_PURPOSES, exportRoster, type ExportPurpose } from "../api";

/**
 * Downloads the roster as it is filtered now. The download's purpose is asked first (none preselected) and the
 * server logs it with the row count before the first byte; the dialog says so. Personal identifiers are never in
 * the file (the server exports canonical directory fields only).
 */
export function RosterExport({ query, total }: { query: object; total: number | undefined }) {
  const [open, setOpen] = useState(false);
  const [purpose, setPurpose] = useState<ExportPurpose | null>(null);
  const [tried, setTried] = useState(false);
  const close = () => {
    setOpen(false);
    setPurpose(null);
    setTried(false);
    run.reset();
  };
  const run = useCommand({
    run: () => exportRoster(query, purpose!),
    onSuccess: (blob) => {
      saveFile(blob, t("roster.export.file", { date: todayKst() }));
      close();
    },
    announce: () => t("roster.export.done", { count: total ?? 0 }),
  });
  const submit = () => {
    setTried(true);
    if (purpose) run.mutate(undefined);
  };
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t("roster.export")}</Button>
      <Dialog open={open} title={t("roster.export.title")} onClose={close} dismissable={!run.isPending}>
        <Form className="form" onSubmit={submit}>
          <ChoiceField
            label={t("roster.export.purpose")}
            required
            options={EXPORT_PURPOSES.map((p) => ({ value: p, label: t(`roster.export.purpose.${p}`) }))}
            value={purpose}
            onChange={(p) => setPurpose(p as ExportPurpose)}
            error={tried && !purpose ? t("roster.export.purpose.pick") : undefined}
          />
          <p id="export-consequence" className="muted">{t("roster.export.consequence", { count: total ?? 0 })}</p>
          <CommandError error={run.error} />
          <div className="row">
            <Button disabled={run.isPending} onClick={close}>{t("common.back")}</Button>
            <Button type="submit" variant="primary" disabled={run.isPending} aria-describedby="export-consequence">{t("roster.export.commit", { count: total ?? 0 })}</Button>
          </div>
        </Form>
      </Dialog>
    </>
  );
}
