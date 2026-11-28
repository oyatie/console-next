// SPDX-License-Identifier: LicenseRef-Proprietary
import { codeText } from "../../lib/code-text";

export const vaultCode = (code: string) => codeText(`audit.vault.code.${code}`, code);
