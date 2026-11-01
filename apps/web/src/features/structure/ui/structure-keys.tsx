// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { t } from "@console/i18n";
import { CircleHelp } from "lucide-react";
import { Button } from "../../../ui/button/button";
import { editable } from "../../../ui/long-table/row-keys";
import { KeyMap } from "../../../ui/palette/key-map";
import { CHART_KEYS } from "./use-chart-keys";

const OUTLINE = [["navigate", ["↑", "↓", "←", "→"]], ["addBelow", ["Enter"]], ["nest", ["Tab", "Shift Tab"]], ["rename", ["F2"]], ["finish", ["Esc"]]] as const;
const keyLabel = (key: string) => key.replace(/ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Escape/g, k => ({ ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc" })[k]!);

export function StructureKeys({ view }: { view: "chart" | "outline" }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = (event: KeyboardEvent) => {
      if (event.key !== "?" || event.ctrlKey || event.metaKey || event.altKey || editable(event.target) || document.querySelector("[role=dialog]")) return;
      event.preventDefault();
      setOpen(true);
    };
    document.addEventListener("keydown", show);
    return () => document.removeEventListener("keydown", show);
  }, []);
  const group = (id: "chart" | "outline", entries: typeof CHART_KEYS | typeof OUTLINE) => ({ id, title: t(`structure.view.${id}`), keys: entries.map(([command, keys]) => ({ keys: keys.map(keyLabel), what: t(`structure.shortcuts.${command}`) })) });
  return <>
    <Button variant="ghost" aria-label={t("structure.shortcuts.title")} aria-keyshortcuts="Shift+/" onClick={() => setOpen(true)}><CircleHelp size={16} aria-hidden /></Button>
    <KeyMap open={open} onClose={() => setOpen(false)} title={t("structure.shortcuts.title")} groups={[...(view === "outline" ? [group("outline", OUTLINE)] : []), group("chart", CHART_KEYS)]} />
  </>;
}
