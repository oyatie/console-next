// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ButtonHTMLAttributes, Ref } from "react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./button-class";

/**
 * A button for feature views, which may not render raw controls. The label is a verb and its object.
 * `type` defaults to "button", so only an explicit submit submits a form. A hard-blocked command is not
 * this with `disabled`: use DisabledReason, which stays focusable and says why.
 */
export function Button({ variant = "secondary", size, icon, type = "button", className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; icon?: boolean; ref?: Ref<HTMLButtonElement> }) {
  return <button {...rest} type={type} className={buttonClass(variant, { size, icon, className })} />;
}
