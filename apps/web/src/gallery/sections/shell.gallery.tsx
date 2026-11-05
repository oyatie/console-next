// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
import { tg } from "@console/i18n/gallery";
import { AccountMenu } from "../../shell/top-bar/account-menu";
import { NeedsMeMenu } from "../../shell/top-bar/needs-me";
import { TenantHead } from "../../shell/top-bar/tenant-head";
import { Section } from "../Section";

export const order = 15;

const seedFor = (active: boolean): components["schemas"]["ActionInboxResponse"] => ({
  as_of: "2026-11-04T09:00:00Z", has_work: active, available_filters: active ? ["turn"] : [],
  counts: { turn: { total: active ? 3 : 0, total_is_exact: true } }, total: active ? 3 : 0,
  total_is_exact: true, next_cursor: null, unavailable: [], upcoming: [], quick_starts: [],
  items: active ? [
    { id: "org_change:00000000-0000-4000-8000-000000000001", kind: "org_change_approve", urg: "today", ref: "", title: tg("button.primary"), dueTone: "warn", days_remaining: 2, done: false, lane: "turn", links: [{ kind: "org_change", id: "00000000-0000-4000-8000-000000000001" }] },
    { id: "employee:00000000-0000-4000-8000-000000000002", kind: "contract_renewal", urg: "wait", ref: "", title: tg("links.person"), dueTone: "neutral", days_remaining: null, done: false, lane: "turn", links: [{ kind: "employee", id: "00000000-0000-4000-8000-000000000002" }] },
  ] : [],
});

export default function ShellParts() {
  return (
    <Section title={tg("section.shell")}>
      {(["SETUP", "OPERATING"] as const).map(phase => (
        <div className="row" key={phase}>
          <TenantHead tenant={{ name: tg("sample.company"), phase, go_live_at: null }} />
          <NeedsMeMenu id={`gallery-needs-me-${phase}`} seed={seedFor(phase === "OPERATING")} />
          <AccountMenu id={`gallery-account-${phase}`} name={tg("sample.longName")} onLogout={() => window.location.assign("/login")} />
        </div>
      ))}
    </Section>
  );
}
