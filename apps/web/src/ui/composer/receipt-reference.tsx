// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { announce } from "../../lib/react/announce";
import { Button } from "../button/button";

/** The server's existing action/command number, kept intact when copied. */
export function ReceiptReference({ value }: { value: string }) {
  if (!value) return null;
  return <span>{t("composer.receipt.reference")} · <code>{value}</code> <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(value).then(() => announce(t("composer.receipt.copied")), () => announce(t("common.copyFailed")))}>{t("composer.receipt.copy")}</Button></span>;
}
