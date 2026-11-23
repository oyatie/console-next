// SPDX-License-Identifier: LicenseRef-Proprietary
import type { InputHTMLAttributes, Ref } from "react";
import { isImeKey, leaveImeKey } from "../../lib/pure/ime";

/**
 * A text input that never submits its form on Enter: free text is not a commit gesture, and an Enter
 * that ends Korean IME composition (isComposing / keyCode 229) is left to the IME. So are an Escape and a Tab pressed
 * while a syllable is composing: the caller's handler and the bubble-phase handlers above do not see them (leaveImeKey
 * says what still does, and why such a Tab may move focus on). A plain Escape or Tab acts as usual.
 */
export function TextInput({
  className,
  onKeyDown,
  onKeyDownCapture,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      {...rest}
      className={className ? `field__input ${className}` : "field__input"}
      onKeyDownCapture={(e) => {
        leaveImeKey(e);
        if (!e.isPropagationStopped()) onKeyDownCapture?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (isImeKey(e)) {
            e.stopPropagation();
            return;
          }
          e.preventDefault();
        }
        onKeyDown?.(e);
      }}
    />
  );
}
