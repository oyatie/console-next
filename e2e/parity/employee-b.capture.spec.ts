import { test } from "@playwright/test";
import { captureE3, captureE3Run } from "./e3";
import { captureE8 } from "./e8";
import { captureE5 } from "./e5";
import { captureE6 } from "./e6";
import { startOperations } from "../setup-flows";
import { parity, VIEW } from "./shot";
import { world } from "./world-b";

test.use(VIEW);

test("parity capture: employee action screens (E3, E5, E6, E8)", { tag: "@parity" }, async ({ browser, browserName }) => {
  parity();
  test.setTimeout(600_000);
  const admin = await world(browser);
  // The Firefox leg draws only the frames the spec has a Firefox variant of (E6-grid--firefox).
  const firefox = browserName === "firefox";
  if (!firefox) await captureE3(admin);
  if (!firefox) await captureE3Run(admin);
  if (!firefox) await captureE8(admin);
  await startOperations(admin);
  if (!firefox) await captureE5(admin);
  await captureE6(admin, firefox);
});
