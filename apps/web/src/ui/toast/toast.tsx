import type { ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import s from "./toast.module.css";

/**
 * The receipt anchor of the record screens (R37): bottom-left, never blocking input. `sending` while the server has not
 * answered (nothing reads as done), then `done` with the undo and its key. Keep it mounted: the region is
 * `role="status"`, so each change is announced politely.
 */
export function Toast({ state, children, actions }: { state: "sending" | "done" | "error"; children: ReactNode; actions?: ReactNode }) {
  return (
    <div role="status" className={s.toast} data-state={state}>
      {state === "sending" ? <Loader2 size={16} aria-hidden className={s.spin} /> : state === "done" ? <Check size={16} aria-hidden /> : null}
      <span className={s.text}>{children}</span>
      {actions}
    </div>
  );
}
