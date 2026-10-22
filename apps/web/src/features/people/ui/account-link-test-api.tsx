// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Mock } from "vitest";

/** The @console/api stand-in the two account-link component tests share: a fixed session, passkey and PATCH spies. */
export const accountLinkApi = (original: object, state: { assertion: Mock; patch: Mock }) => ({
  ...original,
  session: { claims: { sub: "01a15d08-533d-780f-8624-5284d9060bf9" } }, assertPasskey: state.assertion,
  api: { PATCH: state.patch }, unwrap: async (r: Promise<unknown>) => r,
});
