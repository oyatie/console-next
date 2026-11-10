// SPDX-License-Identifier: LicenseRef-Proprietary
import { isMessageId, t } from "@console/i18n";

/** A server code in words when the catalog has `id` (written as a template so the copy gate sees it), else the code itself. */
export const codeText = (id: string, code: string, vars?: Record<string, string | number>) => (isMessageId(id) ? t(id, vars as never) : code);
