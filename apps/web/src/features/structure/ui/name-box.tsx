import { useInlineUnitValues } from "../../../reference/org/ui/use-inline-unit-values";
import type { InlineUnitValues } from "../../../reference/org/api";
import { useEffect, useRef, useState } from "react";
import { t } from "@console/i18n";
import { InlineUnitFields } from "../../../reference/org/ui/inline-unit-fields";
import { TextInput } from "../../../ui/field/field";
import { Button } from "../../../ui/button/button";
import { OrgNode } from "../../../ui/org-canvas/org-node";
import { EDITOR_SIZE, type Box } from "../domain/layout";
import { nameClash } from "../domain/rules";
import type { ChartNode } from "../domain/model";
import css from "./chart.module.css";

/**
 * The inline name box (spec S2 *Inline edits*): a new department under `parent` (the ghost box), or a rename in place.
 * Enter saves (and, when adding, keeps the box open for the next one), Esc cancels. A sibling with the same name
 * is refused as typed (I-5), before anything is sent.
 */
export function NameBox({ box, parent, renaming, setup = true, asOf, pending, onSubmit, onCancel }: {
  box: Box;
  parent: ChartNode;
  /** The node renamed in place; absent when adding under `parent`. */
  renaming?: ChartNode;
  setup?: boolean;
  asOf?: string;
  pending: boolean;
  onSubmit: (name: string, values: InlineUnitValues, done: () => void) => void;
  onCancel: () => void;
}) {
  const state = useInlineUnitValues(setup, asOf);
  const [baseParent, setBaseParent] = useState(parent);
  if (!pending && baseParent !== parent) setBaseParent(parent);
  const [baseRenaming] = useState(renaming);
  const [name, setName] = useState(baseRenaming?.name ?? "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, []);
  const trimmed = name.trim();
  // The refreshed tree can contain our new name before the save finishes and opens an empty box.
  const clash = !pending && trimmed && nameClash(baseParent, trimmed, baseRenaming?.id);
  const label = baseRenaming ? t("structure.edit.renameLabel", { name: baseRenaming.name }) : t("structure.edit.addLabel", { parent: baseParent.name });
  const submit = (send = true) => {
    if (baseRenaming && trimmed === baseRenaming.name) return onCancel();
    if (trimmed && !clash && !pending && state.valid) onSubmit(trimmed, { ...state.values, submit: send }, () => setName(""));
  };
  return (
    <OrgNode level="dept" box={{ ...box, w: Math.max(box.w, EDITOR_SIZE.w), h: Math.max(box.h, EDITOR_SIZE.h) }} states={["edit"]} className={css.nameBox}>
      <span className={css.nameKicker}>{baseRenaming ? t("structure.edit.renameKicker") : t("structure.edit.addKicker", { parent: baseParent.name })}</span>
      <TextInput
        ref={input}
        aria-label={label}
        aria-invalid={clash ? true : undefined}
        aria-describedby="name-box-hint"
        className={css.nameInput}
        maxLength={120}
        value={name}
        readOnly={pending}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onCancel();
          if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229 || !trimmed || clash) return;
          submit();
        }}
      />
      <div className="row">
        <InlineUnitFields setup={setup} state={state} pending={pending} onDraft={() => submit(false)} />
        <Button size="sm" variant="primary" disabled={pending || !state.valid} onClick={() => submit()}>{t(baseRenaming ? "orgUnit.rename.save" : "orgUnit.add.save")}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>{t("structure.cancel")}</Button>
      </div>
      <span id="name-box-hint" className={clash ? css.nameError : css.nameHint} role={clash ? "alert" : undefined}>
        {clash ? t("structure.edit.clash", { name: trimmed }) : t(baseRenaming ? "structure.edit.renameKeys" : "structure.edit.addKeys")}
      </span>
    </OrgNode>
  );
}
