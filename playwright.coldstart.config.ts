// SPDX-License-Identifier: LicenseRef-Proprietary
import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

// Cold start needs the empty stack before any worker enrolls the platform admin.
export default defineConfig({
  ...config,
  testIgnore: [],
  testMatch: ["**/coldstart/otp.spec.ts"],
  workers: 1,
});
