//! The global-table allowlist, out of the pinned `lib.rs` so lanes can add a
//! row without growing it (file-size ratchet).

/// Tables that are intentionally GLOBAL — no `org_id`. RLS may limit global
/// visibility. Each entry gives a rationale so a reviewer can see exactly
/// why tenant isolation does not apply. A NEW table that is neither tenant-scoped nor
/// listed here is flagged `UnclassifiedTable` (the forward-looking guard).
#[must_use]
pub fn global_table_allowlist() -> &'static [(&'static str, &'static str)] {
    &[
        (
            "platform_setting_overrides",
            "operator-owned registry values, no tenant content or secrets; runtime SELECT only",
        ),
        (
            "registration_check_daily_budget",
            "platform-wide UTC outbound quota counter; no tenant content; runtime role can only claim a bounded count through SECURITY DEFINER",
        ),
        (
            "support_read_surfaces",
            "migration-owned read-surface and field-classification reference data; no tenant content",
        ),
        // Conglomerate grouping identity only. Authorization data is NOT here:
        // group_memberships and group_role_grants are owner-only resolver tables.
        ("groups", "group identity metadata only, no tenant data"),
        (
            "feature_catalog",
            "canonical policy feature keys only, no tenant data",
        ),
        // Platform-wide object-kind registry (work_order, person, equipment...):
        // the same closed, seeded set for every tenant. object_links FKs to it
        // but the kinds themselves are not tenant data.
        (
            "object_types",
            "canonical object-kind registry, seeded platform-wide, no tenant data",
        ),
        (
            "lifecycle_transition_rules",
            "global seeded lifecycle FSM rules (object_type/from/to), no tenant data",
        ),
        // Platform-wide edge-type vocabulary (relates_to, depends_on, ...):
        // the same closed, seeded set for every tenant. object_links FKs to it
        // but the labels themselves are not tenant data.
        (
            "link_types",
            "canonical edge-type vocabulary, seeded platform-wide, no tenant data",
        ),
        // The statutory rate citation register (국민연금/건강보험/장기요양/
        // 고용/산재 요율, 기준소득월액 밴드, 최저임금, 간이세액표 versions). These
        // are the law: identical for every tenant, carrying no tenant data, and
        // NOT operator-writable — console_rt holds SELECT only, so a tenant
        // cannot write a rate row it could then read back. Rates change by
        // migration, which means by deploy, which means by professional review.
        (
            "payroll_statutory_rates",
            "statutory rate citations, identical for every tenant, SELECT-only to console_rt",
        ),
        // BW-30 statutory register: legal numbers, clocks and 4대보험 상실
        // codes. Same reasoning as payroll_statutory_rates (migration-only,
        // SELECT-only to console_rt, never tenant-overridable).
        ("statutory_rules", "BW-30 law reference rows, global"),
        (
            "statutory_filing_drafts",
            "unverified jurisdiction-register filing rules, migration-only and SELECT-only to console_rt; separate from N-1 core readers",
        ),
        // ATT S1: 공휴일 per 관공서 규정 §2/§3 and 노동절, bundled reference data
        // (migration-only, SELECT-only to console_rt), identical for every tenant.
        (
            "attendance_public_holidays",
            "statutory 공휴일 reference rows, global, SELECT-only to console_rt",
        ),
        // MB-2: §54① break floor and the 2026-12-10 4-hour waiver. Migration-only,
        // identical for every tenant, SELECT-only to console_rt.
        (
            "attendance_break_floors",
            "statutory §54 break-floor rows, global, SELECT-only to console_rt",
        ),
        ("insurance_loss_codes", "BW-30 law reference rows, global"),
        // Pre-auth throttle: keyed on (ip, purpose), exists before any user/org
        // is resolved. Transient, no tenant.
        ("auth_rate_limit", "pre-auth throttle, no resolved tenant"),
        // WebAuthn ceremony state: a registration/login ceremony exists before
        // the user (and therefore the org) is known; user_id is nullable.
        (
            "auth_webauthn_ceremonies",
            "pre-auth ceremony state, user/org not yet resolved",
        ),
        (
            "auth_webauthn_ceremony_bindings",
            "transient WebAuthn action binding keyed to global ceremony state",
        ),
        // Cross-device login handoff state: a desktop starts polling before the
        // approving phone has proven user/org/passkey possession. It stores
        // split-token hashes plus optional target/approved identity columns,
        // expires quickly, and is not tenant business data.
        (
            "auth_device_login_handoffs",
            "pre-auth cross-device login handoff, tenant resolved only after approval",
        ),
        // Apalis job/queue tables: created and owned by the apalis-postgres
        // worker runtime, NOT by our migrations. Listed so that if a future
        // migration ever does touch them, the classifier already accounts for
        // their global, non-tenant nature.
        ("apalis_jobs", "apalis worker-owned queue table (platform)"),
        (
            "apalis_workers",
            "apalis worker-owned heartbeat table (platform)",
        ),
        // location_pings is a PARTITIONED table; its monthly partition children
        // are created dynamically (`CREATE TABLE %I PARTITION OF location_pings`)
        // and inherit RLS from the parent. The parent itself IS tenant-scoped and
        // is checked normally; partition children are not independently scanned.
        // --- lane: RT --- realtime emission allowlist; SELECT-only to console_rt.
        (
            "realtime_topic_map",
            "audit-to-event type vocabulary, no tenant data",
        ),
        // --- lane: LC-B3 --- lifecycle case templates: versioned, cited reference
        // rows, the same for every tenant, migration-only, SELECT-only to
        // console_rt. A tenant's own additions live in tenant_case_template_items (RLS).
        (
            "case_templates",
            "LC-B3 case template versions, global reference data",
        ),
        (
            "case_template_items",
            "LC-B3 case template rows, global reference data",
        ),
        (
            "lifecycle_case_triggers",
            "LC-B6 event-to-template reference vocabulary, SELECT-only to console_rt",
        ),
        (
            "lifecycle_country_packs",
            "LC-B6 jurisdiction zone defaults, SELECT-only to console_rt",
        ),
        // Approved contract text is immutable and identical for every tenant.
        // Acceptance records stay in tenant_terms_acceptances with tenant RLS.
        (
            "terms_documents",
            "immutable approved service terms, identical for every tenant, SELECT-only to console_rt",
        ),
    ]
}

