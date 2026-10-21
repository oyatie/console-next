import type { TextareaHTMLAttributes } from "react";

/** A multi-line text control for feature views (which may not render raw elements); put it inside a Field. */
export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={className ? `field__input field__area ${className}` : "field__input field__area"} />;
}
