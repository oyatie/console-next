// SPDX-License-Identifier: LicenseRef-Proprietary
import { useContext, type ComponentProps, type ReactNode } from "react";
import { QueryState } from "../../lib/react/query-state";
import { PageReadGate } from "../../reference/authz/ui/access-gate";
import { PageHead, type PageHeadProps } from "../page-head/page-head";
import { PageHeadingLevel, PageScope } from "./page-scope";
import s from "./page.module.css";

type ReadProps<T> = Pick<ComponentProps<typeof QueryState<T>>, "q" | "children" | "empty" | "own" | "back" | "removed" | "layout">;
type PageProps<T> = {
  floorplan: "list" | "record" | "form" | "dashboard" | "wizard" | "settings" | "canvas";
  head: PageHeadProps;
} & (ReadProps<T> | { q?: never; children: ReactNode });

/** Keep safe page chrome outside the read boundary. Nested pages and portal content use secondary headings. */
export function Page<T>({ floorplan, head, ...content }: PageProps<T>) {
  const scope = useContext(PageScope);
  const level = useContext(PageHeadingLevel);
  const secondary = scope.embedded || level === 2;
  const Root = scope.landmark || secondary ? "div" : "main";
  const renderHead = (available: boolean) => <PageHeadingLevel value={secondary ? 2 : 1}>
    <PageHead {...(available ? head : { title: head.title, titleId: head.titleId, crumbs: head.crumbs, band: head.band })} />
  </PageHeadingLevel>;
  const body = content.q === undefined ? <>{renderHead(true)}{content.children}</> : (
    <PageReadGate q={content.q} head={renderHead} own={content.own} back={content.back} removed={content.removed}>
      <QueryState layout="list" {...content} />
    </PageReadGate>
  );
  return <PageScope value={{ landmark: true, embedded: true }}>
    <Root className={`page ${s.frame}`} data-floorplan={floorplan}>
      <PageHeadingLevel value={2}>{body}</PageHeadingLevel>
    </Root>
  </PageScope>;
}