#[cfg(test)]
mod tests {
    use crate::{GateResult, ViolationKind, evaluate_facts, sanitize_sql, scan_file};
    use std::{collections::HashMap, path::Path};

    fn check(sql: &str) -> GateResult {
        let mut facts = HashMap::new();
        let mut result = GateResult::default();
        scan_file(
            Path::new("terms.sql"),
            sql,
            &sanitize_sql(sql),
            &mut facts,
            &mut result,
        );
        evaluate_facts(&facts, &mut result);
        result
    }

    #[test]
    fn global_select_policy_does_not_require_a_tenant_policy() {
        let result = check(
            "CREATE TABLE terms_documents (version text primary key, published_at timestamptz);
             ALTER TABLE terms_documents ENABLE ROW LEVEL SECURITY;
             ALTER TABLE terms_documents FORCE ROW LEVEL SECURITY;
             CREATE POLICY published_terms ON terms_documents FOR SELECT USING (published_at <= now());",
        );
        assert!(
            result.passed(),
            "global read policy was refused: {:?}",
            result.violations
        );
    }

    #[test]
    fn published_terms_migration_keeps_acceptances_tenant_scoped() {
        let result = check(include_str!(
            "../../../../crates/platform/db/migrations/0350_first_run_terms.sql"
        ));
        assert!(
            result.passed(),
            "terms migration was refused: {:?}",
            result.violations
        );
    }

    #[test]
    fn global_rls_without_force_is_refused() {
        let result = check(
            "CREATE TABLE terms_documents (version text primary key);
             ALTER TABLE terms_documents ENABLE ROW LEVEL SECURITY;
             CREATE POLICY published_terms ON terms_documents FOR SELECT USING (true);",
        );
        assert_eq!(
            result
                .violations
                .iter()
                .map(|v| &v.kind)
                .collect::<Vec<_>>(),
            [&ViolationKind::RlsEnabledWithoutForce]
        );
    }

    #[test]
    fn tenant_read_policy_without_org_policy_is_refused() {
        let result = check(
            "CREATE TABLE tenant_terms_acceptances (org_id uuid not null);
             ALTER TABLE tenant_terms_acceptances ENABLE ROW LEVEL SECURITY;
             ALTER TABLE tenant_terms_acceptances FORCE ROW LEVEL SECURITY;
             CREATE POLICY readable ON tenant_terms_acceptances FOR SELECT USING (true);",
        );
        assert_eq!(
            result
                .violations
                .iter()
                .map(|v| &v.kind)
                .collect::<Vec<_>>(),
            [&ViolationKind::RlsEnabledWithoutOrgPolicy]
        );
    }

    #[test]
    fn global_name_with_org_column_requires_org_policy() {
        let result = check(
            "CREATE TABLE auth_rate_limit (version text primary key, org_id uuid not null);
             ALTER TABLE auth_rate_limit ENABLE ROW LEVEL SECURITY;
             ALTER TABLE auth_rate_limit FORCE ROW LEVEL SECURITY;
             CREATE POLICY readable ON auth_rate_limit FOR SELECT USING (true);",
        );
        assert_eq!(
            result
                .violations
                .iter()
                .map(|v| &v.kind)
                .collect::<Vec<_>>(),
            [&ViolationKind::RlsEnabledWithoutOrgPolicy]
        );
    }

    #[test]
    fn global_name_with_org_column_requires_not_null_and_rls() {
        let result = check("CREATE TABLE auth_rate_limit (version text primary key, org_id uuid);");
        assert_eq!(
            result
                .violations
                .iter()
                .map(|v| &v.kind)
                .collect::<Vec<_>>(),
            [
                &ViolationKind::NullableOrgIdWithoutAllowlist,
                &ViolationKind::OrgColumnWithoutRls
            ]
        );
    }
}
