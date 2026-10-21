import { useId, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { t } from "@console/i18n";
import s from "./section-confirm.module.css";

/**
 * A form section that is confirmed as a whole (design §4.2, §6.3): prefilled values are never trusted
 * silently, so a section holding read values offers a confirm and the save waits for it. Collapsed, it
 * keeps a one-line summary and, when required values are missing, their count: nothing is hidden
 * without its count. `owner` says whose facts these are (the legal entity, or this certificate).
 */
export function SectionConfirm({ title, owner, summary, missing = 0, needsConfirm = false, confirmed = false, onConfirm, defaultOpen = true, children }: {
  title: string;
  owner?: string;
  summary?: ReactNode;
  /** Required values still empty in this section. */
  missing?: number;
  /** The section holds values read from a document that the user has not confirmed. */
  needsConfirm?: boolean;
  confirmed?: boolean;
  onConfirm?: () => void;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <section className={s.section} aria-labelledby={`${id}-t`} data-confirmed={confirmed || undefined}>
      <div className={s.head}>
        <button type="button" className={s.toggle} aria-expanded={open} aria-controls={`${id}-b`} onClick={() => setOpen(!open)}>
          <Icon size={16} aria-hidden />
          <span id={`${id}-t`} className={s.title}>{title}</span>
          {owner && <span className={s.owner}>{owner}</span>}
        </button>
        {missing > 0 && <span className={s.missing}>{t("uiSectionConfirm.missing", { count: missing })}</span>}
        {confirmed && (
          <span className={s.done}>
            <Check size={14} aria-hidden />
            {t("uiSectionConfirm.confirmed")}
          </span>
        )}
        {needsConfirm && !confirmed && onConfirm && (
          <button type="button" className="btn" onClick={onConfirm} disabled={missing > 0} aria-describedby={missing > 0 ? `${id}-why` : undefined}>
            {t("uiSectionConfirm.confirm")}
          </button>
        )}
      </div>
      {needsConfirm && !confirmed && missing > 0 && <p id={`${id}-why`} className={s.why}>{t("uiSectionConfirm.fillFirst")}</p>}
      {!open && summary != null && <p className={s.summary}>{summary}</p>}
      <div id={`${id}-b`} className={s.body} hidden={!open}>{children}</div>
    </section>
  );
}
