import { t } from "@console/i18n";
import s from "./record.module.css";
import { Kbd } from "./record-section";

/**
 * The record's section chips: number key, title and count; the current one is marked. A chip is an in-page link to
 * its section (digits 1–9 jump the same way, wired by the screen).
 */
export function SecNav({ items, current, onJump }: { items: { id: string; title: string; count?: number }[]; current: string; onJump: (id: string) => void }) {
  return (
    <nav className={s.secnav} aria-label={t("uiRecord.sections")}>
      {items.map((x, i) => (
        <a
          key={x.id}
          href={`#${x.id}`}
          aria-current={x.id === current || undefined}
          onClick={(e) => {
            e.preventDefault();
            onJump(x.id);
          }}
        >
          <Kbd k={String(i + 1)} />
          {x.title}
          {x.count != null && <span className={s.count}>{x.count}</span>}
        </a>
      ))}
    </nav>
  );
}
