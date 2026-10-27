import { useId, type MouseEvent, type ReactNode } from "react";
import s from "./disabled-reason.module.css";

/** What the wrapped control must spread onto itself, after its own props. */
export type DisabledProps = {
  "aria-disabled": true;
  "aria-describedby": string;
  /** Never a submit: Enter in a text field would otherwise fire the form through an inert control. */
  type: "button";
  onClick: (e: MouseEvent) => void;
  className: string | undefined;
};

/**
 * A control that cannot be used now, with the reason under it (never a tooltip, which keyboard and
 * touch cannot reach) and an optional remedy after the reason. The control stays focusable
 * (`aria-disabled`, not `disabled`), so a keyboard or screen-reader user reaches it and hears why.
 * Presses do nothing; the caller's own submit handler still re-checks the hard block.
 * `inline` puts the reason beside the control; `disclosure` reveals it on hover or focus.
 */
export function DisabledReason({ control, reason, remedy, layout = "stacked" }: {
  control: (p: DisabledProps) => ReactNode;
  reason: ReactNode;
  remedy?: ReactNode;
  layout?: "stacked" | "inline" | "disclosure";
}) {
  const id = useId();
  return (
    <span className={s[layout]}>
      {control({ "aria-disabled": true, "aria-describedby": id, type: "button", onClick: (e) => e.preventDefault(), className: s.off })}
      <span className={`${s.why} prose`}>
        <span id={id}>{reason}</span>
        {remedy}
      </span>
    </span>
  );
}
