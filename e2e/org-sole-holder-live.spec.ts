// SPDX-License-Identifier: LicenseRef-Proprietary
import { test } from "@playwright/test";
import { soleHolderJourney } from "./helpers/sole-holder";

// Identity binding is a SQL fixture, so this proves the bound-identity approval path only.
test("a bound sole administrator decides every stored org approval step", async ({ browser }) => {
  test.setTimeout(300_000);
  await soleHolderJourney(browser);
});
