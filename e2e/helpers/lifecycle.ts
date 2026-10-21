import type { Locator } from "@playwright/test";

/**
 * A reason code of a lifecycle sheet (BW-07) by its label, in the field `group` names: 「사유 분류」 (a transfer's or
 * promotion's reason), 「바꾸는 사유」 (a replaced reservation), 「정정 사유」 or 「철회 사유」 (BW-11).
 */
export const reasonChip = (s: Locator, label: string, group = "사유 분류") => s.getByRole("radiogroup", { name: new RegExp(`^${group}`) }).getByText(label, { exact: true });
