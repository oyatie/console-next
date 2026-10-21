import type { ReactNode } from "react";
import { Clock, History, MoreHorizontal, ShieldCheck, Stamp, UserCheck, Zap } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../button/button";
import { DisabledReason } from "../disabled-reason/disabled-reason";
import { MenuButton, type MenuEntry } from "../menu/menu-button";
import s from "./record-actions.module.css";

/**
 * Which way a change is recorded (docs/design/record-actions.md §4), said on the action before it commits:
 * `setup` applies at once in the setup phase (a mistaken record can still be deleted); `revision` applies at once as a
 * dated revision; `correction` applies at once as a correction record; `approval` waits for the approval route; `second`
 * for a second person; `stepUp` for the actor's passkey. After go-live nothing is overwritten or hard-deleted.
 */
export type ChangePath = "setup" | "revision" | "correction" | "approval" | "second" | "stepUp";

const ICON = { setup: Zap, revision: Clock, correction: Stamp, approval: ShieldCheck, second: UserCheck, stepUp: ShieldCheck } as const;

/** The path line: one sentence, before the commit (in a sheet foot, under a row editor, beside an end verb). */
export function PathNote({ path, id }: { path: ChangePath; id?: string }) {
  const Icon = ICON[path];
  return (
    <span className={s.path} data-k={path} id={id}>
      <Icon size={12} aria-hidden /> {t(`uiRecordActions.path.${path}`)}
    </span>
  );
}

/** How a row's value ends: deleted (setup, nothing depends on it), voided, or cleared; `why` says why it cannot now. */
type RowEnd = { verb: "delete" | "void" | "clear"; onPress: () => void; why?: ReactNode };

/**
 * One fact's or one row's actions (docs/design/record-actions.md §3): edit on the value it edits, then the overflow menu with its
 * history and its end verb. Every control's accessible name carries the object ("emergency contact edit"), so the action is
 * found from the value's own row by its name. `path` says, beside edit, which way the edit is recorded.
 */
export function RowActions({ field, onEdit, edit = "edit", path, history, end, why }: {
  /** The value's label as its row shows it. */
  field: string;
  onEdit?: () => void;
  /** `add` for a list row's first entry. */
  edit?: "edit" | "add";
  path?: ChangePath;
  history?: () => void;
  end?: RowEnd;
  /** The edit cannot be used now: why and how to unblock, beside it (never a tooltip). */
  why?: ReactNode;
}) {
  const items: MenuEntry[] = [];
  if (history) items.push({ id: "history", text: t("uiRecordActions.history"), label: <><History size={14} aria-hidden /> {t("uiRecordActions.history")}</> });
  if (end) items.push({ id: "end", text: t(`uiRecordActions.end.${end.verb}`), label: t(`uiRecordActions.end.${end.verb}`), why: end.why });
  const verb = t(`uiRecordActions.${edit}`);
  return (
    <span className={s.row}>
      {onEdit &&
        (why ? (
          <DisabledReason layout="inline" reason={why} control={(p) => <Button variant="ghost" size="sm" aria-label={t("uiRecordActions.of", { field, verb })} {...p}>{verb}</Button>} />
        ) : (
          <Button variant="ghost" size="sm" aria-label={t("uiRecordActions.of", { field, verb })} title={path ? t(`uiRecordActions.path.${path}`) : undefined} onClick={onEdit}>{verb}</Button>
        ))}
      {items.length > 0 && (
        <MenuButton label={t("uiRecordActions.more", { field })} icon={<MoreHorizontal size={14} aria-hidden />} caret={false} items={items} onAction={(k) => (k === "history" ? history?.() : end?.onPress())} />
      )}
    </span>
  );
}

/** A list's head (docs/design/record-actions.md §1): its title and count, then its one add. */
export function ListAdd({ object, onAdd, why }: { object: string; onAdd: () => void; why?: ReactNode }) {
  const name = t("uiRecordActions.addOf", { object });
  return why ? (
    <DisabledReason layout="inline" reason={why} control={(p) => <Button variant="ghost" size="sm" {...p}>{name}</Button>} />
  ) : (
    <Button variant="ghost" size="sm" onClick={onAdd}>{name}</Button>
  );
}
