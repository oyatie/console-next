import type { TextareaHTMLAttributes, Ref } from "react";
import { leaveImeKey } from "../../lib/pure/ime";

/**
 * A multi-line text control for feature views (which may not render raw elements); put it inside a Field. An Escape or
 * Tab pressed while a syllable is composing is the input method's, as in TextInput: no bubble-phase handler sees it.
 */
export function TextArea({ className, onKeyDownCapture, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return (
    <textarea
      {...rest}
      className={className ? `field__input field__area ${className}` : "field__input field__area"}
      onKeyDownCapture={(e) => {
        leaveImeKey(e);
        if (!e.isPropagationStopped()) onKeyDownCapture?.(e);
      }}
    />
  );
}
