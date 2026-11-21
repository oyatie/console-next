// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import { Button, Form } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { selfEditError } from "../api";
import s from "./account.module.css";

interface SelfChangeRequestSheetProps {
  open: boolean;
  title: string;
  isSending: boolean;
  isPending: boolean;
  error: unknown;
  submitDisabled?: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}

/** Shared modal form wrapper for self-service profile change requests. */
export function SelfChangeRequestSheet({
  open,
  title,
  isSending,
  isPending,
  error,
  submitDisabled = false,
  onOpen,
  onClose,
  onSubmit,
  children,
}: SelfChangeRequestSheetProps) {
  return (
    <>
      <Button size="sm" variant="secondary" className={s.actionBtn} onClick={onOpen}>
        {t("account.selfEdit.phoneEdit")}
      </Button>
      <Dialog open={open} title={title} onClose={onClose}>
        <Form className={s.form} aria-busy={isSending} onSubmit={onSubmit}>
          {children}
          <CommandError error={error} own={selfEditError} />
          <div className="form__actions">
            <Button type="button" disabled={isSending} onClick={onClose}>
              {t("composer.dismiss")}
            </Button>
            <Button type="submit" variant="primary" disabled={submitDisabled || isPending}>
              {t("account.selfEdit.addressSubmit")}
            </Button>
          </div>
        </Form>
      </Dialog>
    </>
  );
}
