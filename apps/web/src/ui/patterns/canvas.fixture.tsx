// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { tg } from "@console/i18n/gallery";
import type { ReadState } from "../../lib/react/query-view";
import { Button } from "../button/button";
import { Segmented } from "../button/segmented";
import { TextInput } from "../field/field";
import { KeyValue } from "../key-value/key-value";
import { OrgCanvas, type CanvasHandle } from "../org-canvas/org-canvas";
import { NodeRow, NodeTag, OrgNode } from "../org-canvas/org-node";
import { Sheet } from "../sheet/sheet";
import { CanvasPattern } from "./canvas";
import fx from "./pattern-fixture.module.css";

const READY: ReadState = { isPending: false, error: null, data: { nodes: 4 }, refetch() {} };
const COMPACT_MEDIA = "(max-width: 767px)";

type DemoNode = {
  id: string;
  level: "tenant" | "entity" | "site" | "dept";
  labelKey: "pat.canvas.rootName" | "pat.canvas.entityName" | "pat.canvas.siteName" | "pat.canvas.deptName" | "pat.canvas.deptTwoName";
  countKey: "pat.canvas.headcountRoot" | "pat.canvas.headcountSite" | "pat.canvas.headcountDept";
  code: string;
  box: { x: number; y: number; w: number; h: number };
};

const WIDE_NODES: readonly DemoNode[] = [
  { id: "root", level: "tenant", labelKey: "pat.canvas.rootName", countKey: "pat.canvas.headcountRoot", code: "ORG-01", box: { x: 240, y: 36, w: 260, h: 64 } },
  { id: "entity", level: "entity", labelKey: "pat.canvas.entityName", countKey: "pat.canvas.headcountRoot", code: "ENT-01", box: { x: 240, y: 136, w: 260, h: 64 } },
  { id: "site", level: "site", labelKey: "pat.canvas.siteName", countKey: "pat.canvas.headcountSite", code: "SIT-01", box: { x: 80, y: 240, w: 240, h: 64 } },
  { id: "dept", level: "dept", labelKey: "pat.canvas.deptName", countKey: "pat.canvas.headcountDept", code: "DEP-11", box: { x: 380, y: 240, w: 240, h: 64 } },
];

const COMPACT_NODES: readonly DemoNode[] = [
  { id: "root", level: "tenant", labelKey: "pat.canvas.rootName", countKey: "pat.canvas.headcountRoot", code: "ORG-01", box: { x: 12, y: 16, w: 276, h: 48 } },
  { id: "entity", level: "entity", labelKey: "pat.canvas.entityName", countKey: "pat.canvas.headcountRoot", code: "ENT-01", box: { x: 12, y: 84, w: 276, h: 56 } },
  { id: "site", level: "site", labelKey: "pat.canvas.siteName", countKey: "pat.canvas.headcountSite", code: "SIT-01", box: { x: 36, y: 160, w: 252, h: 56 } },
  { id: "dept", level: "dept", labelKey: "pat.canvas.deptName", countKey: "pat.canvas.headcountDept", code: "DEP-11", box: { x: 36, y: 236, w: 252, h: 56 } },
];

const WIDE_LINES = [
  "M 370 100 V 136",
  "M 370 200 V 220 H 200 V 240",
  "M 370 220 H 500 V 240",
];

const COMPACT_LINES_ALL = [
  "M 150 64 V 84",
  "M 24 140 V 188 H 36",
  "M 24 188 V 264 H 36",
];

const COMPACT_LINES_SITES = [
  "M 150 64 V 84",
  "M 24 140 V 188 H 36",
];

