// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, useState } from "react";
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isImeKey(event)) return;
      event.preventDefault();
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const onLogout = async () => {
    setOpen(false);
    await signOutHere();
    void navigate({ to: "/login" });
  };

  return (
    <div ref={wrapRef} className={m.accountWrap}>
      <button
        ref={btnRef}
        id={id}
        type="button"
        className={m.accountBtn}
        aria-label={name}
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
          {LOCALES.map(locale => {
            const selected = i18n.locale === locale;
            return (
              <button
                key={locale}
                type="button"
                className={m.accountItem}
                aria-pressed={selected}
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
          <button type="button" className={m.accountItem} onClick={() => void onLogout()}>
            {t("shell.logout")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
