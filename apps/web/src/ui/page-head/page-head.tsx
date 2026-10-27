import { useContext, type ReactNode } from "react";
import s from "./page-head.module.css";
import { shown } from "../shown";
import { PageHeadingLevel } from "../page/page-scope";

/**
 * The head of a page (design-language §4.3, kit .ph): where it sits (`crumbs`), the one h1 `title`, what it is
 * (`meta`: a phase line, a status chip, a code), the page's tools on the right (as-of date, import, export, the one
 * primary), and view `tabs` under it. `band` draws it as the full-width surface band of a record or wizard page;
 * without it the head sits in the page's padding (lists, settings).
 */
export type PageHeadProps = {
  title: ReactNode;
  /** The h1's id: a screen that moves focus to its title after a load or a commit names it (the h1 takes focus, never a tab stop). */
  titleId?: string;
  crumbs?: ReactNode;
  meta?: ReactNode;
  tools?: ReactNode;
  /** One primary action stays visible on phones; secondary commands move into the named menu. */
  primary?: ReactNode;
  actions?: ReactNode;
  /** The existing AsOfControl (or an AsOf fact); owned by the head, above its view tabs. */
  asOf?: ReactNode;
  tabs?: ReactNode;
  /** Under the title: what this page is for (a line, or a block such as a chain strip: a <div>, never a <p>). */
  sub?: ReactNode;
  band?: boolean;
};

export function PageHead({ title, titleId, crumbs, meta, tools, primary, actions, asOf, tabs, band, sub }: PageHeadProps) {
  const Title = useContext(PageHeadingLevel) === 1 ? "h1" : "h2";
  return (
    <header className={s.head} data-band={band || undefined} data-tabs={shown(tabs) || undefined}>
      {crumbs}
      <div className={s.row}>
        <Title id={titleId} className={s.title} tabIndex={-1}>{title}</Title>
        {shown(meta) && <div className={s.meta}>{meta}</div>}
        <span className={s.grow} />
        {actions}
        {shown(tools) && <div className={s.tools}>{tools}</div>}
        {shown(primary) && <div className={s.primary}>{primary}</div>}
      </div>
      {shown(sub) && <div className={s.sub}>{sub}</div>}
      {asOf}
      {tabs}
    </header>
  );
}
