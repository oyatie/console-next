// SPDX-License-Identifier: LicenseRef-Proprietary
import type { InputHTMLAttributes, ReactNode } from "react";
import { Search } from "lucide-react";
import { ToggleButton, type ButtonSize } from "../button/button";
import segCss from "../button/segmented.module.css";
import { TextInput } from "../field/text-input";
import searchCss from "../search/search.module.css";
import s from "./worklist-parts.module.css";

/** Zero-standing-text search input for Console worklist command strips. */
export function WorklistSearchField({
  label,
  value,
  onChange,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className={className ? `${searchCss.search} ${className}` : searchCss.search}>
      <Search size={16} aria-hidden className={searchCss.icon} />
      <TextInput
        {...rest}
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={searchCss.input}
      />
    </div>
  );
}

/** Zero-standing-text segmented filter group for Console worklist command strips. */
export function WorklistSegmentBar<T extends string>({
  label,
  items,
  value,
  onChange,
  size,
  block,
}: {
  label: string;
  items: readonly {
    id: T;
    label: ReactNode;
    icon?: ReactNode;
    count?: ReactNode;
    tone?: "warn" | "danger";
  }[];
  value: T;
  onChange: (id: T) => void;
  size?: ButtonSize;
  block?: boolean;
}) {
  return (
    <div className={segCss.seg} data-block={block || undefined} role="group" aria-label={label}>
      {items.map(item => (
        <ToggleButton
          key={item.id}
          className={segCss.item}
          data-tone={item.tone}
          size={size}
          count={item.count}
          countTone={item.tone}
          pressed={value === item.id}
          onClick={() => item.id !== value && onChange(item.id)}
        >
          {item.icon}
          {item.label}
        </ToggleButton>
      ))}
    </div>
  );
}

/** Bounded single-line subject + meta wrapper on desktop that unwraps inside phone cards. */
export function WorklistSubject({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className={s.clampSubject} title={title}>
      {children}
    </div>
  );
}

/** Bounded single-line reason wrapper on desktop that unwraps inside phone cards. */
export function WorklistReason({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <bdi className={`${s.clampReason} muted t-sm`} title={title}>
      {children}
    </bdi>
  );
}

/** Trailing bar beneath a bounded worklist table for paging remaining rows. */
export function WorklistMoreBar({ children }: { children: ReactNode }) {
  return <div className={s.moreBar}>{children}</div>;
}

/** Two-column lower operational band grid beneath the deadline strip. */
export function WorklistBandsGrid({ children }: { children: ReactNode }) {
  return <div className={s.bandsGrid}>{children}</div>;
}

export function WorklistBandCol({ children }: { children: ReactNode }) {
  return <div className={s.bandCol}>{children}</div>;
}

export function WorklistBandBlock({ children }: { children: ReactNode }) {
  return <div className={s.bandBlock}>{children}</div>;
}

export function WorklistBandEmpty({ children }: { children: ReactNode }) {
  return <div className={s.emptyBand}>{children}</div>;
}

export function WorklistStatWrap({ children }: { children: ReactNode }) {
  return <div className={s.statWrap}>{children}</div>;
}

export function WorklistSubLabel({ children }: { children: ReactNode }) {
  return <div className={s.subCheck}>{children}</div>;
}

/** Task title paired with a phone-only summary line inside compact operations rows. */
export function WorklistOpsTaskCell({ title, meta }: { title: ReactNode; meta?: ReactNode }) {
  return (
    <div className={s.opsTaskCell}>
      <strong className={s.opsTaskTitle}>{title}</strong>
      {meta ? <bdi className={`${s.opsPhoneMeta} muted t-xs`}>{meta}</bdi> : null}
    </div>
  );
}

/** Inline due date and urgency badge wrapper that wraps cleanly inside narrow phone operations rows. */
export function WorklistOpsDue({ children }: { children: ReactNode }) {
  return <div className={s.opsDue}>{children}</div>;
}

/** Proportional horizontal meter paired with a formatted numeric readout. */
export function WorklistMeter({
  value,
  max,
  label,
  valueLabel,
}: {
  value: number;
  max: number;
  label: string;
  valueLabel: ReactNode;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(2, Math.round((value / max) * 100))) : 0;
  return (
    <div className={s.barCell}>
      <div
        className={s.barTrack}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
      >
        <div className={s.barFill} ref={el => el?.style.setProperty("--pct", `${pct}%`)} />
      </div>
      <bdi className="num t-semibold">{valueLabel}</bdi>
    </div>
  );
}

/** Side-pane document summary header above key-value metadata. */
export function WorklistSummaryHead({
  kicker,
  title,
  status,
}: {
  kicker: ReactNode;
  title: ReactNode;
  status?: ReactNode;
}) {
  return (
    <div className={s.summaryHead}>
      <div className={s.kicker}>{kicker}</div>
      <h3 className={s.docTitle}>{title}</h3>
      {status ? <div className={s.statusLine}>{status}</div> : null}
    </div>
  );
}

/** Rule-separated side-pane section with optional body padding. */
export function WorklistSection({ padded = false, children }: { padded?: boolean; children: ReactNode }) {
  return <div className={padded ? `${s.section} ${s.kvPad}` : s.section}>{children}</div>;
}

export function WorklistPadded({ children }: { children: ReactNode }) {
  return <div className={s.kvPad}>{children}</div>;
}

export type WorklistChainStep = {
  key: string;
  role: ReactNode;
  actor: ReactNode;
  meta: ReactNode;
  state: "done" | "current" | "waiting" | "failed";
};

/** Compact approval-chain list inside a worklist record pane. */
export function WorklistChain({ label, steps }: { label: string; steps: readonly WorklistChainStep[] }) {
  return (
    <ol className={s.chainList} aria-label={label}>
      {steps.map(step => (
        <li
          key={step.key}
          className={s.chainStep}
          data-state={step.state}
          aria-current={step.state === "current" ? "step" : undefined}
        >
          <bdi className={s.stepRole}>{step.role}</bdi>
          <bdi>{step.actor}</bdi>
          <bdi className={s.stepMeta}>{step.meta}</bdi>
        </li>
      ))}
    </ol>
  );
}
