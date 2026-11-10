// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Button } from "../button/button";
import { FlexibleColumns } from "./flexible-columns";

export const order = 212;

function Example({ expanded = false }: { expanded?: boolean }) {
  const [full, setFull] = useState(expanded);
  const [depth, setDepth] = useState(2);
  return <FlexibleColumns full={full} onFull={setFull}
    list={<Button onClick={() => setDepth(2)}>{tg("sample.person", { n: 1 })}</Button>}
    record={depth > 0 && { id: "person", label: t("people.panel"), title: tg("sample.person", { n: 1 }), onClose: () => { setDepth(0); setFull(false); }, children: <Button onClick={() => { setDepth(2); setFull(false); }}>{tg("sample.dept")}</Button> }}
    related={depth > 1 && { id: "unit", label: t("roster.panel.unit"), title: tg("sample.dept"), crumb: tg("sample.company"), onClose: () => { setDepth(1); setFull(false); }, children: tg("sample.person", { n: 2 }) }}
  />;
}

export default function FlexibleColumnExamples() {
  return <section className="card gallery__section">
    <h2 className="toolbar__title">{t("uiFlexibleColumns.full")}</h2>
    <Example />
    <Example expanded />
  </section>;
}
