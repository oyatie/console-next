//! [`SetupFacts`] and the [`Records`] behind them, from the tenant's rows, in
//! the caller's transaction.

use console_identity_adapter_postgres::second_person::{HolderCapability, PgHolderResolver};
use console_identity_application::holders::HolderResolver;
use console_kernel_core::OrgId;
use console_onboarding_domain::{PreviewDetails, Record, Records, SetupFacts};
use console_settings_adapter_postgres::approval_routes_in_tx;
use console_settings_domain::SettingKey;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use crate::PgOnboardingError;

/// decisions.md #7's `tenant_security_contacts` store is not built
/// yet (identity face, `/api/v1/security-contact`). Until it lands the fact
/// is unavailable and neither the rail nor the preview mentions it; flip this
/// and read the store when it does (INTEG request).
const SECURITY_CONTACT_STORE_AVAILABLE: bool = false;

/// The live 법인, 등록, 사업장 and today's placements and 4대보험 status, as
/// the 법인·사업장 panels read them (latest revision as of today).
macro_rules! base {
    () => {
        "WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Seoul')::date AS d), \
     live AS (SELECT a.workplace_id FROM employment_assignments a, today \
              WHERE a.superseded_at IS NULL AND a.workplace_id IS NOT NULL AND a.valid_from <= today.d \
                AND (a.valid_to IS NULL OR a.valid_to > today.d)), \
     ent AS (SELECT e.*, (SELECT x.name FROM legal_entity_revisions x, today WHERE x.legal_entity_id = e.id \
                          ORDER BY x.effective_from > today.d, abs(x.effective_from - today.d), x.version DESC LIMIT 1) AS label \
             FROM legal_entities e WHERE e.voided_at IS NULL AND e.closed_on IS NULL), \
     reg AS (SELECT r.*, (SELECT x.name FROM legal_entity_revisions x, today WHERE x.legal_entity_id = r.legal_entity_id \
                          ORDER BY x.effective_from > today.d, abs(x.effective_from - today.d), x.version DESC LIMIT 1) AS label \
             FROM business_registrations r WHERE r.voided_at IS NULL AND r.closed_on IS NULL), \
     wp AS (SELECT w.*, (SELECT x.name FROM workplace_revisions x, today WHERE x.workplace_id = w.id \
                         ORDER BY x.effective_from > today.d, abs(x.effective_from - today.d), x.version DESC LIMIT 1) AS label \
            FROM workplaces w WHERE w.voided_at IS NULL AND w.closed_on IS NULL), \
     ins AS (SELECT DISTINCT ON (i.workplace_id, i.insurer) i.workplace_id, i.status \
             FROM workplace_insurance_revisions i, today WHERE i.workplace_id IN (SELECT id FROM wp) \
             ORDER BY i.workplace_id, i.insurer, i.effective_from > today.d, abs(i.effective_from - today.d), i.version DESC) "
    };
}

