// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import {
  consoleRolloutQuery,
  setConsoleKillSwitch,
  updateConsoleOptIn,
  updateConsoleOrgRollout,
} from "../../../reference/settings/api";
import { Button } from "../../../ui/button/button-base";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { Field } from "../../../ui/field/field";
import { TextInput } from "../../../ui/field/text-input";
import { ScreenStyleSettingsCard } from "./settings-cards";
import s from "./settings-hub.module.css";

export function RolloutPanel() {
  const q = useQuery(consoleRolloutQuery);
  const [note, setNote] = useState("");

  const toggleOrg = useCommand({
    run: (enabled: boolean) =>
      updateConsoleOrgRollout({
        enabled,
        ...(note.trim() ? { rollout_note: note.trim() } : {}),
      }),
    invalidates: ["/api/v1/console/rollout"],
    awaitFirstRead: true,
  });

  const toggleOptIn = useCommand({
    run: (optedIn: boolean) => updateConsoleOptIn({ opt_in: optedIn }),
    invalidates: ["/api/v1/console/rollout"],
    awaitFirstRead: true,
  });

  const toggleKillSwitch = useCommand({
    run: (enabled: boolean) =>
      setConsoleKillSwitch({
        enabled,
        ...(note.trim() ? { rollout_note: note.trim() } : {}),
      }),
    invalidates: ["/api/v1/console/rollout"],
    awaitFirstRead: true,
    onSuccess: () => setNote(""),
  });

  const err = toggleKillSwitch.error ?? toggleOrg.error ?? toggleOptIn.error;

  return (
    <div className={s.stack}>
      <ScreenStyleSettingsCard />

      <Card title={t("settingsHub.rollout.title")}>
        <CommandError error={err} />
        <QueryState q={q} inline own={() => t("settingsHub.unknown")}>
          {(data) => (
            <div className={s.stack}>
              <div className={s.row}>
                <span>{t("settingsHub.rollout.orgFlag")}</span>
                <div className={s.chips}>
                  <Chip tone={data.org_rollout_enabled ? "ok" : "neutral"}>
                    {t(data.org_rollout_enabled ? "settingsHub.on" : "settingsHub.off")}
                  </Chip>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={toggleOrg.isPending}
                    onClick={() => toggleOrg.mutate(!data.org_rollout_enabled)}
                  >
                    {t(data.org_rollout_enabled ? "settingsHub.off" : "settingsHub.on")}
                  </Button>
                </div>
              </div>

              <div className={s.row}>
                <span>{t("settingsHub.rollout.personalOptIn")}</span>
                <div className={s.chips}>
                  <Chip tone={data.user_opted_in ? "ok" : "neutral"}>
                    {t(data.user_opted_in ? "settingsHub.on" : "settingsHub.off")}
                  </Chip>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={toggleOptIn.isPending}
                    onClick={() => toggleOptIn.mutate(!data.user_opted_in)}
                  >
                    {t(data.user_opted_in ? "settingsHub.off" : "settingsHub.on")}
                  </Button>
                </div>
              </div>

              <div className={s.row}>
                <span>{t("settingsHub.rollout.killSwitchTitle")}</span>
                <Chip tone={data.kill_switch_active ? "warn" : "ok"}>
                  {t(
                    data.kill_switch_active
                      ? "settingsHub.rollout.killSwitchActive"
                      : "settingsHub.rollout.killSwitchInactive",
                  )}
                </Chip>
              </div>

              <Field label={t("settingsHub.rollout.noteLabel")} required={false}>
                {(props) => (
                  <TextInput
                    {...props}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                )}
              </Field>

              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={toggleKillSwitch.isPending}
                  onClick={() => toggleKillSwitch.mutate(!data.legacy_kill_switch_enabled)}
                >
                  {t(
                    data.legacy_kill_switch_enabled
                      ? "settingsHub.rollout.releaseKillSwitch"
                      : "settingsHub.rollout.activateKillSwitch",
                  )}
                </Button>
              </div>
            </div>
          )}
        </QueryState>
      </Card>
    </div>
  );
}