/** Synthetic no-network showcase for Canvas (`P10`). */
export default function CanvasExample({ q = READY }: { q?: ReadState }) {
  const canvasRef = useRef<CanvasHandle>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(COMPACT_MEDIA).matches
      : false,
  );
  const [depth, setDepth] = useState<"all" | "sites">("all");
  const [find, setFind] = useState("");
  const [cursorId, setCursorId] = useState("root");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(COMPACT_MEDIA);
    const sync = () => setCompact(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const nodes = compact ? COMPACT_NODES : WIDE_NODES;
  const visibleNodes = depth === "sites" ? nodes.filter(n => n.level !== "dept") : nodes;
  const activeCursorId = visibleNodes.some(n => n.id === cursorId) ? cursorId : (visibleNodes[0]?.id ?? "");
  const inspected = nodes.find(n => n.id === selectedId) ?? null;
  const stageSize = compact ? { w: 300, h: depth === "sites" ? 236 : 316 } : { w: 720, h: 360 };
  const stageLines = compact ? (depth === "sites" ? COMPACT_LINES_SITES : COMPACT_LINES_ALL) : WIDE_LINES;

  useLayoutEffect(() => {
    if (document.activeElement?.getAttribute("role") === "treeitem" && stageRef.current?.contains(document.activeElement)) {
      document.getElementById(`node-${activeCursorId}`)?.focus({ preventScroll: true });
    }
  }, [activeCursorId]);

  const moveCursor = (nextIndex: number) => {
    const target = visibleNodes[Math.max(0, Math.min(visibleNodes.length - 1, nextIndex))];
    if (!target) return;
    setCursorId(target.id);
    canvasRef.current?.reveal(target.box);
  };

  return (
    <CanvasPattern
      q={q}
      head={{
        title: tg("pat.canvas.head"),
        titleId: "canvas-pattern-title",
        primary: { id: "add-unit", label: tg("pat.canvas.addUnit"), onAction: () => setSheetOpen(true) },
      }}
      toolbar={
        <>
          <div className={fx.canvasSearch}>
            <TextInput
              aria-label={tg("pat.canvas.findLabel")}
              placeholder={tg("pat.canvas.findLabel")}
              value={find}
              onChange={e => setFind(e.target.value)}
            />
          </div>
          <Segmented
            label={tg("pat.canvas.toolbarLabel")}
            value={depth}
            onChange={nextDepth => {
              setDepth(nextDepth);
              const nextVisible = nextDepth === "sites" ? nodes.filter(n => n.level !== "dept") : nodes;
              if (!nextVisible.some(n => n.id === cursorId)) {
                setCursorId(nextVisible[0]?.id ?? "");
              }
            }}
            items={[
              { id: "all", label: tg("pat.canvas.depthAll") },
              { id: "sites", label: tg("pat.canvas.depthSites") },
            ]}
          />
        </>
      }
      canvas={
        <OrgCanvas
          ref={canvasRef}
          stageRef={el => {
            stageRef.current = el;
          }}
          label={tg("pat.canvas.treeLabel")}
          resetKey={`${depth}-${compact ? "compact" : "wide"}`}
          size={stageSize}
          lines={stageLines}
          keep={(visibleNodes.find(n => n.id === activeCursorId) ?? visibleNodes[0])?.box}
          minimap={false}
          stage={{
            role: "tree",
            "aria-label": tg("pat.canvas.treeLabel"),
            onKeyDown: e => {
              const idx = visibleNodes.findIndex(n => n.id === activeCursorId);
              if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                e.preventDefault();
                moveCursor(idx + 1);
              } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                e.preventDefault();
                moveCursor(idx - 1);
              } else if (e.key === "Home") {
                e.preventDefault();
                moveCursor(0);
              } else if (e.key === "End") {
                e.preventDefault();
                moveCursor(visibleNodes.length - 1);
              } else if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setSelectedId(activeCursorId);
              }
            },
          }}
        >
          {visibleNodes.map((node, index) => {
            const matched = find.trim().length > 0 && tg(node.labelKey).toLowerCase().includes(find.trim().toLowerCase());
            const states = [
              ...(selectedId === node.id ? (["sel"] as const) : []),
              ...(matched ? (["hit"] as const) : []),
            ];
            return (
              <OrgNode
                key={node.id}
                id={`node-${node.id}`}
                level={node.level}
                box={node.box}
                states={states}
                role="treeitem"
                aria-level={index + 1}
                aria-selected={selectedId === node.id}
                tabIndex={activeCursorId === node.id ? 0 : -1}
                onFocus={() => setCursorId(node.id)}
                onClick={() => {
                  setCursorId(node.id);
                  setSelectedId(node.id);
                }}
              >
                <NodeRow name={tg(node.labelKey)} count={tg(node.countKey)} />
                {matched ? <NodeTag tone="hit">{node.code}</NodeTag> : null}
              </OrgNode>
            );
          })}
        </OrgCanvas>
      }
      foot={<div className={fx.canvasFoot}><bdi>{tg("pat.canvas.gutterHint")}</bdi></div>}
      inspector={
        inspected
          ? {
              id: inspected.id,
              label: tg("pat.canvas.inspectorLabel"),
              title: tg(inspected.labelKey),
              onClose: () => setSelectedId(null),
              returnFocus: () => document.getElementById(`node-${inspected.id}`),
              children: (
                <div className={fx.bandPad}>
                  <KeyValue
                    label={tg("pat.canvas.inspectorLabel")}
                    density="dense"
                    items={[
                      { key: "code", label: tg("pat.canvas.unitCode"), value: inspected.code },
                      { key: "count", label: tg("pat.canvas.inspectorLabel"), value: tg(inspected.countKey) },
                      { key: "lead", label: tg("pat.canvas.unitLead"), value: tg("pat.canvas.leadSample") },
                    ]}
                  />
                </div>
              ),
            }
          : undefined
      }
      overlays={
        <Sheet
          open={sheetOpen}
          title={tg("pat.canvas.sheetTitle")}
          onClose={() => setSheetOpen(false)}
          consequence={null}
          actions={<Button onClick={() => setSheetOpen(false)}>{tg("pat.wizard.back")}</Button>}
        >
          <bdi>{tg("pat.canvas.sheetBody")}</bdi>
        </Sheet>
      }
    />
  );
}
