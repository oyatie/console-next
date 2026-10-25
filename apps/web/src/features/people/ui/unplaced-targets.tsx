import { Building2, Network } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Kbd } from "../../../ui/kbd/kbd";
import { PathPicker, type PathOption } from "../../../ui/path-picker/path-picker";
import type { Suggestion } from "../domain/unplaced";
import s from "./unplaced.module.css";

/**
 * The right pane (spec E8): where the picked people go. Suggestions by number key (names alike, then the places
 * used last), a search limited to the company, directly under the workplace, or leave them unplaced. Nothing is placed until a place is
 * pressed; with nobody picked every place says so.
 */
export function UnplacedTargets({ where, count, suggestions, options, sitePath, chosen, onChoose, onPlace, onSite, onSkip, pending, entity, when }: {
  where: string;
  count: number;
  suggestions: readonly Suggestion[];
  options: readonly PathOption[];
  /** The text of each suggestion's place. */
  sitePath: (unitId: string) => string;
  chosen: string;
  onChoose: (id: string) => void;
  onPlace: (unitId: string) => void;
  /** Directly under the company's workplace; null when the company has several (the search picks one). */
  onSite: (() => void) | null;
  onSkip: () => void;
  pending: boolean;
  entity: string | null;
  value: string;
  when?: ReactNode;
}) {
  const none = count === 0;
  const place = (id: string) => !none && !pending && onPlace(id);
  return (
    <aside className={s.targets} aria-label={none ? t("unplaced.target.titleNone") : t("unplaced.target.title", { n: count })}>
      <div className={s.targetsHead}>
        <span className={s.crumb}><Building2 size={12} aria-hidden />{where}</span>
        <div className={s.titleRow}>
          <h2 className={s.h2}>{none ? t("unplaced.target.titleNone") : t("unplaced.target.title", { n: count })}</h2>
        </div>
        {none && <span className={s.sub}>{t("unplaced.target.pickFirst")}</span>}
      </div>
      <div className={s.targetsBody}>
        {when}
        <div className={s.findRow}>
          <PathPicker options={options} value={chosen} onChange={onChoose} placeholder={entity ? t("unplaced.target.find", { entity }) : t("unplaced.target.findAll")} label={t("unplaced.target.findLabel")} openLabel={t("unplaced.target.open")} />
          {chosen && <Button variant="primary" aria-disabled={none || pending || undefined} onClick={() => place(chosen)}>{t("unplaced.target.place")}</Button>}
        </div>
        <div className={s.sec}>
          <span className={s.secHead}>{t("unplaced.target.suggest")}</span>
          {suggestions.map((g, i) => (
            <Button key={g.unit.id} variant="secondary" className={s.suggestion} aria-disabled={none || pending || undefined} onClick={() => place(g.unit.id)}>
              <Kbd keys={String(i + 1)} />
              <Network size={14} aria-hidden />
              <span className={s.grow}>{sitePath(g.unit.id)}</span>
              <small>{t(g.why === "alike" ? "unplaced.target.alike" : "unplaced.target.recent", { n: g.unit.headcount })}</small>
            </Button>
          ))}
        </div>
        <div className={s.row}>
          {onSite ? <Button aria-disabled={none || pending || undefined} onClick={() => !none && !pending && onSite()}>{t("unplaced.target.toSite")}</Button> : null}
          <Button variant="ghost" onClick={onSkip}>{t("unplaced.target.keep")}</Button>
        </div>

      </div>
    </aside>
  );
}
