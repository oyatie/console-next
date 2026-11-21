// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import type { ReadState } from "../../lib/react/query-view";
import { Banner } from "../banner/banner";
import { Button, Check } from "../button/button";
import { Field } from "../field/field";
import { SelectInput } from "../field/select-input";
import { KeyValue, StatRow } from "../key-value/key-value";
import { Sheet } from "../sheet/sheet";
import { SettingsPattern } from "./settings";
import fx from "./pattern-fixture.module.css";

const READY: ReadState = { isPending: false, error: null, data: { count: 4 }, refetch() {} };

const CATEGORIES = [
  { id: "approval", labelKey: "pat.settings.catApproval" },
  { id: "domain", labelKey: "pat.settings.catDomain" },
  { id: "display", labelKey: "pat.settings.catDisplay" },
  { id: "locks", labelKey: "pat.settings.catLocks" },
] as const;

/** Synthetic no-network showcase for Settings (`P9`). */
export default function SettingsExample({ q = READY }: { q?: ReadState }) {
  const [category, setCategory] = useState<string>("approval");
  const [policyMode, setPolicyMode] = useState("route");
  const [notify, setNotify] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <SettingsPattern
      q={q}
      head={{
        title: tg("pat.settings.head"),
        titleId: "settings-pattern-title",
        actions: (
          <Button id="settings-inspect-btn" onClick={() => setInspectorOpen(true)}>
            {tg("pat.settings.inspectorTitle")}
          </Button>
        ),
      }}
      summary={
        <StatRow
          label={tg("pat.settings.head")}
          items={[
            { key: "active", label: tg("pat.settings.sumActive"), value: "4", active: true },
            { key: "scheduled", label: tg("pat.settings.sumScheduled"), value: "1", tone: "primary" },
            { key: "locks", label: tg("pat.settings.sumLocks"), value: "2", tone: "warn" },
          ]}
        />
      }
      views={
        <nav className={fx.settingsNav} aria-label={tg("pat.settings.navLabel")}>
          {CATEGORIES.map(item => (
            <button
              key={item.id}
              type="button"
              className={fx.settingsNavBtn}
              aria-current={category === item.id ? "page" : undefined}
              onClick={() => setCategory(item.id)}
            >
              <bdi>{tg(item.labelKey)}</bdi>
            </button>
          ))}
        </nav>
      }
      panel={
        <>
          <section className={fx.settingsSection} aria-labelledby="settings-sec-policy">
            <div className={fx.settingsSectionHead}>
              <h2 id="settings-sec-policy" className={fx.settingsSectionTitle}>
                {tg("pat.settings.catApproval")}
              </h2>
              <Button size="sm" onClick={() => setSheetOpen(true)}>
                {tg("pat.settings.overrideAction")}
              </Button>
            </div>
            <Field label={tg("pat.settings.policyLabel")} required={false}>
              {props => (
                <SelectInput {...props} value={policyMode} onChange={e => setPolicyMode(e.target.value)}>
                  <option value="route">{tg("pat.settings.policyRoute")}</option>
                  <option value="direct">{tg("pat.settings.policyDirect")}</option>
                </SelectInput>
              )}
            </Field>
            <Check checked={notify} onChange={setNotify}>
              {tg("pat.settings.notifyToggle")}
            </Check>
          </section>
          <section className={fx.settingsSection} aria-labelledby="settings-sec-domain">
            <h2 id="settings-sec-domain" className={fx.settingsSectionTitle}>
              {tg("pat.settings.catDomain")}
            </h2>
            <KeyValue
              label={tg("pat.settings.catDomain")}
              items={[
                { key: "domain", label: tg("pat.settings.domainRow"), value: tg("pat.settings.domainValue") },
              ]}
            />
          </section>
          <section className={fx.settingsSection} aria-labelledby="settings-sec-unavail">
            <h2 id="settings-sec-unavail" className={fx.settingsSectionTitle}>
              {tg("pat.settings.unavailableTitle")}
            </h2>
            <Banner tone="warn" title={tg("pat.settings.unavailableTitle")}>
              <bdi>{tg("pat.settings.unavailableBody")}</bdi>
            </Banner>
          </section>
        </>
      }
      record={
        inspectorOpen
          ? {
              id: "policy-history",
              label: tg("pat.settings.inspectorTitle"),
              title: tg("pat.settings.inspectorTitle"),
              onClose: () => setInspectorOpen(false),
              returnFocus: () => document.getElementById("settings-inspect-btn"),
              children: (
                <div className={fx.bandPad}>
                  <KeyValue
                    label={tg("pat.settings.inspectorTitle")}
                    density="dense"
                    items={[
                      { key: "sched", label: tg("pat.settings.overrideTitle"), value: tg("pat.settings.overrideDate") },
                      { key: "actor", label: tg("pat.settings.sumActive"), value: tg("pat.settings.inspectorActor") },
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
          title={tg("pat.settings.overrideTitle")}
          onClose={() => setSheetOpen(false)}
          consequence={null}
          actions={<Button onClick={() => setSheetOpen(false)}>{tg("pat.wizard.back")}</Button>}
        >
          <bdi>{tg("pat.settings.overrideDate")}</bdi>
        </Sheet>
      }
    />
  );
}