/// One row per record a counted preview line is about (company-49/-53): a
/// 사업장 is listed once per line however many of its 4대보험 are short. Each
/// line lists its records in the stored order (법인, then its 사업장), as the
/// breakdown and the chart do.
const RECORDS: &str = concat!(
    base!(),
    "SELECT x.code, x.kind, x.id::text AS id, COALESCE(x.label, '') AS name, x.entity::text AS entity FROM ( \
       SELECT 'entity_needs_confirmation' AS code, 'legal_entity' AS kind, id, label, id AS entity FROM ent WHERE needs_confirmation \
       UNION ALL SELECT 'no_primary_workplace', 'legal_entity', id, label, id FROM ent \
         WHERE primary_workplace_id IS NULL OR NOT EXISTS (SELECT 1 FROM wp WHERE wp.id = ent.primary_workplace_id) \
       UNION ALL SELECT 'registration_needs_confirmation', 'registration', id, label, legal_entity_id FROM reg WHERE needs_confirmation \
       UNION ALL SELECT 'registration_unverified', 'registration', id, label, legal_entity_id FROM reg WHERE verification_tier = 'NONE' \
       UNION ALL SELECT 'workplace_incomplete', 'workplace', id, label, legal_entity_id FROM wp \
         WHERE needs_confirmation OR default_branch_id IS NULL \
       UNION ALL SELECT 'staffed_workplace_without_registration', 'workplace', id, label, legal_entity_id FROM wp \
         WHERE registration_id IS NULL AND id IN (SELECT workplace_id FROM live) \
       UNION ALL SELECT 'workplace_without_registration', 'workplace', id, label, legal_entity_id FROM wp \
         WHERE registration_id IS NULL AND id NOT IN (SELECT workplace_id FROM live) \
       UNION ALL SELECT 'insurance_not_established_with_people', 'workplace', id, label, legal_entity_id FROM wp \
         WHERE id IN (SELECT workplace_id FROM ins WHERE status = 'NOT_ESTABLISHED') AND id IN (SELECT workplace_id FROM live) \
       UNION ALL SELECT 'insurance_numbers_pending', 'workplace', id, label, legal_entity_id FROM wp \
         WHERE id IN (SELECT workplace_id FROM ins WHERE status = 'ESTABLISHED_NUMBER_PENDING') \
     ) x LEFT JOIN legal_entities e ON e.id = x.entity \
       LEFT JOIN workplaces w ON x.kind = 'workplace' AND w.id = x.id \
       LEFT JOIN business_registrations r ON x.kind = 'registration' AND r.id = x.id \
     ORDER BY x.code, e.sort_order NULLS LAST, e.created_at, x.entity, \
       w.sort_order NULLS LAST, COALESCE(w.created_at, r.created_at), x.id"
);

const SCALARS: &str = concat!(
    base!(),
    "SELECT \
       (SELECT count(*) FROM ent) AS entities, \
       (SELECT count(*) FROM reg) AS registrations, \
       (SELECT count(*) FROM wp) AS workplaces, \
       (SELECT count(*) FROM (SELECT DISTINCT ON (org_unit_id) attributes FROM org_unit_revisions \
          ORDER BY org_unit_id, version DESC) units WHERE attributes->>'kind' IN ('department', 'team') \
          AND attributes->>'status' IS DISTINCT FROM 'dissolved') AS org_units, \
       EXISTS (SELECT 1 FROM tenant_phase_events WHERE kind = 'ORG_STEP_SKIPPED') AS org_step_skipped, \
       (SELECT count(*) FROM employees WHERE employment_status IN ('ACTIVE', 'ON_LEAVE', 'UNKNOWN') AND merged_into_employee_id IS NULL) AS employees, \
       (SELECT count(*) FROM employees WHERE employment_status = 'PRE_HIRE' AND merged_into_employee_id IS NULL) AS starting_later, \
       EXISTS (SELECT 1 FROM tenant_phase_events WHERE kind = 'EMPLOYEES_STEP_DEFERRED') AS employees_deferred, \
       (SELECT count(*) FROM access_roles WHERE status <> 'RETIRED') AS tenant_roles, \
       EXISTS (SELECT 1 FROM tenant_phase_events WHERE kind = 'ROLES_STEP_SKIPPED') AS roles_skipped, \
       (SELECT count(*) FROM employment_assignments WHERE superseded_at IS NULL AND cause = 'MIGRATION_UNMAPPED') AS unmapped, \
       (SELECT count(*) FROM org_change_requests WHERE status = 'IN_APPROVAL') AS in_approval, \
       (SELECT count(*) FROM audit_events WHERE org_id = NULLIF(current_setting('app.current_org', true), '')::uuid \
          AND classification_badges @> ARRAY['setup']) AS setup_writes, \
       (SELECT count(*) FROM auth_webauthn_credentials WHERE user_id = $1) AS own_passkeys"
);

async fn records(tx: &mut Transaction<'_, Postgres>) -> Result<Records, PgOnboardingError> {
    let rows = sqlx::query(RECORDS).fetch_all(tx.as_mut()).await?;
    let mut out = Records::new();
    for r in rows {
        out.entry(r.try_get::<String, _>("code")?)
            .or_default()
            .push(Record {
                kind: r.try_get("kind")?,
                id: r.try_get("id")?,
                name: r.try_get("name")?,
                legal_entity_id: r.try_get("entity")?,
            });
    }
    Ok(out)
}

