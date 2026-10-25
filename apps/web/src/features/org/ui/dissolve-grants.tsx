import { personName } from "../../../reference/person/present";
import type { components } from "@console/api/schema";
import { KeyRound } from "lucide-react";
import { t } from "@console/i18n";
import { ChoiceField } from "../../../ui/choice/choice-field";
import type { GrantChoice } from "../domain/dissolve-plan";
import css from "../../../reference/org/ui/structure.module.css";
import { Muted } from "../../../ui/muted/muted";

type Grant = components["schemas"]["AccessGrant"];

/**
 * The access grants scoped to a closing department (org-06): each needs a choice before the dissolution can go — re-point it to
 * where the members go, or end it — on the same effective date. Nothing is preselected: access is never moved silently.
 */
export function DissolveGrants({ grants, choices, onChoose, toName, unreadable }: {
  grants: readonly Grant[];
  choices: ReadonlyMap<string, GrantChoice>;
  onChoose: (id: string, c: GrantChoice) => void;
  toName: string;
  unreadable: boolean;
}) {
  if (unreadable) return <p className={css.note}>{t("orgUnit.dissolve.grantsUnreadable")}</p>;
  if (grants.length === 0) return <p className={css.note}>{t("orgUnit.dissolve.grantsNone")}</p>;
  return (
    <ul className={css.list}>
      {grants.map((g) => (
        <li key={g.id} className={css.stack}>
          <span className="row"><KeyRound size={14} aria-hidden /><b>{personName(g.account_display_name, t("orgUnit.dissolve.grantAccount"))}</b><Muted>{g.role_name_ko}</Muted></span>
          <ChoiceField
            label={t("orgUnit.dissolve.grantChoice", { name: personName(g.account_display_name), role: g.role_name_ko })}
            required
            columns={2}
            options={[
              { value: "rescope", label: t("orgUnit.dissolve.grantRescope", { to: toName }) },
              { value: "end", label: t("orgUnit.dissolve.grantEnd") },
            ]}
            value={choices.get(g.id) ?? null}
            onChange={(v) => onChoose(g.id, v as GrantChoice)}
          />
        </li>
      ))}
    </ul>
  );
}
