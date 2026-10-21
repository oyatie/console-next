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
  const [slug, setSlug] = useState(org.pending_domain ?? "");
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
  if (policy.isPending) return null;
  return <Dialog open title={t("tenants.domain.change")} onClose={onClose} dismissable={!slug && !change.isPending}>
    <Form className="form" onSubmit={() => { if (valid && available.data?.available) change.mutate(slug); }}>
      <Field label={t("tenants.form.slug")} required error={slug && !valid ? t("tenants.form.slugPattern") : available.data?.available === false ? t("tenants.refusal.slug_taken") : undefined}
        hint={<>{t("tenants.form.slugHint")} {t("tenants.form.preview", { slug: slug || org.slug })} {policy.data && t("tenants.domain.until", { from: org.slug, until: fmtDate(new Date(openedAt + policy.data.alias_days * 24 * 60 * 60 * 1000).toISOString()) })}</>}>
        {(p) => <TextInput {...p} value={slug} onChange={(e) => setSlug(asSlug(e.target.value))} />}
      </Field>
      <CommandError error={policy.error}>{policy.error && <Button onClick={() => void policy.refetch()}>{t("common.retry")}</Button>}</CommandError>
      <CommandError error={available.error}>{available.error && <Button onClick={() => void available.refetch()}>{t("common.retry")}</Button>}</CommandError>
      <CommandError error={change.error}>{checking && <Button onClick={() => change.check()}>{t("requestOutcome.find")}</Button>}</CommandError>
      <div className="form__actions">
        <Button onClick={onClose} disabled={change.isPending && !checking}>{t("common.back")}</Button>
        <Button type="submit" variant="primary" disabled={change.isPending || available.isFetching || !valid || available.data?.available !== true}>{t("tenants.domain.change")}</Button>
      </div>
    </Form>
  </Dialog>;
}
