import { t } from "@console/i18n";
import { diffLines, type Chosen } from "../domain/grid";
import { domainText, levelText } from "../present";
import s from "./access.module.css";

/** ROL-M2-role-edit: what saving a held role changes for its holders, domain by domain, before the reason and passkey. */
export function RoleDiff({ before, after, order }: { before: Chosen; after: Chosen; order: readonly string[] }) {
  const rows = diffLines(before, after, order);
  if (!rows.length) return null;
  return (
    <section aria-labelledby="ac-diff">
      <h3 id="ac-diff">{t("accessGrants.diff")}</h3>
      <ul className={s.lede}>
        {rows.map((r) => (
          <li key={r.domain}>
            <strong>{domainText(r.domain)}</strong>
            {r.added.length > 0 && <> · {t("accessGrants.diff.added", { levels: r.added.map(levelText).join("·") })}</>}
            {r.removed.length > 0 && <> · <span className={s.bad}>{t("accessGrants.diff.removed", { levels: r.removed.map(levelText).join("·") })}</span></>}
          </li>
        ))}
      </ul>
    </section>
  );
}
