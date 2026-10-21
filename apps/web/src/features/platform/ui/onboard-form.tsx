import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isMessageId, t } from "@console/i18n";
import { announce } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button, Form } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { Field, TextInput } from "../../../ui/field/field";
import { LANDED, landed } from "../../../lib/react/landed";
import { failureText } from "../../../lib/refusal";
import { domainQuery, websiteHost, onboard, rereadTenants, slugRefused, type Issued, type Org } from "../api";
import { asSlug, openedBy, slugProblem, suggestedDomain } from "../domain/slug";
import styles from "./tenants.module.css";

type Onboarded = Issued & { onboarded: { id: string; slug: string } };

/**
 * Opens a tenant. While anything is typed the dialog ignores Esc and outside clicks, so typed input
 * is left only through the back button. lib/react/dirty-escape (arm, then a second Esc closes) serves inline
 * forms and leaves Esc inside a dialog alone, so it does not apply here.
 */
export function OnboardDialog({ open, existing, onClose, onIssued, onLost }: {
  open: boolean;
  existing: readonly Org[];
  onClose: () => void;
  onIssued: (r: Onboarded) => void;
  /** The tenant was created but the response (and its code) was lost before any HTTP status arrived. */
  onLost: (o: Org) => void;
}) {
  const [dirty, setDirty] = useState(false);
  const close = () => {
    setDirty(false);
    onClose();
  };
  return (
    <Dialog open={open} title={t("tenants.create")} onClose={close} dismissable={!dirty}>
      <OnboardForm existing={existing} onDirty={setDirty} onCancel={close} onIssued={onIssued} onLost={onLost} />
    </Dialog>
  );
}

function OnboardForm({ existing, onDirty, onCancel, onIssued, onLost }: {
  existing: readonly Org[];
  onDirty: (d: boolean) => void;
  onCancel: () => void;
  onIssued: (r: Onboarded) => void;
  onLost: (o: Org) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [website, setWebsite] = useState("");
  const suggestion = suggestedDomain(websiteHost(website));
  const available = useQuery({ ...domainQuery(slug.trim()), enabled: Boolean(slug.trim()) && slugProblem(slug, []) === null, staleTime: 0, retry: false });
  const suggested = useQuery({ ...domainQuery(suggestion ?? ""), enabled: suggestion !== null, staleTime: 0, retry: false });
  const [touched, setTouched] = useState({ name: false, slug: false });
  const known = useRef(new Set(existing.map((o) => o.id)));
  const problem = slugProblem(slug, existing);
  const create = useCommand({
    run: async ({ n, s }: { n: string; s: string }) => {
      // No idempotency key on onboarding (BW-25): a response lost before any status may still have opened the tenant,
      // without its code. Any HTTP answer is final (`[]`): a 409 is the server refusing the slug, never a tenant opened.
      let lost: Org | undefined;
      const r = await landed(() => onboard(n, s), rereadTenants, (all) => (lost = openedBy(all, s, known.current)) !== undefined, []);
      if (r === LANDED) return { lost: lost!, issued: null };
      return { lost: null, issued: { org: r.org.name, otp: r.otp, expiresAt: r.admin_otp_expires_at, onboarded: { id: r.org.id, slug: r.org.slug } } };
    },
    invalidates: ["/api/platform"],
    onSuccess: (r) => (r.issued ? onIssued(r.issued) : onLost(r.lost!)),
    forget: true, // the first SUPER_ADMIN's code is not kept once handed to the code dialog
  });
  // The server's refusal of the slug sent (409 slug_taken, 422 slug_invalid) stands on the field until the slug changes;
  // it outranks the list's own "taken", which the refusal's re-read brings in.
  const refused = create.variables?.s === slug.trim() ? slugRefused(create.error) : undefined;
  // Focus goes to the refused field once it renders as invalid (the mutation's own callbacks run before that render).
  useEffect(() => {
    if (refused) focusInvalid();
  }, [refused]);
  const errors = {
    name: name.trim() ? undefined : t("tenants.form.nameRequired"),
    slug: refused ? failureText(refused, slugRefusal) : !slug.trim() ? t("tenants.form.slugRequired") : problem?.kind === "pattern" ? t("tenants.form.slugPattern") : problem?.kind === "taken" ? t("tenants.form.slugTaken", { org: problem.org }) : available.data?.available === false ? t("tenants.refusal.slug_taken") : undefined,
  };
  const edit = (field: "name" | "slug", v: string) => {
    const next = { name, slug, [field]: v };
    if (field === "name") setName(v);
    else setSlug(asSlug(v));
    onDirty(Boolean(next.name || next.slug));
  };
  const submit = () => {
    setTouched({ name: true, slug: true });
    const bad = [errors.name, errors.slug].filter(Boolean).length;
    if (bad || available.data?.available !== true) {
      // The errors render with this state change; focus the first one once they are in the page.
      requestAnimationFrame(focusInvalid);
      announce(t("tenants.form.errors", { count: bad }));
      return;
    }
    create.mutate({ n: name.trim(), s: slug.trim() });
  };
  return (
    <Form id="tenant-onboard" className="form" onSubmit={submit} noValidate>
      <Field label={t("tenants.form.name")} required error={touched.name ? errors.name : undefined}>
        {(p) => <TextInput {...p} value={name} onChange={(e) => edit("name", e.target.value)} onBlur={() => setTouched((x) => ({ ...x, name: true }))} />}
      </Field>
      <Field label={t("tenants.form.slug")} required error={touched.slug ? errors.slug : undefined}>
        {(p) => <><TextInput {...p} className="code" value={slug} onChange={(e) => { edit("slug", e.target.value); setTouched((x) => ({ ...x, slug: true })); }} onBlur={() => setTouched((x) => ({ ...x, slug: true }))} /><output htmlFor={p.id} className="code">{t("tenants.form.preview", { slug: slug.trim() || "acme" })}</output></>}
      </Field>
      <output className={styles.availability}>{available.isFetching ? t("common.loading") : available.data?.available && !errors.slug ? t("tenants.form.available") : ""}</output>
      <CommandError error={available.error}>{available.error && <Button onClick={() => void available.refetch()}>{t("common.retry")}</Button>}</CommandError>
      <Field label={t("tenants.form.website")} required={false}>
        {(p) => <TextInput {...p} value={website} onChange={(e) => { setWebsite(e.target.value); onDirty(true); }} />}
      </Field>
      {suggestion && suggested.data?.available && <Button onClick={() => edit("slug", suggestion)}>{t("tenants.form.suggest", { slug: suggestion })}</Button>}
      <CommandError error={refused ? null : create.error} />
      <div className="form__actions">
        <Button onClick={onCancel}>{t("common.back")}</Button>
        <Button type="submit" variant="primary" disabled={create.isPending || available.isFetching || available.data?.available !== true}>{t("tenants.form.submit")}</Button>
      </div>
    </Form>
  );
}

const focusInvalid = () => document.querySelector<HTMLElement>('#tenant-onboard [aria-invalid="true"]')?.focus();

/** The onboarding refusals worded with their remedy (`tenants.refusal.<code>`); others fall back to failureText. */
const slugRefusal = (code: string) => {
  const id = `tenants.refusal.${code}`;
  return isMessageId(id) ? t(id) : undefined;
};
