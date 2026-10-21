import type { ReactNode } from "react";
import s from "./action-bar.module.css";
import { shown } from "../shown";

/**
 * The foot of a form, a step or a full page (the sheet foot's anatomy, design-language §4.4): what the server said
 * (`notice`), the `consequence` in numbers, then the `actions` — the one primary last, cancel beside it. `sticky` pins
 * it to the bottom of a full page (wizard, bulk move) so the commit never scrolls away.
 */
export function ActionBar({ consequence, notice, actions, sticky }: { consequence?: ReactNode; notice?: ReactNode; actions: ReactNode; sticky?: boolean }) {
  return (
    <div className={s.bar} data-sticky={sticky || undefined}>
      {notice}
      {shown(consequence) && <div className={s.consequence}>{consequence}</div>}
      <div className={s.actions}>{actions}</div>
    </div>
  );
}
