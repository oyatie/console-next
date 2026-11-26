// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, type ReactNode } from "react";
import { Link, useLocation } from "@tanstack/react-router";
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
                aria-haspopup="dialog"
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

/** The employee's own certificate sheet, opened over the profile page. */
const CERTIFICATES = "/account?sheet=certificates";

export function ConsolePhoneBottom({
  links,
  inboxCount,
  inboxExact = true,
  inboxName,
  inboxDescription,
  approvalsCount,
  platform,
  mode,
  unlinked,
  activeId,
  onNavigate,
  menuAway = false,
}: {
  links: readonly NavLink[];
  inboxCount?: number;
  inboxExact?: boolean;
  /** The to-do link's name and count description, which say the count's state when the badge cannot. */
  inboxName?: string;
  inboxDescription?: string;
  approvalsCount?: number;
  platform: boolean;
  mode?: "self-service";
  /** An account with no employee record has no certificates of its own to open. */
  unlinked?: boolean;
  activeId?: string;
  onNavigate: (href: string) => void;
  /**
   * The menu is still loading, or its read failed: My profile takes the last of the bar's five places, where a
   * five-place menu leaves it.
   */
  menuAway?: boolean;
}) {
  const items: PhoneNavItem[] =
    !platform && mode === "self-service"
      ? [
          { id: "/", href: "/", label: t("shell.link.home"), icon: Home, count: inboxCount },
          { id: "/leave", href: "/leave", label: t("shell.link.leave"), icon: CalendarDays },
          { id: "/payslips", href: "/payslips", label: t("shell.link.payroll"), icon: Banknote },
          ...(unlinked ? [] : [{ id: CERTIFICATES, href: CERTIFICATES, label: t("shell.link.certificates"), icon: FileText }]),
          { id: "/account", href: "/account", label: t("shell.link.profile"), icon: UserRound },
        ]
      : links.map(link =>
          link.countKey === "inbox"
            ? { id: link.to, href: link.to, label: t(link.label), icon: link.icon, count: inboxCount, countMore: !inboxExact, name: inboxName, description: inboxDescription }
            : { id: link.to, href: link.to, label: t(link.label), icon: link.icon, count: link.countKey === "approvals" ? approvalsCount : undefined },
        );
  const here = useLocation({ select: location => location.href });
  if (!platform && mode !== "self-service" && !items.some(item => item.id === "/account")) {
    items.push({ id: "/account", href: "/account", label: t("shell.profile"), icon: UserRound });
  }
  return (
    <PhoneBottomNav
      items={items}
      // shortcut: a shorter menu widens My profile's slot when it lands (the slot still covers this place), and a longer
      // one puts More here with My profile inside; holding the right place needs the menu's size before the menu itself.
      reserve={menuAway ? 5 : undefined}
      activeId={activeId}
      onNavigate={item => onNavigate(item.href)}
      renderLink={(item, props) => (
        <Link
          to={item.id === CERTIFICATES ? "/account" : item.href}
          search={item.id === CERTIFICATES ? { sheet: "certificates" } : undefined}
          // The sheet's close unwinds the entry this tab pushes, as it does one the profile page opens.
          state={item.id === CERTIFICATES ? previous => ({ ...previous, sidePanelOrigin: activeId === CERTIFICATES ? previous.sidePanelOrigin : here }) : undefined}
          className={props.className}
          activeOptions={{ exact: item.href !== activeId }}
          aria-current={props["aria-current"]}
          aria-label={props["aria-label"]}
          aria-describedby={props["aria-describedby"]}
        >
          {props.children}
        </Link>
      )}
    />
  );
}
