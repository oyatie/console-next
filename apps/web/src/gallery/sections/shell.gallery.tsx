// SPDX-License-Identifier: LicenseRef-Proprietary
import { tg } from "@console/i18n/gallery";
import { AccountMenu } from "../../shell/top-bar/account-menu";
import { TenantHead } from "../../shell/top-bar/tenant-head";
import { Section } from "../Section";

export const order = 15;

export default function ShellParts() {
  return (
    <Section title={tg("section.shell")}>
      {(["SETUP", "OPERATING"] as const).map(phase => (
        <div className="row" key={phase}>
          <TenantHead tenant={{ name: tg("sample.company"), phase, go_live_at: null }} />
          <AccountMenu id={`gallery-account-${phase}`} name={tg("sample.longName")} onLogout={() => window.location.assign("/login")} />
        </div>
      ))}
    </Section>
  );
}
