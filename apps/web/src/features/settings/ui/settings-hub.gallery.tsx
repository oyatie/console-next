// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Section } from "../../../gallery/Section";
import { SETTINGS_VIEWS } from "../../../shell/settings-views";
import { SettingsHubView } from "./settings-hub";

export const order = 129;
export default function SettingsHubGallery() {
  return <Section title={t("shell.link.settings")}><div data-settings-gallery>
    <SettingsHubView rows={SETTINGS_VIEWS} />
  </div></Section>;
}
