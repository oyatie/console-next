// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { canvasOptionalRegions } from "./canvas-contract";
import { CanvasPattern } from "./canvas";
import { assertPatternLifecycle, makeHead, makeTabs, mark, notFoundRead, readyRead, renderPatternMarkup } from "./pattern-test-helpers";

beforeAll(() => loadCatalog("ko"));

test("CanvasPattern satisfies docked and SidePaneSpec inspector contracts including keepPreviousData 404 guard", async () => {
  await assertPatternLifecycle({
    pattern: "canvas",
    optionalRegions: canvasOptionalRegions,
    render: (q = readyRead) => (
      <CanvasPattern
        q={q}
        head={makeHead("canvas-contract-title")}
        tabs={makeTabs()}
        toolbar={mark("toolbar")}
        notes={mark("notes")}
        canvas={mark("canvas")}
        inspector={mark("inspector")}
        inspectorLabel="Inspector"
        foot={mark("foot")}
        facts={mark("facts")}
        overlays={mark("overlays")}
      />
    ),
    placed: ["head", "asOf", "tabs", "toolbar", "notes", "canvas", "foot", "inspector", "overlays"],
    stripped: ["asOf", "toolbar", "notes", "canvas", "foot", "inspector", "facts", "overlays"],
    withheld: ["toolbar", "canvas", "inspector"],
  });

  const sidePaneReady = await renderPatternMarkup(
    <CanvasPattern
      q={readyRead}
      head={{ title: mark("head") }}
      canvas={mark("canvas")}
      inspector={{ id: "unit-1", label: "Inspector", onClose() {}, children: mark("inspector") }}
    />,
  );
  expect(sidePaneReady).toContain('data-detail="true"');
  expect(sidePaneReady.match(/<aside\b/g)).toHaveLength(1);

  const sidePaneNotFound = await renderPatternMarkup(
    <CanvasPattern
      q={notFoundRead("missing-unit")}
      head={{ title: mark("head") }}
      canvas={mark("canvas")}
      inspector={{ id: "unit-1", label: "Inspector", onClose() {}, children: mark("inspector") }}
    />,
  );
  expect(sidePaneNotFound).not.toContain("data-detail");

  const emptyFragmentInspector = await renderPatternMarkup(
    <CanvasPattern q={readyRead} head={{ title: mark("head") }} canvas={mark("canvas")} inspector={<></>} inspectorLabel="Inspector" />,
  );
  const emptyArrayInspector = await renderPatternMarkup(
    <CanvasPattern q={readyRead} head={{ title: mark("head") }} canvas={mark("canvas")} inspector={[]} inspectorLabel="Inspector" />,
  );
  expect(emptyFragmentInspector).not.toContain("<aside");
  expect(emptyArrayInspector).not.toContain("<aside");
});
