// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps } from "react";
import { PageScope } from "./page-scope";

/** The shell owns the scroll landmark; a page rendered inside it supplies only its frame. */
export function PageMain(props: ComponentProps<"main">) {
  return <PageScope value={{ landmark: true, embedded: false }}><main {...props} /></PageScope>;
}
