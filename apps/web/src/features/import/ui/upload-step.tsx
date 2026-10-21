import { useRef, useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { pastedWorkbook } from "../../../lib/sheet-paste";
import { FileDrop } from "../../../ui/file-drop/file-drop";
import { MAX_BYTES, preview, refusedKind, sniff } from "../api";
import type { ImportPreview } from "../domain/contract";
import type { WorkbookKind } from "../domain/workbook";
import { importError } from "../present";

/** What was uploaded: kept in memory so a remapped sheet or an expired run is read again without choosing the file twice. */
export type Source = { file: File; start: string; end: string };

const XLSX = [{ mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" }] as const;

/** Why a chosen file cannot be read, in words that say how to get a readable copy (G9: never a dead end). */
function FileProblem({ kind }: { kind: Exclude<WorkbookKind, "xlsx"> }) {
  return (
    <div className="alert" role="alert">
      <strong>{t(`import.${kind}.title`)}</strong>
      <p>{t(`import.${kind}.body`)}</p>
    </div>
  );
}

/** Choose a workbook or paste its rows. A protected workbook is told apart from its first bytes, before upload. */
export function UploadStep({ paste = false, onPreview }: { paste?: boolean; onPreview: (p: ImportPreview, s: Source) => void }) {
  const [mode, setMode] = useState<"file" | "paste">(paste ? "paste" : "file");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const chosen = useRef<File | null>(null);
  const [kind, setKind] = useState<WorkbookKind | null>(null);
  const upload = useCommand({ forget: true, run: async () => {
    const source = mode === "paste" ? await pastedWorkbook(text, t("setup.paste.file")) : file!;
    if (source.size > MAX_BYTES) throw new Error(t("setup.paste.tooLarge"));
    return { p: await preview(source, "", ""), source };
  }, onSuccess: ({ p, source }) => onPreview(p, { file: source, start: "", end: "" }) });
  const choose = async ([f]: File[]) => {
    if (!f || upload.isPending) return;
    chosen.current = f;
    upload.reset();
    setFile(f);
    setKind(null);
    const detected = await sniff(f);
    if (chosen.current === f) setKind(detected);
  };
  // The server tells an unreadable workbook apart too (an upload that skipped the sniff, or a wrapper it missed).
  const refused = refusedKind(upload.error);
  const problem = mode === "file" ? refused ?? (kind && kind !== "xlsx" ? kind : null) : null;
  const blocked = (mode === "paste" ? !text.trim() : !file || kind === null) ? t(mode === "paste" ? "setup.paste.empty" : "import.block.file") : null;

  return (
    <>
      <section className="card panel form" aria-labelledby="import-file-title">
        <h2 id="import-file-title" className="panel__title">{t("import.step.upload")}</h2>
        <fieldset className="form form__group" disabled={upload.isPending}>
        <ChoiceField label={t("setup.paste.source")} required options={[{ value: "file", label: t("setup.path.import") }, { value: "paste", label: t("setup.path.paste") }]} value={mode} onChange={(v) => { if (upload.isPending) return; setMode(v as "file" | "paste"); upload.reset(); }} />
        {mode === "paste" ? <Field label={t("setup.paste.input")} required>
          {(f) => <TextArea {...f} value={text} onChange={(e) => { if (upload.isPending) return; setText(e.target.value); upload.reset(); }} spellCheck={false} />}
        </Field> : <>
        <FileDrop label={t("import.file")} accept={XLSX} maxBytes={MAX_BYTES} onFiles={(f) => void choose(f)} busy={upload.isPending ? t("import.reading") : undefined}>
          {file && <p className="muted">{t("import.chosen", { name: file.name })}</p>}
        </FileDrop>
        </>}
        {problem && <FileProblem kind={problem} />}
        </fieldset>
        {!refused && <CommandError error={upload.error} own={importError} />}
        <div className="form__actions">
          {blocked || problem ? (
            <DisabledReason control={(p) => <Button {...p} variant="primary">{t("import.preview")}</Button>} reason={blocked ?? t(`import.${problem!}.title`)} />
          ) : (
            <Button variant="primary" disabled={upload.isPending} onClick={() => upload.mutate(undefined)}>{t("import.preview")}</Button>
          )}
        </div>
      </section>
    </>
  );
}
