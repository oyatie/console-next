// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ButtonHTMLAttributes, Ref } from "react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./button-class";

/**
 * A button for feature views, which may not render raw controls. The label is a verb and its object.
 * `type` defaults to "button", so only an explicit submit submits a form. A hard-blocked command is not
 * this with `disabled`: use DisabledReason, which stays focusable and says why.
 */
export function Button({
  variant = "secondary",
  size,
  icon,
  block,
  pending,
  type = "button",
  className,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: boolean;
  /** Stretch across the container width with centered content. */
  block?: boolean;
  /** Busy command state: marks `aria-disabled="true"` and suppresses clicks while keeping keyboard focus on the button. */
  pending?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      {...rest}
      type={type}
      aria-disabled={pending ? true : rest["aria-disabled"]}
      data-pending={pending || undefined}
      onClick={event => {
        if (pending) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      className={buttonClass(variant, { size, icon, block, className })}
    />
  );
}

/**
 * An icon-only button (a close, a row overflow, a zoom step): square, its name in `label` (the accessible name and the
 * tooltip). Never for a destructive act, which always says what it does in words.
 */
export function IconButton({ label, variant = "ghost", ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> & { label: string; variant?: Exclude<ButtonVariant, "danger" | "ghost-danger">; size?: ButtonSize; ref?: Ref<HTMLButtonElement> }) {
  return <Button {...rest} variant={variant} icon aria-label={label} title={label} />;
}
