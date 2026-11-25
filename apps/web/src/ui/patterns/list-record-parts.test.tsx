// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { RecordIdentityBar } from "./list-record-parts";

// Under a pane titled at level 2 (인사기록카드), the record's name is the heading of what follows, so heading navigation
// reaches the person; panes that title themselves with the name keep it as plain strong text.
test("the identity bar names its record as a heading when the pane asks for one", () => {
  expect(renderToStaticMarkup(<RecordIdentityBar name="검증직원 1" nameLevel={3} />)).toMatch(/<h3 class="[^"]+">검증직원 1<\/h3>/);
  expect(renderToStaticMarkup(<RecordIdentityBar name="검증직원 1" />)).toMatch(/<strong class="[^"]+">검증직원 1<\/strong>/);
});
