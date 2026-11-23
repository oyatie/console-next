// SPDX-License-Identifier: LicenseRef-Proprietary
import { useContext, type ComponentProps } from "react";
import { PageHeadingLevel, PagePhoneHeader, PageScope } from "./page-scope";

/** The shell owns the scroll landmark; a page rendered inside it supplies only its frame. */
export function PageMain(props: ComponentProps<"main">) {
  const { shellOwnsH1 } = useContext(PagePhoneHeader);
  const content = <main {...props} />;
  return (
    <PageScope value={{ landmark: true, embedded: false }}>
      {shellOwnsH1 ? <PageHeadingLevel value={2}>{content}</PageHeadingLevel> : content}
    </PageScope>
  );
}
