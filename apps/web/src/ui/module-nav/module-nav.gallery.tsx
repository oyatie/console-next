// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { ModuleNavBar, type ModuleNavItem } from "./module-nav";

export const order = 83;

/** Horizontal module navigation bar inside `[data-surface="chrome"]` at full width and constrained overflow width. */
export default function ModuleNavGallery() {
  const items: readonly ModuleNavItem[] = [
    { id: "todo", label: t("shell.link.todo"), href: "#todo", count: 23 },
    { id: "requests", label: t("shell.link.requests"), href: "#requests" },
    { id: "approvals", label: t("shell.link.approvals"), href: "#approvals", count: 4 },
    { id: "org", label: t("shell.link.org"), href: "#org" },
    { id: "people", label: t("shell.link.people"), href: "#people" },
    { id: "attendance", label: t("shell.link.attendance"), href: "#attendance" },
    { id: "payroll", label: t("shell.link.payroll"), href: "#payroll" },
    { id: "statutory", label: t("shell.link.statutory"), href: "#statutory" },
    { id: "access", label: t("shell.link.access"), href: "#access" },
    { id: "audit", label: t("shell.link.audit"), href: "#audit" },
    { id: "settings", label: t("shell.link.settings"), href: "#settings" },
  ];
  const [activeId, setActiveId] = useState("people");
  const [narrowActiveId, setNarrowActiveId] = useState("settings");

  return (
    <section className="card gallery__section" data-module-nav-gallery>
      <h2 className="toolbar__title">{t("shell.nav")}</h2>
      <div className="toolbar" data-surface="chrome" data-module-nav-demo="full">
        <ModuleNavBar
          label={t("shell.nav")}
          items={items}
          activeId={activeId}
          onNavigate={item => setActiveId(item.id)}
        />
      </div>
      <div
        className="toolbar gallery__narrow"
        data-surface="chrome"
        data-module-nav-demo="narrow"
      >
        <ModuleNavBar
          label={`${t("shell.nav")} (${t("shell.nav.more")})`}
          items={items}
          activeId={narrowActiveId}
          onNavigate={item => setNarrowActiveId(item.id)}
        />
      </div>
    </section>
  );
}
