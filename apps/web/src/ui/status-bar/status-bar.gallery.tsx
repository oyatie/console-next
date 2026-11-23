// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Kbd } from "../kbd/kbd";
import { StatusBar } from "./status-bar";

export const order = 85;

/** Bottom frame status bar with strong leading segment, neutral facts, attention count, and trailing key hint. */
export default function StatusBarGallery() {
  return (
    <section className="card gallery__section" data-status-bar-gallery>
      <h2 className="toolbar__title">{t("shell.status.label")}</h2>
      <StatusBar
        segments={[
          { id: "tenant", content: tg("pageHead.title") },
          { id: "status", content: tg("pageHead.status") },
          { id: "attention", content: tg("banner.warnTitle"), tone: "attention" },
        ]}
        trailing={
          <>
            <bdi>{t("shell.jumpLabel")}</bdi>
            <Kbd keys="/" />
          </>
        }
      />
    </section>
  );
}
