import type { ReactNode } from "react";
import s from "./record.module.css";

/** One numbered section of a personnel record (1–8): head with its number, title, collection basis and tools; then its rows. */
export function RecordSection({ id, no, title, meta, tools, two, children }: { id: string; no?: number; title: string; meta?: ReactNode; tools?: ReactNode; two?: boolean; children: ReactNode }) {
  return (
    <section className={s.section} id={id} aria-labelledby={`${id}-h`} tabIndex={-1}>
      <div className={s.sectionHead}>
        {no != null && <span className={s.no} aria-hidden>{no}</span>}
        <h2 id={`${id}-h`}>{title}</h2>
        {meta && <span className={s.meta}>{meta}</span>}
        <span className={s.grow} />
        {tools}
      </div>
      <div className={s.sectionBody} data-two={two || undefined}>{children}</div>
    </section>
  );
}

/** A sub-heading inside a section (career 1 · education 2), with its tools at the end. */
export function SubHead({ children, tools }: { children: ReactNode; tools?: ReactNode }) {
  return <div className={s.subhead}><span>{children}</span>{tools}</div>;
}

/** A muted line inside a section: an empty state or a rule ("dismissal and exit: not applicable"). */
export function SectionLine({ children }: { children: ReactNode }) {
  return <div className={s.line}>{children}</div>;
}

/** A closed gate (restricted data): what it is, why it is closed, how to open it. */
export function Gate({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <div className={s.gate}>{icon}<div>{children}</div></div>;
}

/** A small state tag (planned, correction, void, imported). */
export function Tag({ kind, children }: { kind?: "fix" | "rev" | "plan" | "void"; children: ReactNode }) {
  return <span className={s.tag} data-k={kind}>{children}</span>;
}

/** A key as the keyboard shows it (`k`: its printed name, "J", "Enter", "⌘K"). */
export function Kbd({ k }: { k: string }) {
  // A visual key hint: the control keeps its own name (the key is not read into it); the key map (?) lists the keys.
  return <kbd className={s.kbd} aria-hidden>{k}</kbd>;
}

/** A masked value as shown by default (never the value itself). */
export function Masked({ children }: { children: ReactNode }) {
  return <span className={s.masked}>{children}</span>;
}
