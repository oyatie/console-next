import { tg } from "@console/i18n/gallery";
import { SetupRail, type SetupGroup } from "./setup-rail";

export const order = 218;

const act = (key: Parameters<typeof tg>[0]) => <button type="button" className="btn btn--primary">{tg(key)}</button>;
const GROUPS: SetupGroup[] = [
  {
    key: "company",
    title: tg("rail.company"),
    steps: [
      { key: "entity", title: tg("rail.entity"), state: "attention", detail: tg("rail.entityDetail") },
      { key: "workplace", title: tg("rail.workplace"), state: "done" },
    ],
  },
  {
    key: "ops",
    title: tg("rail.ops"),
    steps: [
      { key: "org", title: tg("rail.org"), state: "todo", action: act("rail.orgAction"), secondary: <button type="button" className="btn btn--ghost">{tg("rail.skip")}</button> },
      { key: "approval", title: tg("rail.approval"), state: "todo", action: act("rail.approvalAction") },
      { key: "contact", title: tg("rail.contact"), state: "todo", action: act("rail.contactAction") },
    ],
  },
  {
    key: "people",
    title: tg("rail.people"),
    steps: [
      { key: "employees", title: tg("rail.employees"), state: "blocked", detail: tg("rail.employeesBlocked"), remedy: act("rail.employeesRemedy") },
      { key: "golive", title: tg("rail.golive"), state: "todo", action: act("rail.goliveAction") },
    ],
  },
];

export default function SetupRailGallery() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.rail")}</h2>
      <SetupRail title={tg("rail.title")} summary={tg("rail.summary")} groups={GROUPS} />
    </section>
  );
}
