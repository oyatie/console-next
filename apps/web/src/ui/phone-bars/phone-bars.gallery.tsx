// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Building2, ClipboardCheck, Clock, FileText, Home, Settings, UserRound } from "lucide-react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { PhoneBottomNav, PhoneTopBar, type PhoneNavItem } from "./phone-bars";

export const order = 86;

/** Phone top bar (`52px`) with and without back action, and bottom navigation (`56px`) with five items and overflow. */
export default function PhoneBarsGallery() {
  const fiveItems: readonly PhoneNavItem[] = [
    { id: "home", label: t("shell.link.home"), href: "#home", icon: Home, count: 3 },
    { id: "attendance", label: t("shell.link.attendance"), href: "#attendance", icon: Clock },
    { id: "payroll", label: t("shell.link.payroll"), href: "#payroll", icon: FileText },
    { id: "approvals", label: t("shell.link.approvals"), href: "#approvals", icon: ClipboardCheck },
    { id: "account", label: t("shell.account"), href: "#account", icon: UserRound },
  ];
  const overflowItems: readonly PhoneNavItem[] = [
    ...fiveItems,
    { id: "org", label: t("shell.link.org"), href: "#org", icon: Building2 },
    { id: "settings", label: t("shell.link.settings"), href: "#settings", icon: Settings },
  ];
  const [activeFive, setActiveFive] = useState("account");
  const [activeMany, setActiveMany] = useState("settings");

  return (
    <section className="card gallery__section" data-phone-bars-gallery>
      <h2 className="toolbar__title">{t("shell.menu")}</h2>
      <div className="gallery__phone" data-phone-bars-demo="five">
        <PhoneTopBar title={t("shell.account")} context={tg("pageHead.title")} />
        <PhoneBottomNav items={fiveItems} activeId={activeFive} onNavigate={item => setActiveFive(item.id)} />
      </div>
      <div className="gallery__phone" data-phone-bars-demo="overflow">
        <PhoneTopBar
          title={t("shell.link.settings")}
          context={tg("search.person")}
          back={{ label: t("common.back"), href: "#home" }}
        />
        <PhoneBottomNav
          label={`${t("shell.nav")} (${t("shell.nav.more")})`}
          items={overflowItems}
          activeId={activeMany}
          onNavigate={item => setActiveMany(item.id)}
        />
      </div>
    </section>
  );
}
