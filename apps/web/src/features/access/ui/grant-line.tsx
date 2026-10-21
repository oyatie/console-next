import { X } from "lucide-react";
import { t } from "@console/i18n";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import type { DraftLine, Missing } from "../domain/grants";
import type { AccessRole } from "../api";
import { EndPick } from "./end-pick";
import { RolePick } from "./role-pick";
import { ScopeButton } from "./scope-picker";
import s from "./access.module.css";

/**
 * One role, scope and end line of a grant (mockup M4): a row of role, scope and end chips under the section's one label, or,
 * `stacked` in a narrow side card (mockup M5), one control under another. `refusal` is the server's reason this line
 * was refused. The scope opens its own sheet view (`onPickScope`).
 */
export function GrantLine({ n, line, roles, today, missing, refusal, stacked = false, onChange, onPickScope, onRemove }: {
  n: number;
  line: DraftLine;
  roles: readonly AccessRole[];
  today: string;
  /** What this line still needs, shown once a save was tried (empty until then). */
  missing: readonly Missing[];
  refusal?: string;
  stacked?: boolean;
  onChange: (l: DraftLine) => void;
  onPickScope: () => void;
  onRemove?: () => void;
}) {
  const err = (m: Missing) => (missing.includes(m) ? t(`access.grant.missing.${m}`) : undefined);
  return (
    <fieldset className={stacked ? s.stackedLine : s.line} aria-label={t("access.grant.line", { n })}>
      <RolePick roles={roles} value={line.role_id} onChange={(role_id) => onChange({ ...line, role_id })} error={err("role") ?? err("duplicate")} hideLabel />
      <ScopeButton id={`ac-scope-${line.key}`} value={line.scope} error={err("scope")} onOpen={onPickScope} />
      <EndPick value={line.end} onChange={(end) => onChange({ ...line, end })} today={today} error={err("end") ?? err("end_past")} hideLabel />
      {!stacked && (onRemove ? <Button variant="ghost" aria-label={t("access.grant.line.remove", { n })} onClick={onRemove}><X size={16} aria-hidden /></Button> : <span />)}
      {refusal && <div className={s.full}><Banner tone="danger" live="assertive">{refusal}</Banner></div>}
    </fieldset>
  );
}
