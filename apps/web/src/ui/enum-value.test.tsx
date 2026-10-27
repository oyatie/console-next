// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup as html } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import * as enums from "../lib/labels";
import { EnumCode, EnumValue } from "./enum-value";

beforeAll(() => loadCatalog("ko"));

test("EnumValue renders all five registry tones with catalog words through Chip", () => {
  for (const value of enums.ORG_CHANGE_STATUS.values) {
    const text = enums.labeled(enums.ORG_CHANGE_STATUS, value);
    expect(html(<EnumValue e={enums.ORG_CHANGE_STATUS} value={value} />)).toBe(`<span class="chip chip--${text.tone}">${text.label}</span> `);
  }
});

test("an unknown status is a visible neutral code", () => {
  expect(html(<EnumValue e={enums.ORG_CHANGE_STATUS} value="FUTURE_STATUS" />))
    .toBe('<span class="chip chip--neutral">FUTURE_STATUS</span> ');
});

test("an unknown support state renders its word and code once", () => {
  expect(html(<EnumValue e={enums.SUPPORT_SESSION_STATE} value="FUTURE_SESSION" />))
    .toBe('확인되지 않은 항목 <span class="chip chip--neutral">FUTURE_SESSION</span>');
});

test("non-status words stay plain and extensible codes retain their diagnostic chip", () => {
  expect(html(<EnumValue e={enums.LEAVE_TYPE} value="WORK_INJURY" />)).toBe(`${t("enum.leaveType.WORK_INJURY")} `);
  const unknown = html(<EnumValue e={enums.LEAVE_TYPE} value="FUTURE_LEAVE" />);
  expect(unknown).toContain(t("enum.unknown"));
  expect(unknown).toContain('<span class="chip chip--neutral">FUTURE_LEAVE</span>');
  expect(unknown.match(/FUTURE_LEAVE/g)).toHaveLength(1);
  expect(html(<EnumCode e={enums.LEAVE_TYPE} value={null} />)).toBe("");
  expect(html(<EnumCode e={enums.LEAVE_TYPE} value="WORK_INJURY" />)).toBe("");
});
