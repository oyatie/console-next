// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Banknote, CalendarDays, FileText, Home, Search, UserRound } from "lucide-react";
import { t } from "@console/i18n";
import { chunk } from "../../lib/chunk-guard";
import { Avatar } from "../../ui/avatar/avatar";
import { PhoneBottomNav, PhoneTopBar, type PhoneNavItem } from "../../ui/phone-bars/phone-bars";
import type { NavLink } from "../nav";
import s from "./console-phone-chrome.module.css";

const ConsoleAccountMenu = lazy(() =>
  chunk(import("./console-account-menu")).then(m => ({ default: m.ConsoleAccountMenu })),
);

export function ConsolePhoneTop({
  title,
  shellOwnsH1,
  context,
  back,
  hideActions,
  platform,
  displayName,
  onSearch,
}: {
  title: ReactNode;
  shellOwnsH1?: boolean;
  context?: ReactNode;
  back?: { label: string; href?: string; onBack?: () => void };
  hideActions?: boolean;
  platform: boolean;
  displayName: string;
  onSearch: () => void;
}) {
  return (
    <PhoneTopBar
      title={title}
      headingAs={shellOwnsH1 ? "h1" : "div"}
      context={context}
      back={back}
      trailing={
        hideActions ? undefined : (
          <div className={s.phoneActions}>
            {!platform ? (
              <button
                type="button"
                className={s.phoneIconBtn}
                aria-label={t("shell.jumpLabel")}
                onClick={onSearch}
              >
                <Search size={18} aria-hidden="true" />
              </button>
            ) : null}
            <Suspense
              fallback={
                <Link to="/account" className={s.accountFallback} aria-label={displayName}>
                  <Avatar name={displayName} size="sm" tone="accent" />
                </Link>
              }
            >
              <ConsoleAccountMenu id="console-phone-account" name={displayName} compact />
            </Suspense>
          </div>
        )
      }
    />
  );
}

export function ConsolePhoneBottom({
  links,
  inboxCount,
  approvalsCount,
  platform,
  mode,
  activeId,
  onNavigate,
}: {
  links: readonly NavLink[];
  inboxCount?: number;
  approvalsCount?: number;
  platform: boolean;
  mode?: "self-service";
  activeId?: string;
  onNavigate: (href: string) => void;
}) {
  const items: PhoneNavItem[] =
    !platform && mode === "self-service"
      ? [
          { id: "/", href: "/", label: t("shell.link.home"), icon: Home, count: inboxCount },
          { id: "/leave", href: "/leave", label: t("shell.link.leave"), icon: CalendarDays },
          { id: "/payroll", href: "/payroll", label: t("shell.link.payroll"), icon: Banknote },
          { id: "/people/certificates", href: "/people/certificates", label: t("shell.link.certificates"), icon: FileText },
          { id: "/account", href: "/account", label: t("shell.link.profile"), icon: UserRound },
        ]
      : links.map(link => ({
          id: link.to,
          href: link.to,
          label: t(link.label),
          icon: link.icon,
          count: link.countKey === "inbox" ? inboxCount : link.countKey === "approvals" ? approvalsCount : undefined,
        }));
  if (!platform && mode !== "self-service" && !items.some(item => item.id === "/account")) {
    items.push({ id: "/account", href: "/account", label: t("shell.account"), icon: UserRound });
  }
  return (
    <PhoneBottomNav
      items={items}
      activeId={activeId}
      onNavigate={item => onNavigate(item.href)}
      renderLink={(item, props) => (
        <Link
          to={item.href}
          className={props.className}
          activeOptions={{ exact: item.href !== activeId }}
          aria-current={props["aria-current"]}
        >
          {props.children}
        </Link>
      )}
    />
  );
}
