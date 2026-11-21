// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import s from "./document-decision-parts.module.css";

/** Rule-separated section inside the `start` rail of `DocumentDecision` (`P4`). */
export function DocRailSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className={s.railSection}>
      {children}
    </section>
  );
}

/** Padded content area inside a `DocRailSection`. */
export function DocRailBody({ children }: { children: ReactNode }) {
  return <div className={s.railBody}>{children}</div>;
}

/** Flat document canvas header (`kicker`, `h2` title, and tabular metadata line). */
export function DocHeader({ kicker, title, meta }: { kicker?: ReactNode; title: ReactNode; meta?: ReactNode }) {
  return (
    <div className={s.docHeader}>
      {kicker != null ? <div className={s.docKicker}>{kicker}</div> : null}
      <h2 className={s.docTitle}>{title}</h2>
      {meta != null ? <div className={s.docMeta}>{meta}</div> : null}
    </div>
  );
}

/** Numbered flat section inside the center document canvas of `DocumentDecision` (`P4`). */
export function DocSection({ label, title, children }: { label: string; title: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label} className={s.docSection}>
      <h3 className={s.docSectionHead}>{title}</h3>
      {children}
    </section>
  );
}

/** Flat standing-prose-free body text block inside `DocSection`. */
export function DocBodyText({ children }: { children: ReactNode }) {
  return <div className={s.docBodyText}>{children}</div>;
}

/** Rule-separated vertical list container for pre-decision reference links. */
export function DocLinkList({ children }: { children: ReactNode }) {
  return <div className={s.linkList}>{children}</div>;
}

/** Structured row content (`kind`, `label`, external-arrow icon) inside a `docLinkClass` link. */
export function DocLinkContent({ kind, label }: { kind: ReactNode; label: ReactNode }) {
  return (
    <>
      <bdi className={s.linkKind}>{kind}</bdi>
      <bdi className={s.linkLabel}>{label}</bdi>
      <ArrowUpRight size={14} className={s.linkIcon} aria-hidden="true" />
    </>
  );
}

/** Compact prev / position / next queue stepper strip for `PageHead` `meta`. */
export function DocQueueStepper({
  prev,
  label,
  next,
}: {
  prev: ReactNode;
  label: ReactNode;
  next: ReactNode;
}) {
  return (
    <div className={s.queueStepper}>
      {prev}
      <bdi className={s.queuePos}>{label}</bdi>
      {next}
    </div>
  );
}

/** Padded container for error alerts when decision buttons are suppressed. */
export function DocDecisionPad({ children }: { children: ReactNode }) {
  return <div className={s.decisionPad}>{children}</div>;
}
