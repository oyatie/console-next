import { t } from "@console/i18n";

/** Ordered lifecycle steps; the current one is announced to assistive tech via aria-current. */
export function GateRail({ steps, current, failed }: { steps: { key: string; label: string }[]; current: string; failed?: boolean }) {
  const at = steps.findIndex((s) => s.key === current);
  return (
    <ol className="rail-steps" aria-label={t("common.steps")}>
      {steps.map((s, i) => (
        <li
          key={s.key}
          className="rail-steps__item"
          data-state={i < at ? "done" : i === at ? (failed ? "failed" : "current") : "todo"}
          aria-current={i === at ? "step" : undefined}
        >
          {s.label}
        </li>
      ))}
    </ol>
  );
}
