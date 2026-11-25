// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog } from "@console/i18n";
import { ApiError } from "@console/api";
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
    withheld: ["canvas", "inspector"],
  });

  // The toolbar holds the as-of date, a way out of a failed read: it waits for the first answer, then stays through a
  // failure, as Classic's page head does. A refusal removes it with the rest of the page.
  const strip = (q: typeof readyRead) => renderPatternMarkup(<CanvasPattern q={q} head={{ title: mark("head") }} toolbar={mark("toolbar")} canvas={mark("canvas")} />);
  expect(await strip({ ...readyRead, isPending: true, data: undefined })).not.toContain('data-contract-region="toolbar"');
  const failed = await strip({ ...readyRead, data: undefined, error: new ApiError(503, "service_unavailable", "", [], "canvas-fail") });
  expect(failed).toContain('data-contract-region="toolbar"');
  expect(failed).toContain("canvas-fail");
  expect(failed).not.toContain('data-contract-region="canvas"');

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
