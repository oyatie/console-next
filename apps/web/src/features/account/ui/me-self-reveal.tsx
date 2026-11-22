// SPDX-License-Identifier: LicenseRef-Proprietary
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { t } from "@console/i18n";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { Button } from "../../../ui/button/button";
import { selfEditError } from "../api";
import s from "./account.module.css";

const revealOwnError = (code: string) =>
  code === "not_found" ? t("account.selfEdit.revealNotRecorded") : selfEditError(code);

/** Trigger/hide button pair and countdown timer for self-service step-up reveal. */
export function SelfRevealControls({
  scope,
  fieldLabel,
  hasValue,
  isRevealed,
  seconds,
  isPending,
  onTrigger,
  onHide,
  onKeyDown,
}: {
  scope: string;
  fieldLabel: string;
  hasValue: boolean;
  isRevealed: boolean;
  seconds: number;
  isPending: boolean;
  onTrigger: () => void;
  onHide: () => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
}) {
  if (!hasValue && !isRevealed) return null;
  if (isRevealed) {
    return (
      <>
        <output role="timer" className="t-xs muted num">
          {t("account.selfEdit.revealRemaining", { seconds })}
        </output>
        <Button
          id={scope}
          size="sm"
          variant="ghost"
          className={s.actionBtn}
          aria-label={t("account.selfEdit.hide")}
          onClick={onHide}
          onKeyDown={onKeyDown}
        >
          <EyeOff size={14} aria-hidden="true" /> {t("account.selfEdit.hide")}
        </Button>
      </>
    );
  }
  return (
    <Button
      id={scope}
      size="sm"
      variant="ghost"
      className={s.actionBtn}
      disabled={isPending}
      aria-label={t("account.selfEdit.revealLabel", { field: fieldLabel })}
      onClick={onTrigger}
    >
      <Eye size={14} aria-hidden="true" /> {t("account.selfEdit.reveal")}
    </Button>
  );
}

/** Inline error banner for passkey or rate-limit refusals during self-reveal. */
export function SelfRevealError({ error }: { error: unknown }) {
  if (!error) return null;
  return <PasskeyError error={error} own={revealOwnError} />;
}
