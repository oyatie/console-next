import type { ReactNode } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { X } from "lucide-react";
import { t } from "@console/i18n";
import { Skeleton } from "../skeleton/skeleton";
import { useLiveHold } from "../../lib/live/hold";
import s from "./sheet.module.css";

/**
 * A side sheet for one action on a record (components.html §7, detail-sheet-keeps-context): it opens over the side
 * of the page so the record or list stays in view. React Aria keeps focus inside and returns it to the trigger.
 * Anatomy: head (title, subtitle, close), a scrolling body, and a foot that always states the `consequence` (one
 * sentence built from the values the request sends) above the `actions`. `notice` sits above the consequence for
 * what the server said (a refusal, a lost response). `kicker` names where it applies, above the title. While `pending` it cannot be dismissed, by Esc, an outside
 * click or the close button, and its actions cannot be pressed again. `wide` is for a sheet that shows a table (bulk lines).
 */
export function Sheet(p: {
  open: boolean;
  /** A line above the title saying where the action applies (an icon and a path). */
  kicker?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  pending?: boolean;
  /** The body is read-only (a lost response is being checked); the foot still acts. */
  locked?: boolean;
  /**
   * The lists the body draws from are still arriving: one loading line stands in for the whole body, so the form draws
   * once, whole. Drawn field by field, a list landing late (a catalog's chips) grew above fields already under the
   * pointer and pushed them down.
   */
  loading?: boolean;
  wide?: boolean;
  consequence: ReactNode;
  notice?: ReactNode;
  actions: ReactNode;
  children: ReactNode;
}) {
  useLiveHold(p.open);
  return (
    <ModalOverlay className={s.overlay} isOpen={p.open} onOpenChange={(o) => !o && !p.pending && p.onClose()} isDismissable={!p.pending} isKeyboardDismissDisabled={p.pending}>
      <Modal className={s.sheet} data-wide={p.wide || undefined}>
        <Dialog className={s.dialog}>
          <div className={s.head}>
            <div className={s.titles}>
              {p.kicker != null && <span className={s.kicker}>{p.kicker}</span>}
              <Heading slot="title" className={s.title}>{p.title}</Heading>
              {p.subtitle != null && <p className={s.subtitle}>{p.subtitle}</p>}
            </div>
            <Button className="btn btn--ghost" aria-label={t("uiSheet.close")} isDisabled={p.pending} onPress={p.onClose}><X size={16} aria-hidden /></Button>
          </div>
          <div className={s.body} inert={p.pending || p.locked || undefined}>{p.loading ? <Skeleton bones={["title", "row", "row", "row"]} label={t("common.loading")} /> : p.children}</div>
          <div className={s.foot}>
            {p.notice}
            <div className={s.consequence}>{p.consequence}</div>
            <div className={s.actions} inert={p.pending || undefined}>{p.actions}</div>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
