// SPDX-License-Identifier: LicenseRef-Proprietary
import { ExternalLink } from "lucide-react";
import { t } from "@console/i18n";
import { STATUS_PAGE_URL } from "../../lib/live/status-origin";
import { buttonClass, type ButtonSize, type ButtonVariant } from "../button/button-class";

export function StatusPageLink({
  href = STATUS_PAGE_URL,
  variant = "secondary",
  size = "sm",
}: {
  href?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonClass(variant, { size })}
    >
      {t("live.statusPage")}
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}
