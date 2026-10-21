import { useState } from "react";
import { i18n, t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { Sheet } from "../../../ui/sheet/sheet";
import { createCrew, type Crew } from "../api";
import type { TreeNode } from "../domain/tree";
import { refusalText } from "../present";

/** Add a crew: a name within one workplace. People are placed afterwards, each from a date. */
function CrewSheetOpen({ open, workplaces, onClose, onAdded }: { open: boolean; workplaces: readonly TreeNode[]; onClose: () => void; onAdded: (c: Crew) => void }) {
  const [workplace, setWorkplace] = useState("");
  const [name, setName] = useState("");
  const run = useCommand({ run: (_: void, key: string) => createCrew({ workplace_id: workplace, name: name.trim() }, key), invalidates: ["/api/v1/attendance"], onSuccess: onAdded });
  const missing = [!workplace && t("attendanceCrews.crews.workplace"), !name.trim() && t("attendanceCrews.crews.name")].filter((x): x is string => !!x);
  const label = t("attendanceCrews.crews.add");
  return (
    <Sheet
      open={open}
      title={label}
      onClose={onClose}
      pending={run.isPending}
      notice={<CommandError error={run.error} own={refusalText} />}
      consequence={t("attendanceCrews.crews.consequence")}
      actions={
        <>
          <Button onClick={onClose}>{t("attendance.close")}</Button>
          {missing.length ? (
            <DisabledReason reason={t("attendanceSchedule.assign.missing", { fields: new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(missing) })} control={(p) => <Button {...p} variant="primary">{label}</Button>} />
          ) : (
            <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate()}>{label}</Button>
          )}
        </>
      }
    >
      <div className="form">
        <Field label={t("attendanceCrews.crews.workplace")} required>
          {(p) => (
            <SelectInput {...p} value={workplace} onChange={(e) => setWorkplace(e.target.value)}>
              <option value="">{t("attendanceCrews.crews.workplacePick")}</option>
              {workplaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </SelectInput>
          )}
        </Field>
        <Field label={t("attendanceCrews.crews.name")} required example={t("attendanceCrews.crews.name.example")}>
          {(p) => <TextInput {...p} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />}
        </Field>
      </div>
    </Sheet>
  );
}

export function CrewSheet(p: { open: boolean; workplaces: readonly TreeNode[]; onClose: () => void; onAdded: (c: Crew) => void }) {
  return p.open ? <CrewSheetOpen {...p} /> : null;
}
