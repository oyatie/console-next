import { QueryState } from "../../../lib/react/query-state";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fmtDate } from "@console/i18n/format";
import { t } from "@console/i18n";
import { Button, Form } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { Dialog } from "../../../ui/dialog";
import { useCommand, outcomeUnknown } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { changeDomainSafely, verifyDomainChange, domainQuery, type Org, type Recorded } from "../api";
import { asSlug, slugProblem } from "../domain/slug";

export function DomainDialog({ org, onClose, onDone }: { org: Org; onClose: () => void; onDone: (r: Recorded) => void }) {
  const [openedAt] = useState(() => Date.now());
  const [slug, setSlug] = useState(org.slug);
  const valid = slugProblem(slug, []) === null;
  const available = useQuery({ ...domainQuery(slug), enabled: valid, staleTime: 0, retry: false });
  // Every availability answer carries the server's alias period; reading it for the current domain before the
  // dialog paints shows the consequence from the start, so no answer resizes the dialog under the typing.
  const policy = useQuery({ ...domainQuery(org.slug), retry: false });
  const change = useCommand({
    run: (next: string, key: string) => changeDomainSafely(org, next, key),
    verify: (next: string) => verifyDomainChange(org, next),
    invalidates: ["/api/platform"],
    onSuccess: (o) => onDone({ message: t("tenants.domain.done", { slug: o.slug }) }),
  });
  const checking = outcomeUnknown(change.error);
  return <Dialog open read title={t("tenants.domain.change")} onClose={onClose} dismissable={slug === org.slug && !change.isPending}>
    <QueryState q={policy} layout="form">{() => <Form className="form" onSubmit={() => { if (slug !== org.slug && valid && available.data?.available) change.mutate(slug); }}>
      <Field label={t("tenants.form.slug")} required error={slug && !valid ? t("tenants.form.slugPattern") : slug !== org.slug && available.data?.available === false ? t("tenants.refusal.slug_taken") : undefined}
        hint={<>{t("tenants.form.slugHint")} {t("tenants.form.preview", { slug: slug || org.slug })} {policy.data && t("tenants.domain.until", { from: org.slug, until: fmtDate(new Date(openedAt + policy.data.alias_days * 24 * 60 * 60 * 1000).toISOString()) })}</>}>
        {(p) => <TextInput {...p} value={slug} onChange={(e) => setSlug(asSlug(e.target.value))} />}
      </Field>
      {available.error && <QueryState q={available}>{() => null}</QueryState>}
      <CommandError error={change.error}>{checking && <Button onClick={() => change.check()}>{t("requestOutcome.find")}</Button>}</CommandError>
      <div className="form__actions">
        <Button onClick={onClose} disabled={change.isPending && !checking}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={slug === org.slug || change.isPending || available.isFetching || !valid || available.data?.available !== true}>{t("tenants.domain.change")}</Button>
      </div>
    </Form>}</QueryState>
  </Dialog>;
}
