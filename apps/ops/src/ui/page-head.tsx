// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import s from "./page-head.module.css";

export type PageTab = {
  id: string;
  to: string;
  label: string;
  active: boolean;
};

export function PageHead({
  title,
  meta,
  tools,
  tabs,
}: {
  title: string;
  meta?: ReactNode;
  tools?: ReactNode;
  tabs?: readonly PageTab[];
}) {
  return (
    <header className={s.head} data-tabs={tabs && tabs.length > 0 ? "true" : undefined}>
      <div className={s.row}>
        <h1 className={s.title}>{title}</h1>
        {meta ? <div className={s.meta}>{meta}</div> : null}
        {tools ? <div className={s.tools}>{tools}</div> : null}
      </div>
      {tabs && tabs.length > 0 ? (
        <nav className={s.tabs} aria-label={title}>
          {tabs.map((tab) => (
            <Link
              key={tab.id}
              to={tab.to}
              activeOptions={{ exact: true }}
              className={s.tab}
              aria-current={tab.active ? "page" : undefined}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
