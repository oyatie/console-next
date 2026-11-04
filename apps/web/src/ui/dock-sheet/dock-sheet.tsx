import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { t } from "@console/i18n";
import { useLiveHold } from "../../lib/live/hold";
import { Sheet } from "../sheet/sheet";
import { useCurrentSheetDraft } from "../sheet/sheet-draft";
import { useSheetDismiss } from "../sheet/sheet-dismiss";
import s from "./dock-sheet.module.css";
import { useNarrow } from "./use-narrow";

type Props = {
  open: boolean;
  kicker?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  pending?: boolean;
  dirty?: boolean;
  consequence: ReactNode;
  notice?: ReactNode;
  actions: ReactNode;
  children: ReactNode;
};

/**
 * A sheet docked beside the view it works on (G6, spec §12.2): non-modal (`role="complementary"`), so the grid's
 * selected cells stay visible and usable. Same anatomy as `Sheet`: head, a scrolling body, the consequence above the
 * actions. Esc closes it and focus returns to where it came from; while `pending` it cannot be closed. The caller
 * lays it out beside the view (a grid column of `--sheet-w`). Below 960 px it is the modal `Sheet`.
 */
export function DockSheet(p: Props) {
  const small = useNarrow();
  return !p.open ? null : small ? <Sheet {...p} /> : <WideDockSheet {...p} />;
}

function WideDockSheet(p: Props) {
  const head = useRef<HTMLHeadingElement>(null);
  const back = useRef<Element | null>(null);
  const id = useId();
  const draft = useCurrentSheetDraft();
  useLiveHold(p.open);
  const { ref, dirty, armed, requestClose, onInput } = useSheetDismiss<HTMLElement>({ ...p, dirty: draft?.dirty ?? p.dirty, nativeEscape: true });
  useEffect(() => {
    if (!p.open) return;
    back.current = document.activeElement;
    head.current?.focus();
    return () => (back.current as HTMLElement | null)?.focus?.();
  }, [p.open]);
  return (
    <aside ref={ref} className={s.dock} aria-labelledby={id} data-sheet-layer>
      <div className={s.head}>
        <div className={s.titles}>
          {p.kicker != null && <span className={s.kicker}>{p.kicker}</span>}
          <h2 id={id} ref={head} tabIndex={-1} className={s.title}>{p.title}</h2>
          {p.subtitle != null && <p className={s.subtitle}>{p.subtitle}</p>}
        </div>
        <button type="button" className="btn btn--ghost" aria-label={t("uiSheet.close")} disabled={p.pending} onClick={requestClose}><X size={16} aria-hidden /></button>
      </div>
      <div className={s.body} inert={p.pending || undefined} onInputCapture={onInput} onChangeCapture={onInput}>{p.children}</div>
      <div className={s.foot}>
        {p.notice}
        {draft && (draft.problem || draft.restored) && <div role="status">{t(draft.problem ? "draft.unavailable" : "draft.restored")}{draft.restored && !draft.problem && <button type="button" className="btn btn--ghost" onClick={draft.discard}>{t("draft.discard")}</button>}</div>}
        {armed && dirty && <div role="status">{t("composer.unsaved")}</div>}
        <div className={s.consequence}>{p.consequence}</div>
        <div className={s.actions} inert={p.pending || undefined}>{p.actions}</div>
      </div>
    </aside>
  );
}
