import type { ComponentProps, HTMLAttributes, ReactNode, Ref } from "react";
import { TextInput } from "../field/field";
import s from "./record.module.css";

/** A field's quick editor in its row (Class I): one control's height, so opening it never moves the rows under it. */
export function RowInput(props: Omit<ComponentProps<typeof TextInput>, "className">) {
  return <TextInput {...props} className={s.rowInput} />;
}

/** The typed value while its save is out: tinted, with a quiet spinner named `label` (no layout shift when it lands). */
export function Saving({ label, children }: { label: string; children: ReactNode }) {
  return <span className={s.saving}>{children}<span className={s.tick} role="img" aria-label={label} /></span>;
}

/** A row being edited in place among its section's rows (an added education line): tinted to the section's edges. */
export function EditRow({ children, ...rest }: Omit<HTMLAttributes<HTMLDivElement>, "className"> & { ref?: Ref<HTMLDivElement> }) {
  return <div {...rest} className={s.editRow}>{children}</div>;
}
