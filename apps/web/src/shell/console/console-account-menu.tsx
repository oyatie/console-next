// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { i18n, LOCALES, t } from "@console/i18n";
import { signOutHere } from "../../features/account/api";
import { isImeKey } from "../../lib/pure/ime";
import { focusSoon } from "../../lib/react/announce";
import { Avatar } from "../../ui/avatar/avatar";
import { setLocale } from "../locale";
import { useTheme } from "../theme";
import m from "./console-account-menu.module.css";

/** Lazy-loaded Console frame account disclosure with square initial avatar, locale & theme controls, and sign out. */
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
    panelRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && event.target instanceof Node && !wrapRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (!open || event.key !== "Escape" || isImeKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    btnRef.current?.focus();
  };

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
        onKeyDown={onEscape}
        onClick={() => setOpen(prev => !prev)}
      >
        <Avatar name={name} size="sm" tone="accent" />
        {!compact ? <bdi className={m.accountName}>{name}</bdi> : null}
      </button>
      {open ? (
        <div ref={panelRef} className={m.accountPop} role="group" aria-label={t("shell.account")}>
          <Link to="/account" className={m.accountItem} onKeyDown={onEscape} onClick={() => setOpen(false)}>
            {t("shell.account")}
          </Link>
          <Link to="/account/privacy" className={m.accountItem} onKeyDown={onEscape} onClick={() => setOpen(false)}>
            {t("account.privacy.title")}
          </Link>
          <hr className={m.accountRule} />
          {LOCALES.map(locale => {
            const selected = i18n.locale === locale;
            return (
              <button
                key={locale}
                type="button"
                className={m.accountItem}
                aria-pressed={selected}
                onKeyDown={onEscape}
                onClick={() => {
                  setOpen(false);
                  void setLocale(locale).then(() => focusSoon(id), () => focusSoon(id));
                }}
              >
                <bdi>{t(`shell.locale.${locale}`)}</bdi>
                {selected ? <Check size={14} aria-hidden="true" /> : null}
              </button>
            );
          })}
          <hr className={m.accountRule} />
          {(["light", "dark"] as const).map(value => {
            const selected = theme === value;
            return (
              <button
                key={value}
                type="button"
                className={m.accountItem}
                aria-pressed={selected}
                onKeyDown={onEscape}
                onClick={() => {
                  if (value !== theme) toggleTheme();
                  setOpen(false);
                  btnRef.current?.focus();
                }}
              >
                <bdi>{t(`shell.theme.${value}`)}</bdi>
                {selected ? <Check size={14} aria-hidden="true" /> : null}
              </button>
            );
          })}
          <hr className={m.accountRule} />
          <button type="button" className={m.accountItem} onKeyDown={onEscape} onClick={() => void onLogout()}>
            {t("shell.logout")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
