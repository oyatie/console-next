import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import type { Coverage } from "../domain/coverage";

export type Part = "changes" | "decide" | "exits" | "review" | "renewals" | "failedActions" | "requests" | "insurance" | "unlocks" | "support";

/**
 * What the queue below could not show: parts this account may not read (no retry: asking again gets the same answer)
 * and parts that failed to load (one retry for all of them). Never silent, never "nothing to do".
 */
export function CoverageNotice({ c, retry }: { c: Coverage<Part>; retry: () => void }) {
  const parts = (keys: Part[]) => keys.map((k) => t(`home.part.${k}`)).join(" · ");
  return (
    <>
      {c.denied.length > 0 && (
        <section className="card panel" aria-labelledby="home-denied" data-testid="home-denied">
          <h2 id="home-denied" className="panel__title">{t("home.partial.denied.title")}</h2>
          <span className="muted">{t("home.partial.denied.reason", { parts: parts(c.denied) })}</span>
        </section>
      )}
      {c.failed.length > 0 && (
        <section className="card panel" role="alert" aria-labelledby="home-failed" data-testid="home-failed">
          <h2 id="home-failed" className="panel__title">{t("home.partial.failed.title")}</h2>
          <span className="muted">{t("home.partial.failed.reason", { parts: parts(c.failed) })}</span>
          <div className="row">
            <Button onClick={retry}>{t("common.retry")}</Button>
          </div>
        </section>
      )}
    </>
  );
}
