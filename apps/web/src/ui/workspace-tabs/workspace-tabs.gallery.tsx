// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { WorkspaceTabs, type WorkspaceTab } from "./workspace-tabs";

export const order = 84;

/** Open workspace tab strip showing pinned first tab, closable tabs, count badge, `+` action, and narrow overflow. */
export default function WorkspaceTabsGallery() {
  const initialTabs: readonly WorkspaceTab[] = [
    { id: "home", label: t("shell.link.home"), href: "#home", count: 23, pinned: true },
    { id: "people", label: t("shell.link.people"), href: "#people" },
    { id: "person", label: tg("search.person"), href: "#person" },
    { id: "approvals", label: t("shell.link.approvals"), href: "#approvals", count: 4 },
    { id: "attendance", label: t("shell.link.attendance"), href: "#attendance" },
    { id: "payroll", label: t("shell.link.payroll"), href: "#payroll" },
  ];
  const [tabs, setTabs] = useState<readonly WorkspaceTab[]>(initialTabs);
  const [activeId, setActiveId] = useState("person");
  const [narrowActiveId, setNarrowActiveId] = useState("payroll");

  const handleClose = (tabId: string) => {
    setTabs(prev => {
      const idx = prev.findIndex(item => item.id === tabId);
      const next = prev.filter(item => item.id !== tabId);
      if (activeId === tabId && next.length > 0) {
        const fallback = next[Math.min(idx, next.length - 1)]!;
        setActiveId(fallback.id);
      }
      return next;
    });
  };

  const handleAdd = () => {
    const nextNum = tabs.length + 1;
    const id = `tab-${nextNum}`;
    setTabs(prev => [...prev, { id, label: `${t("shell.link.org")} ${nextNum}`, href: `#${id}` }]);
    setActiveId(id);
  };

  return (
    <section className="card gallery__section" data-workspace-tabs-gallery>
      <h2 className="toolbar__title">{t("shell.tabs.label")}</h2>
      <div data-workspace-tabs-demo="full">
        <WorkspaceTabs
          tabs={tabs}
          activeId={activeId}
          onSelect={tab => setActiveId(tab.id)}
          onClose={handleClose}
          onAdd={handleAdd}
        />
      </div>
      <div className="gallery__narrow" data-workspace-tabs-demo="narrow">
        <WorkspaceTabs
          label={`${t("shell.tabs.label")} (${t("shell.tabs.more")})`}
          tabs={initialTabs}
          activeId={narrowActiveId}
          onSelect={tab => setNarrowActiveId(tab.id)}
          onClose={() => {}}
        />
      </div>
    </section>
  );
}
