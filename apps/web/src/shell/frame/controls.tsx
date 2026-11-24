// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { LogOut, Moon, Search, Sun, UserRound } from "lucide-react";
import { logout, session } from "@console/api";
import { t } from "@console/i18n";
import { personName } from "../../reference/person/present";
import { chunk } from "../../lib/chunk-guard";
import { modHint } from "../../lib/mod-hint";
import { useTheme } from "../theme";

const NeedsMeMenu = lazy(() => chunk(import("../top-bar/needs-me")).then(m => ({ default: m.NeedsMeMenu })));

export function NeedsMeSlot({ id }: { id: string }) {
  return <Suspense fallback={null}><NeedsMeMenu id={id} /></Suspense>;
}

export function SearchTrigger({ onSearch }: { onSearch: () => void }) {
  return <button type="button" className="btn top__jump" onClick={onSearch} aria-keyshortcuts="Meta+K Control+K">
    <Search size={16} aria-hidden />
    <span className="top__jumpText"><span className="top__jumpHint">{t("shell.jump")}</span><span className="top__jumpLabel">{t("shell.jumpLabel")}</span></span>
    <kbd className="top__kbd" aria-hidden>{modHint("K")}</kbd>
  </button>;
}

export function ThemeToggle() {
  const [theme, toggle] = useTheme();
  return <button className="btn btn--ghost" onClick={toggle} aria-label={theme === "dark" ? t("shell.theme.toLight") : t("shell.theme.toDark")}>
    {theme === "dark" ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
  </button>;
}

export function AccountLink() {
  return <Link to="/account" className="btn btn--ghost top__name">
    <UserRound size={16} aria-hidden /> <span>{personName(session.claims?.name, t(session.claims?.platform ? "account.name.unset.operator" : "account.name.unset"))}</span>
  </Link>;
}

export function LogoutButton() {
  const nav = useNavigate();
  return <button className="btn btn--ghost top__logout" onClick={async () => (await logout(), nav({ to: "/login" }))}>
    <LogOut size={16} aria-hidden /> {t("shell.logout")}
  </button>;
}
