import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { SectionHead } from "../../../ui/card/section-head";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Skeleton } from "../../../ui/skeleton/skeleton";
import { acceptTerms, SETUP_READS, termsQuery } from "../api";
import { onboardingError } from "../present";
import s from "./go-live.module.css";

/** The accepted hash comes from the displayed text; failed reads retain that text read-only. */
export function AcceptTerms() {
  const [open, setOpen] = useState(false);
  const q = useQuery({ ...termsQuery, enabled: open, retry: false });
  const run = useCommand({ run: () => acceptTerms(q.data!.version, q.data!.sha256), invalidates: SETUP_READS, announce: () => t("setup.terms.done") });
  return <>
    {!open && <Button onClick={() => setOpen(true)}>{t("setup.terms.read")}</Button>}
    {open && <div className={s.termsRead}>
      {q.isPending && <Skeleton bones={["title", "row", "row"]} label={t("common.loading")} />}
      {q.data && <section aria-labelledby="service-terms-title">
        <SectionHead level={3} id="service-terms-title">{t("setup.terms.title")}</SectionHead>
        <KeyValue items={[
          { key: "version", label: t("setup.terms.versionLabel"), value: q.data.version },
          { key: "hash", label: t("setup.terms.hashLabel"), value: <code className={s.termsText}>{q.data.sha256}</code> },
        ]} />
        <p className={s.termsText}>{q.data.body}</p>
        <Button disabled={q.isError || q.isFetching || run.isPending} onClick={() => run.mutate(undefined)}>{t("setup.terms.accept")}</Button>
      </section>}
      <CommandError error={q.error} own={onboardingError} />
      {q.isError && <Button onClick={() => void q.refetch()}>{t("common.retry")}</Button>}
    </div>}
    <CommandError error={run.error} own={onboardingError} />
  </>;
}
