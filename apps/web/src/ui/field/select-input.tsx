import type { SelectHTMLAttributes } from "react";

/** A native select for feature views (which may not render raw elements); put it inside a Field. */
export function SelectInput({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={className ? `field__input ${className}` : "field__input"} />;
}
