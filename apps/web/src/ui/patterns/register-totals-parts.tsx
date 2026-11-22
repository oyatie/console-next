// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button, Label, ListBox, ListBoxItem, Popover, Select, SelectValue, Text } from "react-aria-components";
import selectStyles from "../select/select-field.module.css";
import s from "./register-totals-parts.module.css";

/** Flush 5-cell top summary strip combining a stage rail cell and a 4-item `StatRow`. */
export function RegisterTotalsStrip({
  stageLabel,
  stageRail,
  stats,
}: {
  stageLabel: ReactNode;
  stageRail: ReactNode;
  stats: ReactNode;
}) {
  return (
    <div className={s.totalsGrid}>
      <div className={s.stageCell}>
        <div className={s.stageLabel}>{stageLabel}</div>
        {stageRail}
      </div>
      <div className={s.totalsStats}>{stats}</div>
    </div>
  );
}

/** Conditional pre-approval / validation strip inside `RegisterTotals` `blockers`. */
export function RegisterBlockerRow({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={s.blockerRow}>
      <bdi className={s.blockerTitle}>{title}</bdi>
      {children}
    </div>
  );
}

/** Individual check group inside `RegisterBlockerRow`. */
export function RegisterBlockerItem({
  badge,
  subject,
  note,
  action,
}: {
  badge: ReactNode;
  subject?: ReactNode;
  note: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={s.blockerItem}>
      {badge}
      {subject != null && <bdi className={s.blockerSubject}>{subject}</bdi>}
      <bdi className={s.blockerNote}>{note}</bdi>
      {action != null && <div className={s.blockerAction}>{action}</div>}
    </div>
  );
}

/** Pagination and range bar directly beneath the register table. */
export function RegisterFootBar({
  range,
  actions,
  trailing,
}: {
  range: ReactNode;
  actions?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className={s.footBar}>
      <div className={s.footLeft}>
        <bdi className={s.footRange}>{range}</bdi>
        {actions != null && <div className={s.footActions}>{actions}</div>}
      </div>
      {trailing}
    </div>
  );
}

/** Three-column lower preview layout (`Earnings` | `Deductions` | `Net pay`). */
export function RegisterPreviewCols({
  left,
  middle,
  right,
}: {
  left: ReactNode;
  middle: ReactNode;
  right: ReactNode;
}) {
  return (
    <div className={s.previewCols}>
      <div className={s.previewCol}>{left}</div>
      <div className={s.previewCol}>{middle}</div>
      <div className={s.previewCol}>{right}</div>
    </div>
  );
}

/** Right-hand net pay hero summary and read-only facts inside `RegisterPreviewCols`. */
export function RegisterNetBox({
  label,
  formula,
  amount,
  details,
}: {
  label: ReactNode;
  formula?: ReactNode;
  amount: ReactNode;
  details?: ReactNode;
}) {
  return (
    <div className={s.netBox}>
      <div className={s.netHead}>
        <div className={s.stageLabel}>{label}</div>
        {formula != null && <bdi className={s.netFormula}>{formula}</bdi>}
      </div>
      <div className={s.heroFigure}>{amount}</div>
      {details != null && <div className={s.netDetails}>{details}</div>}
    </div>
  );
}

/** Toolbar-height custom select matching `PeriodStepper` height in `PageHead` filters. */
export function RegisterToolbarSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const selectedValue = options.some(option => option.value === value) ? value : null;
  const placeholder = options[0]?.label ?? label;
  return (
    <div className={s.toolbarSelect}>
      <Select
        className={selectStyles.select}
        value={selectedValue}
        onChange={key => key != null && onChange(String(key))}
        isRequired={false}
        placeholder={placeholder}
        data-form-value={selectedValue ?? ""}
      >
        <Label className="sr-only">{label}</Label>
        <Button className={selectStyles.trigger}>
          <SelectValue className={selectStyles.value}>
            {({ selectedText, defaultChildren, isPlaceholder }) => (isPlaceholder ? defaultChildren : selectedText)}
          </SelectValue>
          <ChevronDown size={14} aria-hidden className={selectStyles.chev} />
        </Button>
        <Popover className={selectStyles.pop}>
          <ListBox className={selectStyles.list}>
            {options.map(option => (
              <ListBoxItem key={option.value} id={option.value} textValue={option.label} className={selectStyles.opt}>
                <Text slot="label" className={selectStyles.optLabel}>{option.label}</Text>
              </ListBoxItem>
            ))}
          </ListBox>
        </Popover>
      </Select>
    </div>
  );
}

/** Wraps a toolbar search field so its height matches `24px` desktop controls and stretches on phone. */
export function RegisterToolbarSearch({ children }: { children: ReactNode }) {
  return <div className={s.toolbarSearch}>{children}</div>;
}

/** Non-wrapping icon + label status readout inside register cells. */
export function RegisterBankStatus({
  icon,
  label,
}: {
  icon: ReactNode;
  label: ReactNode;
}) {
  return (
    <bdi className={s.bankStatus}>
      {icon}
      {label}
    </bdi>
  );
}

/** Inline phone-only detail text hidden above 480px. */
export function RegisterPhoneOnly({ children }: { children: ReactNode }) {
  return <bdi className={s.phoneOnly}>{children}</bdi>;
}

/** Non-wrapping inline readout for buttons, dates, and numeric cells. */
export function RegisterNowrap({ children }: { children: ReactNode }) {
  return <bdi className={s.nowrap}>{children}</bdi>;
}

/** Vertical stack for read-only sheet summaries. */
export function RegisterSheetStack({ children }: { children: ReactNode }) {
  return <div className={s.sheetPreviewList}>{children}</div>;
}