/// Accounts Cedar lets decide an org change over the whole tenant (the ops
/// account through `platform.ops`), and how many of them are not `actor`.
/// A slice that does not compile or decide counts as no holder (fail closed).
/// one slice per active account; the pilot has a handful (ops + HR
/// workers). Batch the subjects if a routed tenant ever holds hundreds.
async fn org_change_deciders(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: Uuid,
) -> Result<(i64, i64), PgOnboardingError> {
    let holders = PgHolderResolver {
        tx,
        org,
        capability: HolderCapability::OrgChangeDecide,
        exclude_account: None,
        exclude_employee: None,
        include_ops: true,
        now: time::OffsetDateTime::now_utc(),
    }
    .resolve()
    .await?;
    let total = i64::try_from(holders.len()).unwrap_or(i64::MAX);
    Ok((total, total - i64::from(holders.contains(&actor))))
}

fn count(records: &Records, code: &str) -> i64 {
    records
        .get(code)
        .map_or(0, |r| i64::try_from(r.len()).unwrap_or(i64::MAX))
}

pub(crate) async fn setup_facts(
    tx: &mut Transaction<'_, Postgres>,
    (org, actor): (OrgId, Uuid),
    phase_is_setup: bool,
) -> Result<(SetupFacts, Records, PreviewDetails), PgOnboardingError> {
    let org_change_routed =
        approval_routes_in_tx(tx.as_mut(), org, SettingKey::ApprovalPolicyOrgStructure).await?;
    let r = sqlx::query(SCALARS)
        .bind(actor)
        .fetch_one(tx.as_mut())
        .await?;
    let mut listed = records(tx).await?;
    listed.extend(crate::people_facts::records(tx).await?);
    let (access, mut details) = crate::access_facts::load(tx, org).await?;
    let (terms_accepted, terms_version) = crate::terms::acceptance(tx).await?;
    details.terms_version = terms_version;
    details.breakdown = crate::people_facts::breakdown(tx).await?;
    // decisions #26: nothing reads the deciders under approval.policy = none.
    let (approvers, others) = if org_change_routed {
        org_change_deciders(tx, org, actor).await?
    } else {
        (0, 0)
    };
    let facts = SetupFacts {
        phase_is_setup,
        terms_accepted,
        entities: r.try_get("entities")?,
        entities_needing_confirmation: count(&listed, "entity_needs_confirmation"),
        registrations: r.try_get("registrations")?,
        registrations_needing_confirmation: count(&listed, "registration_needs_confirmation"),
        registrations_unverified: count(&listed, "registration_unverified"),
        entities_without_primary_workplace: count(&listed, "no_primary_workplace"),
        workplaces: r.try_get("workplaces")?,
        workplaces_incomplete: count(&listed, "workplace_incomplete"),
        staffed_workplaces_without_registration: count(
            &listed,
            "staffed_workplace_without_registration",
        ),
        empty_workplaces_without_registration: count(&listed, "workplace_without_registration"),
        org_units: r.try_get("org_units")?,
        org_step_skipped: r.try_get("org_step_skipped")?,
        org_change_approvers: approvers,
        other_eligible_holders: others,
        security_contact_recorded: false,
        security_contact_store_available: SECURITY_CONTACT_STORE_AVAILABLE,
        employees: r.try_get("employees")?,
        employees_starting_later: r.try_get("starting_later")?,
        employees_step_deferred: r.try_get("employees_deferred")?,
        unplaced_people: count(&listed, "unplaced_people"),
        entity_unknown_people: count(&listed, "entity_unknown_people"),
        tenant_roles: r.try_get("tenant_roles")?,
        roles_step_skipped: r.try_get("roles_skipped")?,
        unmapped_assignments: r.try_get("unmapped")?,
        insurance_not_established_with_people: count(
            &listed,
            "insurance_not_established_with_people",
        ),
        insurance_numbers_pending: count(&listed, "insurance_numbers_pending"),
        org_changes_in_approval: r.try_get("in_approval")?,
        setup_writes: r.try_get("setup_writes")?,
        own_passkeys: r.try_get("own_passkeys")?,
        org_change_routed,
        ..access
    };
    Ok((facts, listed, details))
}
