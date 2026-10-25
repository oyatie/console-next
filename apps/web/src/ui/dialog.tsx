import type { ReactNode } from "react";
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { useLiveHold } from "../lib/live/hold";

/**
 * Modal dialog (React Aria): focus trap, Esc, inert background — and, unlike a native top-layer
 * <dialog>, popovers opened inside it (pickers, menus) layer above it correctly.
 */
export function Dialog({ open, title, onClose, children, dismissable = true, read = false }: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** false: Esc and outside clicks do nothing; only the dialog's own buttons close it (one-time codes). */
  dismissable?: boolean;
  /** Reserve the body across a required read's loading, failure and ready states. */
  read?: boolean;
}) {
  useLiveHold(open);
  return (
    <ModalOverlay className="overlay" isOpen={open} onOpenChange={(o) => !o && onClose()} isDismissable={dismissable} isKeyboardDismissDisabled={!dismissable}>
      <Modal className="dialog card">
        <AriaDialog className={`dialog__body${read ? " dialog__body--read" : ""}`}>
          <Heading slot="title" className="panel__title">{title}</Heading>
          {children}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
