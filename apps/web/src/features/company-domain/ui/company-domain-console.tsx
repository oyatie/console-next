// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { outcomeUnknown, useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { validCompanyDomain } from "../../../lib/pure/company-domain";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { Dialog } from "../../../ui/dialog";
import { Field, TextInput } from "../../../ui/field/field";
import { StatRow } from "../../../ui/key-value/key-value";
import { ApiError, cancelDomainRequest, ownDomainRequest, requestDomain, verifyDomainRequest } from "../api";

const ownError = (code: string) =>
  code === "domain_request_conflict" ? t("account.domain.conflict") : undefined;

export function CompanyDomainConsole({
  signInId,
  ops,
}: {
  signInId?: string | null;
  ops?: boolean;
}) {
  const isOps = Boolean(ops);
  const domain = signInId?.split("@")[1];
  const pending = useQuery({ ...ownDomainRequest, enabled: isOps, staleTime: 0 });

  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState("");
  const [expectedPending, setExpectedPending] = useState<string | null | undefined>(undefined);

  const change = useCommand({
    run: requestDomain,
    verify: verifyDomainRequest,
    invalidates: ["/api/v1/tenant/company-domain"],
    onSuccess: () => setOpen(false),
    announce: () => t("account.domain.submitted"),
  });

  const cancel = useCommand({
    run: () => cancelDomainRequest(),
    invalidates: ["/api/v1/tenant/company-domain"],
    announce: () => t("account.domain.cancelled"),
  });

  const checking = outcomeUnknown(change.error);
  const valid = validCompanyDomain(requested) && requested !== domain;
  const pendingSlug = pending.data?.pending_domain ?? null;
  const conflict = change.error instanceof ApiError && change.error.code === "domain_request_conflict";

  const openFreshRequest = () => {
    setRequested(pendingSlug ?? "");
    setExpectedPending(pendingSlug);
    setOpen(true);
  };

  const aliases = pending.data?.domain_aliases ?? [];
  const accountCount = pending.data?.account_count;

  const consolePanel = (
    <Card title={t("shell.settings.domain")}>
      <StatRow
        label={t("account.domain.title")}
        items={[
          { key: "current", label: t("shell.settings.domain"), value: domain ?? pending.data?.current_domain ?? "—" },
          { key: "pending", label: t("account.domain.request"), value: pendingSlug ?? "—" },
          ...(typeof accountCount === "number"
            ? [{ key: "accounts", label: t("account.domain.accountCount", { count: accountCount }), value: String(accountCount) }]
            : []),
        ]}
      />
      <p className="code">{t("account.domain.current", { slug: domain ?? pending.data?.current_domain ?? "—" })}</p>
      {pendingSlug && (
        <Banner tone="ok">
          <div>{t("account.domain.pending", { slug: pendingSlug })}</div>
          {pending.data?.requested_by_name && (
            <div className="muted">
              {[
                t("account.domain.requestedBy", { name: pending.data.requested_by_name }),
                pending.data.requested_at ? fmtDate(pending.data.requested_at) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
        </Banner>
      )}
      {!isOps && <p>{t("account.domain.opsOnly")}</p>}
      <div className="form__actions">
        <Button disabled={!domain || !isOps || Boolean(pending.error)} onClick={openFreshRequest}>
          {t("account.domain.request")}
        </Button>
        {isOps && pendingSlug && (
          <>
            <Button variant="secondary" disabled={Boolean(pending.error)} onClick={openFreshRequest}>
              {t("account.domain.amend")}
            </Button>
            <Button
              variant="ghost"
              disabled={cancel.isPending || Boolean(pending.error)}
              onClick={() => cancel.mutate(undefined)}
            >
              {t("account.domain.cancelRequest")}
            </Button>
          </>
        )}
      </div>

      {aliases.length > 0 && (
        <Card title={t("account.domain.aliasesTitle")}>
          {aliases.map((alias) => (
            <div key={alias.slug} className="row">
              <span className="code">{alias.slug}</span>
              <Chip tone="neutral">
                {t("account.domain.aliasUntil", {
                  date: alias.alias_until ? fmtDate(alias.alias_until) : "—",
                })}
              </Chip>
            </div>
          ))}
        </Card>
      )}

      <Dialog
        open={open}
        title={t("account.domain.request")}
        onClose={() => setOpen(false)}
        dismissable={!requested}
      >
        <Banner>{t("account.domain.requestHint")}</Banner>
        {conflict && <Banner tone="warn">{t("account.domain.conflict")}</Banner>}
        <Field
          label={t("account.domain.requested")}
          required
          error={requested && !valid ? t("tenants.form.slugPattern") : undefined}
        >
          {(p) => (
            <TextInput
              {...p}
              value={requested}
              onChange={(e) => setRequested(e.target.value.toLowerCase())}
            />
          )}
        </Field>
        <CommandError error={change.error} own={ownError}>
          {checking && <Button onClick={() => change.check()}>{t("requestOutcome.find")}</Button>}
        </CommandError>
        <div className="form__actions">
          <Button disabled={change.isPending && !checking} onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!valid || change.isPending}
            onClick={() =>
              change.mutate(
                expectedPending !== undefined
                  ? { slug: requested, expectedPendingDomain: expectedPending }
                  : requested,
              )
            }
          >
            {t("account.domain.request")}
          </Button>
        </div>
      </Dialog>
    </Card>
  );

  return isOps ? <QueryState q={pending}>{() => consolePanel}</QueryState> : consolePanel;
}
