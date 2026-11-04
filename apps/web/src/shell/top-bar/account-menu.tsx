// SPDX-License-Identifier: LicenseRef-Proprietary
import { useNavigate } from "@tanstack/react-router";
import { Button, Menu, MenuItem, MenuTrigger, Popover, RouterProvider, SubmenuTrigger } from "react-aria-components";
import { Check, ChevronRight, UserRound } from "lucide-react";
import { i18n, LOCALES, t } from "@console/i18n";
import { focusSoon } from "../../lib/react/announce";
import { setLocale } from "../locale";
import { useTheme } from "../theme";
import menu from "../../ui/menu/menu.module.css";
import s from "./top-bar.module.css";

export function AccountMenu({ id, name, onLogout }: { id: string; name: string; onLogout: () => void }) {
  const navigate = useNavigate();
  const [theme, toggleTheme] = useTheme();
  return (
    <RouterProvider navigate={href => void navigate({ to: href })}>
      <MenuTrigger>
        <Button id={id} className={s.account} aria-label={name}>
          <UserRound size={16} aria-hidden /><span className={s.name}>{name}</span>
        </Button>
        <Popover className={menu.pop} placement="bottom end">
          <Menu className={menu.menu} aria-label={t("shell.account")}>
            <MenuItem className={menu.item} href="/account">{t("shell.account")}</MenuItem>
            <SubmenuTrigger>
              <MenuItem className={menu.item} textValue={t("shell.locale")}>{t("shell.locale")}<ChevronRight size={14} aria-hidden /></MenuItem>
              <Popover className={menu.pop} placement="bottom end">
                <Menu className={menu.menu} aria-label={t("shell.locale")} selectionMode="single" selectedKeys={[i18n.locale]}>
                  {LOCALES.map(locale => (
                    <MenuItem key={locale} id={locale} className={menu.item} textValue={t(`shell.locale.${locale}`)} onAction={() => void setLocale(locale).then(() => focusSoon(id), () => focusSoon(id))}>
                      {t(`shell.locale.${locale}`)}<Check size={14} aria-hidden className={s.check} />
                    </MenuItem>
                  ))}
                </Menu>
              </Popover>
            </SubmenuTrigger>
            <SubmenuTrigger>
              <MenuItem className={menu.item} textValue={t("shell.theme")}>{t("shell.theme")}<ChevronRight size={14} aria-hidden /></MenuItem>
              <Popover className={menu.pop} placement="bottom end">
                <Menu className={menu.menu} aria-label={t("shell.theme")} selectionMode="single" selectedKeys={[theme]}>
                  {(["light", "dark"] as const).map(value => (
                    <MenuItem key={value} id={value} className={menu.item} textValue={t(`shell.theme.${value}`)} onAction={() => { if (value !== theme) toggleTheme(); }}>
                      {t(`shell.theme.${value}`)}<Check size={14} aria-hidden className={s.check} />
                    </MenuItem>
                  ))}
                </Menu>
              </Popover>
            </SubmenuTrigger>
            <MenuItem className={menu.item} onAction={onLogout}>{t("shell.logout")}</MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
    </RouterProvider>
  );
}
