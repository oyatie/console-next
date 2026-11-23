// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { label } from "../../../lib/labels";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { Button, Check, Form } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectField } from "../../../ui/select/select-field";
import {
  assignOrgToGroup,
  createGroup,
  createGroupAccount,
  updateGroup,
  type Group,
  type GroupRole,
  type Org,
  type OrgStatus,
  type TenantRole,
} from "../api";
import { asSlug } from "../domain/slug";
import { PLATFORM_GROUP_ROLE } from "../domain/tenants";
import s from "./platform-console.module.css";

const GROUP_ROLES: readonly GroupRole[] = ["GROUP_ADMIN", "GROUP_VIEWER", "GROUP_FINANCE"];
const TENANT_ROLES: readonly TenantRole[] = ["MEMBER", "ADMIN", "SUPER_ADMIN", "EXECUTIVE"];

type GroupFormProps = {
  open: boolean;
  group?: Group;
  onClose: () => void;
  onDone: (g: Group) => void;
};

export function GroupFormDialog(props: GroupFormProps) {
  if (!props.open) return null;
  return <GroupFormDialogBody {...props} />;
}

function GroupFormDialogBody({ open, group, onClose, onDone }: GroupFormProps) {
  const [name, setName] = useState(group?.name ?? "");
  const [slug, setSlug] = useState(group?.slug ?? "");
  const [status, setStatus] = useState<OrgStatus>(group?.status ?? "ACTIVE");
  const [tried, setTried] = useState(false);

  const save = useCommand({
    run: () =>
      group
        ? updateGroup(group.id, { name: name.trim(), slug: slug.trim(), status })
        : createGroup(slug.trim(), name.trim()),
    invalidates: ["/api/platform"],
    onSuccess: onDone,
  });

  const submit = () => {
    setTried(true);
    if (!name.trim() || !slug.trim()) return;
    save.mutate(undefined);
  };

  return (
    <Dialog open={open} title={t(group ? "tenants.groups.edit" : "tenants.groups.create")} onClose={onClose} dismissable={!save.isPending}>
      <Form className="form" onSubmit={submit} noValidate>
        <Field label={t("tenants.groups.form.name")} required error={tried && !name.trim() ? t("tenants.groups.form.required") : undefined}>
          {(p) => <TextInput {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label={t("tenants.groups.form.slug")} required error={tried && !slug.trim() ? t("tenants.groups.form.required") : undefined}>
          {(p) => <TextInput {...p} value={slug} onChange={(e) => setSlug(asSlug(e.target.value))} />}
        </Field>
        {group ? (
          <SelectField
            label={t("tenants.groups.form.status")}
            placeholder={t("tenants.groups.form.status")}
            value={status}
            onChange={(v) => setStatus(v as OrgStatus)}
            options={(["ACTIVE", "SUSPENDED", "ARCHIVED"] as const).map((st) => ({
              id: st,
              label: t(`enum.tenantStatus.${st}`),
            }))}
          />
        ) : null}
        <CommandError error={save.error} />
        <div className="form__actions">
          <Button onClick={onClose} disabled={save.isPending}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {t(group ? "tenants.groups.form.submitSave" : "tenants.groups.form.submitCreate")}
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}

type AssignOrgProps = {
  open: boolean;
  group: Group;
  orgs: readonly Org[];
  onClose: () => void;
  onDone: (org: Org) => void;
};

export function AssignOrgDialog(props: AssignOrgProps) {
  if (!props.open) return null;
  return <AssignOrgDialogBody {...props} />;
}

function AssignOrgDialogBody({ open, group, orgs, onClose, onDone }: AssignOrgProps) {
  const [orgId, setOrgId] = useState<string | null>(orgs[0]?.id ?? null);
  const assign = useCommand({
    run: (target: Org) => assignOrgToGroup(group.id, target.id),
    invalidates: ["/api/platform"],
    onSuccess: (_res, target) => onDone(target),
  });

  const picked = orgs.find((o) => o.id === orgId) ?? orgs[0];
  return (
    <Dialog open={open} title={t("tenants.groups.assignOrg")} onClose={onClose} dismissable={!assign.isPending}>
      <Form
        className="form"
        onSubmit={() => {
          if (picked) assign.mutate(picked);
        }}
        noValidate
      >
        <SelectField
          label={t("tenants.groups.pickOrg")}
          placeholder={t("tenants.groups.pickOrg")}
          value={picked?.id ?? null}
          onChange={setOrgId}
          options={orgs.map((o) => ({ id: o.id, label: `${o.name} (${o.slug})` }))}
        />
        <PasskeyError error={assign.error} />
        <div className="form__actions">
          <Button onClick={onClose} disabled={assign.isPending}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!picked || assign.isPending}>
            {t("tenants.groups.assignSubmit")}
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}

type CreateGroupAccountProps = {
  open: boolean;
  group: Group;
  onClose: () => void;
  onCreated: (res: Awaited<ReturnType<typeof createGroupAccount>>, orgName: string) => void;
};

export function CreateGroupAccountDialog(props: CreateGroupAccountProps) {
  if (!props.open) return null;
  return <CreateGroupAccountDialogBody {...props} />;
}

function CreateGroupAccountDialogBody({ open, group, onClose, onCreated }: CreateGroupAccountProps) {
  const [orgId, setOrgId] = useState<string | null>(group.members[0]?.id ?? null);
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [groupRole, setGroupRole] = useState<GroupRole>("GROUP_ADMIN");
  const [tenantRoles, setTenantRoles] = useState<Set<TenantRole>>(() => new Set(["MEMBER"]));
  const [tried, setTried] = useState(false);

  const pickedOrg = group.members.find((m) => m.id === orgId) ?? group.members[0];
  const create = useCommand({
    run: () =>
      createGroupAccount(group.id, {
        org_id: pickedOrg!.id,
        display_name: displayName.trim(),
        phone: phone.trim() || undefined,
        tenant_roles: tenantRoles.size > 0 ? [...tenantRoles] : ["MEMBER"],
        group_role: groupRole,
      }),
    invalidates: ["/api/platform"],
    forget: true,
    onSuccess: (res) => {
      const name = pickedOrg?.name ?? group.name;
      setDisplayName("");
      setPhone("");
      onCreated(res, name);
    },
  });

  const submit = () => {
    setTried(true);
    if (!pickedOrg || !displayName.trim()) return;
    create.mutate(undefined);
  };

  return (
    <Dialog open={open} title={t("tenants.groups.createAccount")} onClose={onClose} dismissable={!create.isPending}>
      <Form className="form" onSubmit={submit} noValidate>
        <SelectField
          label={t("tenants.groups.pickOrg")}
          placeholder={t("tenants.groups.pickOrg")}
          value={pickedOrg?.id ?? null}
          onChange={setOrgId}
          options={group.members.map((m) => ({ id: m.id, label: m.name }))}
        />
        <Field label={t("tenants.groups.accountName")} required error={tried && !displayName.trim() ? t("tenants.groups.form.required") : undefined}>
          {(p) => <TextInput {...p} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}
        </Field>
        <Field label={t("tenants.groups.accountPhone")} required={false}>
          {(p) => <TextInput {...p} value={phone} onChange={(e) => setPhone(e.target.value)} />}
        </Field>
        <SelectField
          label={t("tenants.groups.accountRole")}
          placeholder={t("tenants.groups.accountRole")}
          value={groupRole}
          onChange={(v) => setGroupRole(v as GroupRole)}
          options={GROUP_ROLES.map((r) => ({ id: r, label: label(PLATFORM_GROUP_ROLE, r) }))}
        />
        <div role="group" aria-label={t("tenants.groups.tenantRoles")} className={s.checkGroup}>
          <strong className="t-sm">{t("tenants.groups.tenantRoles")}</strong>
          {TENANT_ROLES.map((r) => (
            <Check
              key={r}
              checked={tenantRoles.has(r)}
              onChange={(checked) =>
                setTenantRoles((prev) => {
                  const next = new Set(prev);
                  if (checked) next.add(r);
                  else next.delete(r);
                  return next;
                })
              }
            >
              {t(`enum.role.${r}`)}
            </Check>
          ))}
        </div>
        <PasskeyError error={create.error} />
        <div className="form__actions">
          <Button onClick={onClose} disabled={create.isPending}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!pickedOrg || create.isPending}>
            {t("tenants.groups.accountSubmit")}
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}
