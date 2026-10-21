import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, History, Info, TriangleAlert } from "lucide-react";
import s from "./banner.module.css";
import { shown } from "../shown";

/** info: a fact or a next step · warn: a caution that does not block · danger: a block or a failure · ok: done · past: an as-of date in the past (read-only). */
export type BannerTone = "info" | "warn" | "danger" | "ok" | "past";

const ICON = { info: Info, warn: TriangleAlert, danger: CircleAlert, ok: CircleCheck, past: History } as const;

/**
 * A tinted message in the flow of a view (components: Banner): what happened or what holds, then its remedies.
 * `placement="page"` is the full-width strip under a page head (as-of past, phase, migration not confirmed); `inline`
 * (the default) is a boxed callout inside a card, sheet or form. The tone is never the only cue: the icon and the
 * words carry it too. `live` announces a banner that appears after an action (polite = status, assertive = alert);
 * a banner that is there on load stays silent. A server refusal with its unblockers is BlockedPanel, not this.
 */
export function Banner({ tone = "info", title, children, actions, placement = "inline", live, id }: {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  placement?: "inline" | "page";
  live?: "polite" | "assertive";
  id?: string;
}) {
  const Icon = ICON[tone];
  const role = live === "assertive" ? "alert" : live === "polite" ? "status" : undefined;
  return (
    <div id={id} className={s.banner} data-tone={tone} data-placement={placement} role={role}>
      <Icon className={s.icon} size={16} aria-hidden />
      <div className={s.body}>
        {shown(title) && <strong className={s.title}>{title}</strong>}
        {/* `prose`: a link in a banner is a link inside running text (design-language §5.4, fe/link-style). */}
        {shown(children) && <div className={`prose ${s.text}`}>{children}</div>}
      </div>
      {shown(actions) && <div className={s.actions}>{actions}</div>}
    </div>
  );
}
