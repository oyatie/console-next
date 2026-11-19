// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { t } from "@console/i18n";
import { isImeKey } from "../../lib/pure/ime";
import { SupportAccessIndicator } from "../../features/support-access/ui/support-access-status";
import { LiveStatus } from "../../ui/live/live-status";
import { Skeleton } from "../../ui/skeleton/skeleton";
import { activeLink, TENANT_NAV } from "../nav";
import { ShellFrame, type ShellLayoutProps } from "../frame/shell-frame";
import { LocaleSelect } from "../frame/locale-select";
import { SearchTrigger, NeedsMeSlot, ThemeToggle, AccountLink, LogoutButton } from "../frame/controls";

export default function Shell(props: { children?: ReactNode; pending?: boolean }) {
  return <ShellFrame layout={BaselineLayout} {...props} />;
}

function BaselineLayout({ children, platform, restoring, menu, navigationState, navigationNotice, onSearch }: ShellLayoutProps) {
  const { pathname } = useLocation();
  const router = useRouter();
  // Phone widths hide the rail; the top bar's menu button discloses it.
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const rail = useRef<HTMLElement>(null);
  const close = () => {
    setOpen(false);
    menuButton.current?.focus();
  };
  // Open: focus moves into the menu, and Esc closes it back to the button.
  useEffect(() => {
    if (!open) return;
    rail.current?.querySelector<HTMLElement>("a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isImeKey(e)) return;
      setOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  // Sub-views keep their module highlighted without changing the rail.
  const current = activeLink(pathname, menu?.flatMap(g => g.links) ?? []);
  return (
    <div className="shell" data-menu={open ? "open" : undefined}>
      <nav id="rail" ref={rail} className="rail" aria-label={t("shell.nav")}>
        <div className="rail__brand"><span className="rail__mark" aria-hidden>C</span>{t("app.name")}</div>
        {!platform && navigationState === "loading" && <div role="status" aria-busy="true" aria-label={t("common.loading")}>
          {TENANT_NAV.map(g => <div key={g.hub}>
            <div className="rail__hub">{t(g.hub)}</div>
            <ul className="rail__list">{g.links.filter(l => l.to in router.routesByPath).map(l =>
              <li key={l.to} className="rail__link"><Skeleton decorative bones={["line"]} /></li>)}</ul>
          </div>)}
        </div>}
        {menu?.map((g) => (
          <div key={g.hub}>
            <div className="rail__hub">{t(g.hub)}</div>
            <ul className="rail__list">{g.links.map((l) => (
              <li key={l.to}>
                <Link to={l.to} className="rail__link" activeOptions={{ exact: l.to !== current }}
                  aria-current={l.to === current ? "page" : undefined} data-status={l.to === current ? "active" : undefined} onClick={() => setOpen(false)}>
                  <l.icon size={16} aria-hidden /> {t(l.label)}
                </Link>
              </li>
            ))}</ul>
          </div>
        ))}
        {navigationNotice}
      </nav>
      <header className="top" data-task-menu={!platform || undefined} aria-busy={restoring || undefined}>
        {!restoring && <>
        <button ref={menuButton} className="btn btn--ghost top__menu" aria-expanded={open} aria-controls="rail" onClick={() => (open ? close() : setOpen(true))}>
          <Menu size={16} aria-hidden /> {t("shell.menu")}
        </button>
        {!platform && (
          <SearchTrigger onSearch={onSearch} />
        )}
        <span className="top__spacer" />
        {!platform && <NeedsMeSlot id="top-needs-me" />}
        <LiveStatus />
        {!platform && <SupportAccessIndicator />}
        <LocaleSelect id="top-locale" label />
        <ThemeToggle />
        <AccountLink />
        <LogoutButton />
        </>}
      </header>
      {children}
    </div>
  );
}
