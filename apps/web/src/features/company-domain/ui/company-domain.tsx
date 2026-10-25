import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { t } from "@console/i18n";
import { Card } from "../../../ui/card/card";
import { Button } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { Dialog } from "../../../ui/dialog";
import { Banner } from "../../../ui/banner/banner";
import { useCommand, outcomeUnknown } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { ownDomainRequest, requestDomain, verifyDomainRequest } from "../api";
import { validCompanyDomain } from "../../../lib/pure/company-domain";

/** A company-domain change is carried to the platform operator through ops/support. */
export function CompanyDomain({ signInId, ops }: { signInId: string | null | undefined; ops: boolean }) {
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState("");
  const domain = signInId?.split("@")[1];
  const pending = useQuery({ ...ownDomainRequest, enabled: ops, staleTime: 0 });
  const change = useCommand({
    run: requestDomain,
    verify: verifyDomainRequest,
    invalidates: ["/api/v1/tenant/company-domain"],
    onSuccess: () => setOpen(false),
    announce: () => t("account.domain.submitted"),
  });
  const checking = outcomeUnknown(change.error);
  const valid = validCompanyDomain(requested) && requested !== domain;
  const card = <Card title={t("account.domain.title")}>
    <p className="code">{t("account.domain.current", { slug: domain ?? "—" })}</p>
    {pending.data?.pending_domain && <Banner tone="ok">{t("account.domain.pending", { slug: pending.data.pending_domain })}</Banner>}
    {!ops && <p>{t("account.domain.opsOnly")}</p>}
    <Button disabled={!domain || !ops || Boolean(pending.error)} onClick={() => setOpen(true)}>{t("account.domain.request")}</Button>
    <Dialog open={open} title={t("account.domain.request")} onClose={() => setOpen(false)} dismissable={!requested}>
      <Banner>{t("account.domain.requestHint")}</Banner>
      <Field label={t("account.domain.requested")} required error={requested && !valid ? t("tenants.form.slugPattern") : undefined}>
        {(p) => <TextInput {...p} value={requested} onChange={(e) => setRequested(e.target.value.toLowerCase())} />}
      </Field>
      <CommandError error={change.error}>{checking && <Button onClick={() => change.check()}>{t("requestOutcome.find")}</Button>}</CommandError>
      <div className="form__actions">
        <Button disabled={change.isPending && !checking} onClick={() => setOpen(false)}>{t("common.back")}</Button>
        <Button disabled={!valid || change.isPending} onClick={() => change.mutate(requested)}>{t("account.domain.request")}</Button>
      </div>
    </Dialog>
  </Card>;
  return ops ? <QueryState q={pending}>{() => card}</QueryState> : card;
}
