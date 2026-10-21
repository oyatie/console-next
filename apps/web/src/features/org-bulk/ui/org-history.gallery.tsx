import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { StaleMoveBanner } from "./stale-banner";
import { AsOfControl } from "./asof-control";

export const order = 401;

/** The today-only as-of control and the stale-move alert, with and without the unit still standing. */
export default function OrgHistoryGallery() {
  const [shown, setShown] = useState(true);
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.orgHistory")}</h2>
      <AsOfControl today="2026-10-06" />
      {shown && (
        <StaleMoveBanner
          name={tg("stale.name")}
          now={[tg("stale.entity"), tg("stale.site"), tg("stale.parent")]}
          tried={{ from: tg("stale.from"), to: tg("stale.to"), members: 9 }}
          onRetry={() => undefined}
          onLeave={() => setShown(false)}
        />
      )}
      <StaleMoveBanner name={tg("stale.name")} now={[]} tried={{ from: tg("stale.from"), to: tg("stale.to") }} onLeave={() => undefined} />
    </section>
  );
}
