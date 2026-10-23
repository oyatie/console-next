// SPDX-License-Identifier: LicenseRef-Proprietary
import { PORTS } from "./slot";

export async function requireActionInbox() {
  const inbox = await fetch(`http://127.0.0.1:${PORTS.backend}/api/v1/me/action-inbox`);
  if (inbox.status !== 401)
    throw new Error(`E2E action-inbox expected 401, got ${inbox.status}; build console-app with --features full,e2e-test-support and set CONSOLE_APP_BIN to that binary`);
}
