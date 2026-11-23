// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useLocation } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { isImeKey } from "../../../lib/pure/ime";
import { announce, focusSoon } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { revealMyProfileField, type SelfRevealField } from "../api";

type RevealState = {
  value: unknown;
  until: number;
};

/**
 * Ephemeral step-up PII reveal controller: stores revealed values strictly in component `useState`
 * (`forget: true` on `useCommand`, zero browser storage or query cache) and clears on countdown expiry,
 * manual hide, `Escape`, unmount, and pathname navigation.
 */
export function useSelfReveal({
  employeeId,
  field,
  fieldLabel,
}: {
  employeeId: string;
  field: SelfRevealField;
  fieldLabel: string;
}) {
  const scope = useId();
  const [shown, setShown] = useState<RevealState | null>(null);
  const [seconds, setSeconds] = useState(0);
  const pathname = useLocation({ select: (location) => location.pathname });
  const lastPath = useRef(pathname);

  const hide = useCallback(() => {
    const ownsFocus =
      typeof document !== "undefined" &&
      document.activeElement !== null &&
      document.activeElement.id === scope;
    setShown(null);
    setSeconds(0);
    announce(t("empCard.reveal.remasked", { field: fieldLabel }));
    if (ownsFocus) focusSoon(scope);
  }, [fieldLabel, scope]);

  const command = useCommand({
    run: async () => {
      const result = await revealMyProfileField(employeeId, field);
      if (!Number.isFinite(result.display_seconds) || result.display_seconds <= 0) {
        throw new Error("invalid_reveal_duration");
      }
      return result;
    },
    forget: true,
    onSuccess: (res) => {
      setShown({ value: res.value, until: Date.now() + res.display_seconds * 1000 });
      setSeconds(res.display_seconds);
      announce(t("empCard.reveal.shown", { field: fieldLabel, seconds: res.display_seconds }));
      focusSoon(scope);
    },
  });

  useEffect(() => {
    if (!shown) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const left = Math.max(0, shown.until - Date.now());
      if (!left) {
        hide();
      } else {
        setSeconds(Math.ceil(left / 1000));
        timer = setTimeout(tick, Math.min(1000, left));
      }
    };
    timer = setTimeout(tick, Math.min(1000, Math.max(0, shown.until - Date.now())));
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isImeKey(e)) hide();
    };
    document.addEventListener("keydown", onEscape);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onEscape);
    };
  }, [shown, hide]);

  useEffect(() => {
    if (lastPath.current !== pathname) {
      lastPath.current = pathname;
      setShown(null);
      setSeconds(0);
    }
  }, [pathname]);

  useEffect(() => () => {
    setShown(null);
  }, []);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (shown && e.key === "Escape" && !isImeKey(e.nativeEvent)) {
        e.stopPropagation();
        hide();
      }
    },
    [shown, hide],
  );

  return {
    scope,
    revealedValue: shown?.value ?? null,
    isRevealed: shown !== null,
    seconds,
    isPending: command.isPending,
    error: command.error,
    onKeyDown,
    trigger: () => {
      if (command.isPending) return;
      command.reset();
      command.mutate(undefined);
    },
    hide,
  };
}
