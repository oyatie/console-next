import { useEffect, useRef, useState } from "react";
import { t } from "@console/i18n";
import { TextInput } from "../../../ui/field/field";
import { Button } from "../../../ui/button/button";
import { OrgNode } from "../../../ui/org-canvas/org-node";
import type { Box } from "../domain/layout";
import { nameClash } from "../domain/rules";
import type { ChartNode } from "../domain/model";
import css from "./chart.module.css";

/**
 * The inline name box (spec S2 *Inline edits*): a new department under `parent` (the ghost box), or a rename in place.
 * Enter saves (and, when adding, keeps the box open for the next one), Esc cancels. A sibling with the same name
 * is refused as typed (I-5), before anything is sent.
 */
export function NameBox({ box, parent, renaming, pending, onSubmit, onCancel }: {
  box: Box;
  parent: ChartNode;
  /** The node renamed in place; absent when adding under `parent`. */
  renaming?: ChartNode;
  pending: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(renaming?.name ?? "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, []);
  const trimmed = name.trim();
  const clash = trimmed && nameClash(parent, trimmed, renaming?.id);
  const label = renaming ? t("structure.edit.renameLabel", { name: renaming.name }) : t("structure.edit.addLabel", { parent: parent.name });
  const submit = () => { if (trimmed && !clash && !pending) onSubmit(trimmed); };
  return (
    <OrgNode level="dept" box={box} states={["edit"]} className={css.nameBox}>
      <span className={css.nameKicker}>{renaming ? t("structure.edit.renameKicker") : t("structure.edit.addKicker", { parent: parent.name })}</span>
      <TextInput
        ref={input}
        aria-label={label}
        aria-invalid={clash ? true : undefined}
        aria-describedby="name-box-hint"
        className={css.nameInput}
        maxLength={120}
        value={name}
        disabled={pending}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => !trimmed && !pending && onCancel()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onCancel();
          if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229 || !trimmed || clash) return;
          if (renaming && trimmed === renaming.name) return onCancel();
          // The text stays until the server has it: a failed save keeps it for the retry (the box remounts empty on success).
          submit();
        }}
      />
      {!renaming && <div className="row"><Button size="sm" variant="primary" disabled={pending} onClick={submit}>{t("orgUnit.add.save")}</Button><Button size="sm" variant="ghost" onClick={onCancel}>{t("structure.cancel")}</Button></div>}
      <span id="name-box-hint" className={clash ? css.nameError : css.nameHint} role={clash ? "alert" : undefined}>
        {clash ? t("structure.edit.clash", { name: trimmed }) : t(renaming ? "structure.edit.renameKeys" : "structure.edit.addKeys")}
      </span>
    </OrgNode>
  );
}
