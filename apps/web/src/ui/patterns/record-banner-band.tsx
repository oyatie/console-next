// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import s from "./record-banner-band.module.css";

/** Console sub-header strip under `PageHead` on `/people/$id` and list banners. */
export function RecordBannerBand({ tone = "neutral", children }: { tone?: "neutral" | "warn"; children: ReactNode }) {
  return (
    <div className={s.bannerBand} data-tone={tone}>
      {children}
    </div>
  );
}
