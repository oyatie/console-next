import { useMemo, useState } from "react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { Sheet } from "../../../ui/sheet/sheet";
import { pasteOps, pasteProblems, parseOutline } from "../domain/paste";
import type { ChartNode, Structure } from "../domain/model";
import type { Commands } from "./use-structure-commands";
import css from "./outline.module.css";

/**
 * list paste (MR-30): a list copied from a sheet or a document, indented by tabs, becomes nested department under one
 * place, in row order, in one batch with one undo. Problems are named by line before anything is sent.
 */
export function PasteDialog({ s, parent, cmd, onClose }: { s: Structure; parent: ChartNode; cmd: Commands; onClose: () => void }) {
  const [text, setText] = useState("");
  const lines = useMemo(() => parseOutline(text), [text]);
  const problems = useMemo(() => pasteProblems(lines, new Set(parent.children.map((c) => c.name))), [lines, parent]);
  const deepest = lines.reduce((d, l) => Math.max(d, l.depth + 1), 0);
  const path = [parent.entityId && s.byId.get(parent.entityId)?.name, parent.siteId && parent.siteId !== parent.id && s.byId.get(parent.siteId)?.name, parent.name].filter(Boolean).join(" › ");
  const submit = () =>
    cmd.apply({
      ops: pasteOps(lines, parent.kind === "site" ? { workplace_id: parent.id } : { parent_org_unit_id: parent.id }),
      message: t("structure.paste.receipt", { count: lines.length, parent: parent.name }),
      onDone: onClose,
    });
  const ready = lines.length > 0 && problems.length === 0;
  return (
    <Sheet
      open
      title={t("structure.paste.title")}
      subtitle={t("structure.paste.where", { path })}
      onClose={onClose}
      pending={cmd.pending}
      consequence={lines.length ? t("structure.paste.consequence", { count: lines.length, depth: deepest, parent: parent.name }) : t("structure.paste.empty")}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>{t("structure.cancel")}</Button>
          {ready ? (
            <Button variant="primary" onClick={submit} disabled={cmd.pending}>{t("structure.paste.submit", { count: lines.length })}</Button>
          ) : (
            <DisabledReason control={(p) => <Button variant="primary" {...p}>{t("structure.paste.submitIdle")}</Button>} reason={lines.length ? t("structure.paste.fixFirst", { count: problems.length }) : t("structure.paste.empty")} />
          )}
        </>
      }
    >
      <Field label={t("structure.paste.label")} required hint={t("structure.paste.hint")}>
        {(p) => <TextArea {...p} rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("structure.paste.example")} />}
      </Field>
      {lines.length > 0 && (
        <ol className={css.pasteList} aria-label={t("structure.paste.preview")}>
          {lines.map((l) => {
            const bad = problems.filter((x) => x.line === l.line);
            return (
              <li key={l.line} data-bad={bad.length > 0 || undefined}>
                <span ref={(el) => el?.style.setProperty("padding-left", `${l.depth * 20}px`)}>{l.name}</span>
                <span className="muted">{bad.length ? bad.map((b) => t(`structure.paste.problem.${b.code}`)).join(" · ") : t("structure.paste.new")}</span>
              </li>
            );
          })}
        </ol>
      )}
    </Sheet>
  );
}
