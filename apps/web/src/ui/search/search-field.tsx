import type { InputHTMLAttributes } from "react";
import { Search } from "lucide-react";
import { TextInput } from "../field/field";
import s from "./search.module.css";

/**
 * A find-within-this-view box (kit .find): the search icon, then a type="search" input named by `label`, which is
 * also its placeholder (the box says what it finds). Never submits a form on Enter: results follow the typing.
 * A search that runs on a server request is the caller's debounce, not this box's.
 */
export function SearchField({ label, value, onChange, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className={className ? `${s.search} ${className}` : s.search}>
      <Search size={16} aria-hidden className={s.icon} />
      <TextInput {...rest} type="search" aria-label={label} placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} className={s.input} />
    </div>
  );
}
