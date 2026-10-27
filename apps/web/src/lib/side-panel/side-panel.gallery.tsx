// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useId, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ApiError } from "@console/api";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { QueryState } from "../react/query-state";
import { EmptyState } from "../../ui/empty-state";
import { Button } from "../../ui/button/button";
import { buttonClass } from "../../ui/button/button-class";
import { Chip } from "../../ui/chip";
import { Card } from "../../ui/card/card";
import { SidePanel } from "../../ui/side-panel/side-panel";
import { useSidePanel } from "./use-side-panel";
import s from "../../ui/side-panel/side-panel.gallery.module.css";

export const order = 217;
const states = ["loading", "empty", "failed", "refused", "populated", "long", "large"] as const;

export default function SidePanelGallery() {
  const { selected, select, close } = useSidePanel();
  const id = useId();
  const returnFocus = useCallback(() => document.getElementById(`${id}-${selected}`), [id, selected]);
  const [retried, setRetried] = useState(false);
  const state = states.find(value => value === selected);
  const error = state === "failed" && !retried ? new ApiError(503, "service_unavailable", "", [], "gallery-panel-read")
    : state === "refused" ? new ApiError(403, "forbidden", "", [], "gallery-panel-refused") : null;
  return <section className="gallery__section" data-side-panel-gallery>
    <Card title={tg("sidePanel.section")}>
      <div className={s.layout}>
        <div className={s.rows}>
          {states.map(value => <Button key={value} id={`${id}-${value}`} data-panel-trigger={value} aria-expanded={state === value}
            onClick={() => { setRetried(false); select(value); }}>{tg(`sidePanel.${value}`)}</Button>)}
        </div>
        <SidePanel key={state} open={state !== undefined} title={state === "long" ? tg("sample.longName") : tg("sample.person", { n: 1 })}
          crumb={tg("sample.teamLong")} chips={<Chip>{tg("sample.position")}</Chip>}
          openLink={<Link to="/_gallery" className={buttonClass("primary")}>{t("people.panel.open")}</Link>}
          loading={state === "loading"} size={state === "large" ? "lg" : "peek"} onClose={close} returnFocus={returnFocus}>
          <QueryState q={{ isPending: false, error, data: error ? undefined : true, refetch: () => setRetried(true) }}>
            {() => state === "empty" ? <EmptyState title={tg("empty.title")} reason={tg("empty.reason")} />
              : <>{Array.from({ length: state === "long" ? 40 : 1 }, (_, index) => <p className={s.content} key={index}>{tg("sample.teamLong")} · {tg("sample.longPosition")}</p>)}</>}
          </QueryState>
        </SidePanel>
      </div>
    </Card>
  </section>;
}
