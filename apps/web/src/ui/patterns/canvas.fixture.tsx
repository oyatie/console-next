// SPDX-License-Identifier: LicenseRef-Proprietary
import { useLayoutEffect, useRef, useState } from "react";
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

type DemoNode = {
  id: string;
  level: "tenant" | "entity" | "site" | "dept";
  labelKey: "pat.canvas.rootName" | "pat.canvas.entityName" | "pat.canvas.siteName" | "pat.canvas.deptName" | "pat.canvas.deptTwoName";
  countKey: "pat.canvas.headcountRoot" | "pat.canvas.headcountSite" | "pat.canvas.headcountDept";
  code: string;
  box: { x: number; y: number; w: number; h: number };
};

const NODES: readonly DemoNode[] = [
  { id: "root", level: "tenant", labelKey: "pat.canvas.rootName", countKey: "pat.canvas.headcountRoot", code: "ORG-01", box: { x: 240, y: 36, w: 260, h: 64 } },
  { id: "entity", level: "entity", labelKey: "pat.canvas.entityName", countKey: "pat.canvas.headcountRoot", code: "ENT-01", box: { x: 240, y: 136, w: 260, h: 64 } },
  { id: "site", level: "site", labelKey: "pat.canvas.siteName", countKey: "pat.canvas.headcountSite", code: "SIT-01", box: { x: 80, y: 240, w: 240, h: 64 } },
  { id: "dept", level: "dept", labelKey: "pat.canvas.deptName", countKey: "pat.canvas.headcountDept", code: "DEP-11", box: { x: 380, y: 240, w: 240, h: 64 } },
];

const LINES = [
  "M 370 100 V 136",
  "M 370 200 V 220 H 200 V 240",
  "M 370 220 H 500 V 240",
];

/** Synthetic no-network showcase for Canvas (`P10`). */
export default function CanvasExample({ q = READY }: { q?: ReadState }) {
  const canvasRef = useRef<CanvasHandle>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [depth, setDepth] = useState<"all" | "sites">("all");
  const [find, setFind] = useState("");
  const [cursorId, setCursorId] = useState("root");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const visibleNodes = depth === "sites" ? NODES.filter(n => n.level !== "dept") : NODES;
  const inspected = NODES.find(n => n.id === selectedId) ?? null;

  useLayoutEffect(() => {
    if (document.activeElement?.getAttribute("role") === "treeitem" && stageRef.current?.contains(document.activeElement)) {
      document.getElementById(`node-${cursorId}`)?.focus({ preventScroll: true });
    }
  }, [cursorId]);

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
            onChange={setDepth}
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
          resetKey={depth}
          size={{ w: 720, h: 360 }}
          lines={LINES}
          keep={(visibleNodes.find(n => n.id === cursorId) ?? visibleNodes[0])?.box}
          minimap={false}
          gutter={<bdi className={fx.canvasGutter}>{tg("pat.canvas.gutterHint")}</bdi>}
          stage={{
            role: "tree",
            "aria-label": tg("pat.canvas.treeLabel"),
            onKeyDown: e => {
              const idx = visibleNodes.findIndex(n => n.id === cursorId);
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
                setSelectedId(cursorId);
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
                tabIndex={cursorId === node.id ? 0 : -1}
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
