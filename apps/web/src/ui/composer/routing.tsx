// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { ChainStepper, type ChainStep } from "../chain-stepper/chain-stepper";
import s from "./composer.module.css";

export type ComposerRouting = { routed: false; why: ReactNode } | { routed: true; steps: ChainStep[] };

/** Display the server's routing answer; the composer chooses its preview or commit position. */
export function RoutingPreview({ routing }: { routing: ComposerRouting }) {
  return routing.routed ? <ChainStepper steps={routing.steps} /> : <div className={s.head}>
    <div>{t("composer.routing.immediate")}</div>
    <details><summary>{t("uiBlocker.reason")}</summary><div>{routing.why}</div></details>
  </div>;
}
