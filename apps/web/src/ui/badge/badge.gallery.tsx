// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Avatar } from "../avatar/avatar";
import { Button } from "../button/button";
import { Kbd } from "../kbd/kbd";
import { Badge } from "./badge";

export const order = 82;

/** Count badges and controls rendered both on the page surface and inside the `[data-surface="chrome"]` frame scope. */
export default function BadgeAndChromeGallery() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{t("settingsHub.key.display.experience")}</h2>
      <div className="row">
        <Button>{t("shell.link.todo")}<Badge count={23} /></Button>
        <Button variant="primary">{t("shell.link.approvals")}<Badge count={4} tone="inverse" /></Button>
        <Avatar name="M" size="sm" />
        <Avatar name="M" tone="accent" />
      </div>
      <div className="toolbar" data-surface="chrome">
        <Button variant="ghost" size="sm">{t("shell.link.todo")}<Badge count={23} tone="attention" /></Button>
        <Button variant="ghost" size="sm">{t("shell.link.approvals")}<Badge count={4} tone="attention" /></Button>
        <Button size="sm">{t("shell.jumpLabel")}<Kbd keys="/" /></Button>
        <Avatar name="M" size="sm" tone="accent" />
      </div>
    </section>
  );
}
