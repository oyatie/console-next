import { useCallback, useState, type ReactNode } from "react";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { focusSoon } from "../../../lib/react/announce";
import { actor } from "../../../lib/labels";
import type { Elsewhere } from "../api";

/**
 * The record's one receipt: what the last command recorded, its follow-up links, and `hold` while the
 * viewer should read it before the next decision re-arms (a decision bar never re-appears under a click).
 */
export type Note = { message: string; actions?: ReactNode; hold?: boolean };

export function useNote() {
  const [note, setNote] = useState<Note>();
  const show = useCallback((n: Note) => {
    setNote(n);
    focusSoon("change-receipt");
  }, []);
  const clear = useCallback(() => setNote(undefined), []);
  return { note, show, clear };
}

/** The receipt when someone else did it first: who and when, never a generic error (3.7). */
export const elsewhereNote = (e: Elsewhere): Note => ({ message: t("live.notice.done_elsewhere", { actor: actor(e.name), time: fmtDateTime(e.at) }) });
