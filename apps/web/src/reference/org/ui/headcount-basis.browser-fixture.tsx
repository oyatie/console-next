// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoot } from "react-dom/client";
import { i18n, loadCatalog, t } from "@console/i18n";
import { HeadcountBasis } from "./headcount-basis";
import "../../../app.css";

const locale = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "ko";
await loadCatalog(locale);
i18n.set(locale);
// The chart's top edge passes the focused unit's total; the registry view and a unit panel pass nothing.
createRoot(document.getElementById("root")!).render(
  <main>
    <div id="chart"><HeadcountBasis>{t("structure.headcount.total", { count: 42 })}</HeadcountBasis></div>
    <div id="list"><HeadcountBasis /></div>
  </main>,
);
