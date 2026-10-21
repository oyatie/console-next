import { useState } from "react";
import { Layers } from "lucide-react";
import { t } from "@console/i18n";
import { SelectField } from "../../../ui/select/select-field";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import type { AccessRole } from "../api";
import { linesText } from "../present";
import s from "./access.module.css";

/** Above this many roles the choice is a search, not a list (components.html §3). */
const MAX_LIST = 15;

/**
 * One role to grant (mockup M4): a compact dropdown listing each role with what it allows, or a search once the tenant has
 * more roles than a list holds. Nothing is preselected. `hideLabel`: the row's section label already names it.
 */
export function RolePick({ roles, value, onChange, error, label = t("access.grant.role"), hideLabel = false }: {
  roles: readonly AccessRole[];
  value: string | null;
  onChange: (id: string) => void;
  error?: string;
  label?: string;
  hideLabel?: boolean;
}) {
  const [q, setQ] = useState("");
  if (roles.length <= MAX_LIST)
    return (
      <SelectField
        label={label}
        hideLabel={hideLabel}
        options={roles.map((r) => ({ id: r.id, label: r.name_ko, description: linesText(r.lines) }))}
        value={value}
        onChange={onChange}
        placeholder={t("access.grant.role.pick")}
        icon={<Layers size={16} aria-hidden />}
        error={error}
      />
    );
  const hits = roles.filter((r) => r.name_ko.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className={s.stack}>
      <ServerPicker
        label={label}
        query={q}
        onQueryChange={setQ}
        options={hits.map((r) => ({ id: r.id, name: r.name_ko, context: linesText(r.lines) }))}
        value={value}
        onChange={(id) => id && onChange(id)}
        group={t("access.grant.role.group")}
        empty={t("access.grant.role.none")}
        isRequired
      />
      {error && <span className="field__error">{error}</span>}
    </div>
  );
}
