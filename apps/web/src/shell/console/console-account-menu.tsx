// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { signOutHere } from "../../features/account/api";
import { isImeKey } from "../../lib/pure/ime";
import { Avatar } from "../../ui/avatar/avatar";
import { LocaleSelect } from "../frame/locale-select";
import { useTheme } from "../theme";
import m from "./console-account-menu.module.css";

/** Lazy-loaded Console frame account disclosure: square initial avatar, the shared language and theme controls, and sign out. */
export function ConsoleAccountMenu({
  id,
  name,
  compact = false,
}: {
  id: string;
  name: string;
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const [theme, toggleTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const wrap = wrapRef.current;
    panelRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (wrap && event.target instanceof Node && !wrap.contains(event.target)) {
        setOpen(false);
      }
    };
    // Escape from the trigger or any control in the menu, the language select included, closes it back to the trigger.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isImeKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    wrap?.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      wrap?.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onLogout = async () => {
    setOpen(false);
    await signOutHere();
    void navigate({ to: "/login" });
  };

  return (
    <div ref={wrapRef} className={m.accountWrap}>
      {/* The name shows beside the initial; only the bare initial needs the name said for it. */}
      <button
        ref={btnRef}
        id={id}
        type="button"
        className={m.accountBtn}
        aria-label={compact ? name : undefined}
        aria-expanded={open}
        onClick={() => setOpen(prev => !prev)}
      >
        <Avatar name={name} size="sm" tone="accent" />
        {!compact ? <bdi className={m.accountName}>{name}</bdi> : null}
      </button>
      {open ? (
        <div ref={panelRef} className={m.accountPop} role="group" aria-label={t("shell.account")}>
          <Link to="/account" className={m.accountItem} onClick={() => setOpen(false)}>
            {t("shell.account")}
          </Link>
          <Link to="/account/privacy" className={m.accountItem} onClick={() => setOpen(false)}>
            {t("account.privacy.title")}
          </Link>
          <hr className={m.accountRule} />
          {/* Classic's bar controls, by their shared names. A language switch remounts the app, closing this menu, so
              focus goes back to its trigger. */}
          <div className={m.accountRow}>
            <label htmlFor={`${id}-locale`}>{t("shell.locale")}</label>
            <LocaleSelect id={`${id}-locale`} returnFocus={id} />
          </div>
          <button
            type="button"
            className={m.accountItem}
            onClick={() => {
              toggleTheme();
              setOpen(false);
              btnRef.current?.focus();
            }}
          >
            {t(theme === "dark" ? "shell.theme.toLight" : "shell.theme.toDark")}
          </button>
          <hr className={m.accountRule} />
          <button type="button" className={m.accountItem} onClick={() => void onLogout()}>
            {t("shell.logout")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
