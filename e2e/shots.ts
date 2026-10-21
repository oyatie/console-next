import type { Page } from "@playwright/test";

/** A full-page screenshot into $STRUCT_SHOTS when set (a fix's before/after evidence); nothing otherwise. */
export const shot = (page: Page, name: string) =>
  process.env.STRUCT_SHOTS ? page.screenshot({ path: `${process.env.STRUCT_SHOTS}/${name}.png`, fullPage: true }).then(() => undefined) : Promise.resolve();
