import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { TimelineLine } from "./timeline-line";
import { timelineStates } from "./states";
import { FieldDiff, type FieldChange } from "./field-diff";
import { RetentionChip } from "./retention-chip";

beforeAll(() => loadCatalog("ko"));
const secretAction = "secret action";

test.each(timelineStates)("%s has an explicit announced state and a focusable history target", (state) => {
  const line = html(<TimelineLine state={state} id="event" date="2026-10-09" />);
  expect(line).toContain(t(`timeline.state.${state}`));
  expect(line).toContain(`data-state="${state}"`);
  expect(line).toContain('id="event" tabindex="-1"');
});

test("the state and recorded act stay separated when they wrap on a narrow screen", () => {
  const title = "a recorded change";
  const line = html(<TimelineLine state="changed" date="2026-10-09" title={title} />);
  expect(line).toContain(`</span> · ${title}`);
});

test("a correction strikes the old value and keeps the reason and new value", () => {
  const line = html(<TimelineLine state="corrected" date="2026-10-09" reason="recording error"
    fields={[{ field: "unit", label: "unit", before: "old unit", after: "new unit" }]} />);
  expect(line).toContain("<del><span>old unit</span></del>");
  expect(line).toContain("new unit");
  expect(line).toContain("recording error");
});

test("withdrawn records keep their values and actions; scheduler-applied records name the system actor", () => {
  const title = "original act";
  const action = "history action";
  const line = html(<TimelineLine state="withdrawn" date="2026-10-09" title={title} actions={action}
    fields={[{ field: "unit", label: "unit", before: "old unit", after: "new unit" }]} />);
  for (const value of [title, action, "old unit", "new unit"]) expect(line).toContain(value);
  expect(html(<TimelineLine state="effectuated" date="2026-10-09" actorKind="SYSTEM" />)).toContain(t("timeline.system"));
});

test.each(["restricted", "destroyed"] as const)("%s never mounts values, reasons or caller actions", (state) => {
  const line = html(<TimelineLine state={state} date="2026-10-09" title="secret title" reason="secret reason"
    fields={[{ field: "unit", label: "unit", before: "secret before", after: "secret after" }]}
    retention={{ state: "hold", reason: "secret hold reason" }}
    actions={<button>{secretAction}</button>} />);
  expect(line).not.toContain("secret");
  expect(line).not.toContain("<button");
});

test("destroyed rows do not show an old hold reason or the actor's personal data", () => {
  const line = html(<TimelineLine state="destroyed" date="2026-10-09" actor="secret actor"
    retention={{ state: "hold", reason: "secret reason" }} />);
  expect(line).not.toContain("secret");
});

test("masking wins even when untyped transport data includes hidden values", () => {
  const untrusted = { field: "pay", label: "pay", masked: true, before: "secret before", after: "secret after" };
  const diff = html(<FieldDiff fields={[untrusted as FieldChange]} />);
  expect(diff).toContain(t("timeline.restricted"));
  expect(diff).not.toContain("secret");
  expect(diff).not.toContain("<details");
});

test("long text collapses under a keyboard-operable native disclosure; missing values are named", () => {
  const diff = html(<FieldDiff fields={[{ field: "note", label: "note", before: null, after: "x".repeat(181) }]} />);
  expect(diff).toContain(t("timeline.noValue"));
  expect(diff).toContain("<details");
  expect(diff).toContain(`<summary>${t("timeline.showFull")}</summary>`);
  expect(diff).not.toContain(" open=");
});

test("ops and support actors are badged independently of the change kind; new rows have a textual signal", () => {
  for (const [actorKind, state] of [["OPS_ACCOUNT", "emergency"], ["SUPPORT_OPERATOR", "operator"]] as const) {
    const line = html(<TimelineLine state="changed" date="2026-10-09" actorKind={actorKind} liveNew />);
    expect(line).toContain(t(`timeline.state.${state}`));
    expect(line).toContain(t("timeline.liveNew"));
    expect(line).toContain('data-highlight="true"');
  }
});

test("every retention state names its status and retained and held records name the boundary", () => {
  expect(html(<RetentionChip retention={{ state: "retained", until: "2029-10-09" }} />)).toContain("2029");
  expect(html(<RetentionChip retention={{ state: "hold", reason: "legal hold" }} />)).toContain("legal hold");
  for (const state of ["due", "destroyed"] as const) expect(html(<RetentionChip retention={{ state }} />)).toContain(t(`timeline.retention.${state}`));
});
