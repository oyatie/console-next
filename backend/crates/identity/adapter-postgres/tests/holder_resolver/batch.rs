// SPDX-License-Identifier: LicenseRef-Proprietary
//! Set-based resolution parity and the 2,000-person performance proof.
use super::*;

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn grant_integrity_at_two_thousand_people_reports_elapsed_time(pool: PgPool) {
    let runtime = runtime_role_pool(&pool).await;
    let by = holder(&pool, None, &[], false, 400, true).await;
    let account = holder(&pool, None, &[], true, 400, true).await;
    let template = grant(
        &pool,
        org(),
        by,
        account,
        Grant {
            domain: "org",
            level: "approve",
            ..CLOSE
        },
    )
    .await;
    sqlx::query("INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key)
        SELECT $1, 'Synthetic', '부하 검증', 'fixture', 'fixture', n, gen_random_uuid()::text FROM generate_series(1,1999) n")
        .bind(org()).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO users (id,org_id,display_name,roles,employee_id)
        SELECT gen_random_uuid(), e.org_id, e.name, '{}', e.id FROM employees e WHERE e.org_id=$1
          AND NOT EXISTS(SELECT 1 FROM users u WHERE u.org_id=e.org_id AND u.employee_id=e.id)",
    )
    .bind(org())
    .execute(&pool)
    .await
    .unwrap();
    let people: i64 = sqlx::query_scalar("SELECT count(*) FROM employees WHERE org_id=$1")
        .bind(org())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(people, 2000);
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,change_mode,reason_code,granted_by)
        SELECT u.org_id,u.id,g.role_id,'TENANT',g.valid_from,'OPERATING','NEW_HIRE',$2
        FROM users u CROSS JOIN access_grants g WHERE g.id=$3 AND u.org_id=$1 AND u.employee_id IS NOT NULL AND u.id<>$4")
        .bind(org()).bind(by).bind(template).bind(account).execute(&pool).await.unwrap();
    go_live(&pool, org(), by).await;
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let budget_ms = std::env::var("CONSOLE_TEST_GRANT_INTEGRITY_BUDGET_MS")
        .ok()
        .map(|raw| raw.parse::<u64>().expect("budget must be milliseconds"));
    let mut elapsed = std::time::Duration::MAX;
    let mut result = Default::default();
    for _ in 0..if budget_ms.is_some() { 3 } else { 1 } {
        let started = std::time::Instant::now();
        result = PgHolderResolver {
            tx: &mut tx,
            org: OrgId::one(),
            capability: HolderCapability::OrgChangeDecide,
            exclude_account: None,
            exclude_employee: None,
            include_ops: false,
            now: OffsetDateTime::now_utc(),
        }
        .resolve()
        .await
        .unwrap();
        elapsed = elapsed.min(started.elapsed());
    }
    assert_eq!(result.len(), 2000);
    assert!(result.contains(&account));
    eprintln!(
        "F8 current-holder resolver, 2000 employees: {} us",
        elapsed.as_micros()
    );
    if let Some(ms) = budget_ms {
        assert!(
            elapsed <= std::time::Duration::from_millis(ms),
            "2,000-holder resolver exceeded the {ms} ms performance-tier budget: {elapsed:?}"
        );
    }
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn set_based_holders_match_live_cedar_and_respect_all_exclusions(pool: PgPool) {
    use console_platform_authz::access::{
        AccessSlice, Domain, Level, NodePath, action_group, load_access_subject, project,
    };
    use console_platform_authz::{Feature, PermissionLevel};
    let by = holder(&pool, None, &[], false, 400, true).await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(by)
        .execute(&pool)
        .await
        .unwrap();
    let a = holder(&pool, None, &[], true, 400, true).await;
    let b = holder(&pool, None, &[], true, 400, true).await;
    let spec = Grant {
        domain: "org",
        level: "approve",
        ..CLOSE
    };
    grant(&pool, org(), by, a, spec).await;
    let pending = grant(&pool, org(), by, b, spec).await;
    sqlx::query("UPDATE access_grants SET status='PENDING' WHERE id=$1")
        .bind(pending)
        .execute(&pool)
        .await
        .unwrap();
    let employee: uuid::Uuid = sqlx::query_scalar("SELECT employee_id FROM users WHERE id=$1")
        .bind(a)
        .fetch_one(&pool)
        .await
        .unwrap();
    let runtime = runtime_role_pool(&pool).await;
    for setup in [true, false] {
        if !setup {
            go_live(&pool, org(), by).await;
        }
        let mut tx = runtime.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org().to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let now = OffsetDateTime::now_utc();
        for capability in [
            HolderCapability::OrgChangeDecide,
            HolderCapability::AccessAdmin,
            HolderCapability::Feature {
                feature: Feature::OrgChangeApprove,
                branch: None,
            },
        ] {
            let mut expected = std::collections::BTreeSet::new();
            for id in [a, b, by] {
                let subject = load_access_subject(&mut tx, OrgId::one(), id, now)
                    .await
                    .unwrap();
                let holds = match capability {
                    HolderCapability::Feature { feature, .. } => {
                        subject.is_ops
                            || project(&subject).grants.iter().any(|g| {
                                g.feature == feature
                                    && g.permission == PermissionLevel::Allow
                                    && g.branch_scope == console_kernel_core::BranchScope::All
                            })
                    }
                    _ => AccessSlice::compile(&subject)
                        .unwrap()
                        .allows(
                            &action_group(
                                if matches!(capability, HolderCapability::AccessAdmin) {
                                    Domain::Access
                                } else {
                                    Domain::Org
                                },
                                if matches!(capability, HolderCapability::AccessAdmin) {
                                    Level::Edit
                                } else {
                                    Level::Approve
                                },
                            ),
                            &NodePath::tenant(OrgId::one()),
                        )
                        .unwrap(),
                };
                if holds {
                    expected.insert(id);
                }
            }
            for (exclude_account, exclude_employee, include_ops) in [
                (None, None, true),
                (Some(a), None, true),
                (None, Some(employee), true),
                (None, None, false),
            ] {
                let actual = PgHolderResolver {
                    tx: &mut tx,
                    org: OrgId::one(),
                    capability,
                    exclude_account,
                    exclude_employee,
                    include_ops,
                    now,
                }
                .resolve()
                .await
                .unwrap();
                let expected = expected
                    .iter()
                    .copied()
                    .filter(|id| {
                        Some(*id) != exclude_account
                            && !(exclude_employee == Some(employee) && *id == a)
                            && (include_ops || *id != by)
                    })
                    .collect();
                assert_eq!(actual, expected, "setup={setup}");
            }
            let limited = PgHolderResolver {
                tx: &mut tx,
                org: OrgId::one(),
                capability,
                exclude_account: None,
                exclude_employee: None,
                include_ops: true,
                now,
            }
            .resolve_at_most(2)
            .await
            .unwrap();
            assert_eq!(limited.len(), expected.len().min(2));
            assert!(limited.is_subset(&expected));
        }
    }
}
