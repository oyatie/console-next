// SPDX-License-Identifier: LicenseRef-Proprietary
//! Human histories are retained by guarded removal; governed erasure still proves retirement and rollback.
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn guarded_human_retention_and_governed_erase_preserve_account_identity(owner: PgPool) {
    for force in [false, true] {
        let (org, user, actor) = company(&owner, force).await;
        let pool = login(&owner, force, "identity-company-remove").await;
        if !force {
            let before: Value = sqlx::query_scalar("SELECT to_jsonb(u) FROM users u WHERE id=$1")
                .bind(user)
                .fetch_one(&owner)
                .await
                .unwrap();
            assert_eq!(
                remove(&pool, false, org, actor).await.unwrap(),
                TenantRemovalOutcome::BlockedHasData
            );
            assert_eq!(retired(&owner, user).await, Some(false));
            let after: Value = sqlx::query_scalar("SELECT to_jsonb(u) FROM users u WHERE id=$1")
                .bind(user)
                .fetch_one(&owner)
                .await
                .unwrap();
            assert_eq!(after, before);
            continue;
        }
        assert_eq!(
            remove(&pool, force, org, actor).await.unwrap(),
            TenantRemovalOutcome::Removed
        );
        assert_eq!(retired(&owner, user).await, Some(true));
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1) OR EXISTS(SELECT 1 FROM organizations WHERE id=$2)").bind(user).bind(org).fetch_one(&owner).await.unwrap();
        assert!(!exists);
        assert_eq!(
            code(
                &insert(&owner, *OrgId::one().as_uuid(), user)
                    .await
                    .unwrap_err()
            ),
            "23505"
        );
        assert_eq!(retired(&owner, actor).await, Some(false));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn governed_erase_retires_accounts_before_child_sweep_and_rolls_back_on_failure(
    owner: PgPool,
) {
    sqlx::raw_sql("CREATE TABLE public.test_retirement_force_first(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT); CREATE FUNCTION public.test_retirement_sweep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM public.users u LEFT JOIN auth_security.account_id_reservations r ON r.account_id=u.id WHERE u.org_id=OLD.org_id AND r.retired IS DISTINCT FROM true) THEN RAISE EXCEPTION 'retirement_missing_before_sweep' USING ERRCODE='23514'; END IF; RAISE EXCEPTION 'observed_retired_before_sweep' USING ERRCODE='P0001'; END $$; CREATE TRIGGER test_retirement_sweep BEFORE DELETE ON auth_refresh_tokens FOR EACH ROW EXECUTE FUNCTION public.test_retirement_sweep(); CREATE TRIGGER test_retirement_force_sweep BEFORE DELETE ON public.test_retirement_force_first FOR EACH ROW EXECUTE FUNCTION public.test_retirement_sweep();").execute(&owner).await.unwrap();
    let force = true;
    let (org, user, actor) = company(&owner, force).await;
    let second = Uuid::new_v4();
    insert(&owner, org, second).await.unwrap();
    RefreshTokenStore
        .issue_family(
            &owner,
            user,
            OrgId::from_uuid(org),
            OffsetDateTime::now_utc(),
            Duration::minutes(5),
        )
        .await
        .unwrap();
    sqlx::query("INSERT INTO public.test_retirement_force_first(org_id) VALUES($1)")
        .bind(org)
        .execute(&owner)
        .await
        .unwrap();
    let pool = login(&owner, force, "identity-sweep-failure").await;
    let error = remove(&pool, force, org, actor)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("observed_retired_before_sweep"), "{error}");
    assert_eq!(retired(&owner, user).await, Some(false));
    assert_eq!(retired(&owner, second).await, Some(false));
    let counts: (i64, i64, i64, i64, i64) = sqlx::query_as("SELECT (SELECT count(*) FROM users WHERE org_id=$1),(SELECT count(*) FROM auth_refresh_tokens WHERE org_id=$1),(SELECT count(*) FROM auth_refresh_token_families WHERE org_id=$1),(SELECT count(*) FROM organizations WHERE id=$1),(SELECT count(*) FROM test_retirement_force_first WHERE org_id=$1)").bind(org).fetch_one(&owner).await.unwrap();
    assert_eq!(counts, (2, 1, 1, 1, 1));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn restrictive_fk_and_audit_failure_rollback_retirement(owner: PgPool) {
    let org = *OrgId::one().as_uuid();
    let id = Uuid::new_v4();
    insert(&owner, org, id).await.unwrap();
    sqlx::query("INSERT INTO auth_webauthn_credentials(user_id,credential_id,passkey_json,org_id) VALUES($1,$2,'{}',$3)").bind(id).bind(id.to_string()).bind(org).execute(&owner).await.unwrap();
    sqlx::raw_sql("CREATE TABLE test_account_retirement_fk(user_id UUID REFERENCES users(id) ON DELETE RESTRICT)").execute(&owner).await.unwrap();
    sqlx::query("INSERT INTO test_account_retirement_fk VALUES($1)")
        .bind(id)
        .execute(&owner)
        .await
        .unwrap();
    // An independent restrictive edge must roll back the trigger and cascades.
    assert_eq!(
        code(
            &sqlx::query("DELETE FROM users WHERE id=$1")
                .bind(id)
                .execute(&owner)
                .await
                .unwrap_err()
        ),
        "23001"
    );
    assert_eq!(retired(&owner, id).await, Some(false));
    sqlx::raw_sql("CREATE FUNCTION public.test_retirement_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('platform.tenant.remove','platform.tenant.force_remove') THEN RAISE EXCEPTION 'retirement_audit_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_retirement_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION public.test_retirement_audit_failure();").execute(&owner).await.unwrap();
    for force in [false, true] {
        let (company, user, actor) = company(&owner, force).await;
        let pool = login(&owner, force, "identity-audit-failure").await;
        let result = remove(&pool, force, company, actor).await;
        if force {
            let error = result.unwrap_err().to_string();
            assert!(error.contains("retirement_audit_failure"), "{error}");
        } else {
            assert_eq!(result.unwrap(), TenantRemovalOutcome::BlockedHasData);
        }
        assert_eq!(retired(&owner, user).await, Some(false));
        let present: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1) AND EXISTS(SELECT 1 FROM organizations WHERE id=$2)").bind(user).bind(company).fetch_one(&owner).await.unwrap();
        assert!(present);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_reservation_fails_closed_for_direct_and_company_deletion(owner: PgPool) {
    for mode in 0..3 {
        let force = mode == 2;
        let (org, user, actor) = company(&owner, force).await;
        let second = Uuid::new_v4();
        insert(&owner, org, second).await.unwrap();
        // Only the fixture owner can simulate loss of protected identity state.
        sqlx::query("DELETE FROM auth_security.account_id_reservations WHERE account_id=$1")
            .bind(user)
            .execute(&owner)
            .await
            .unwrap();
        let pool = login(&owner, force, "identity-missing-reservation").await;
        if mode == 0 {
            let mut tx = pool.begin().await.unwrap();
            sqlx::query("SELECT set_config('app.current_org',$1,true)")
                .bind(org.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
            let error = sqlx::query("DELETE FROM users WHERE id=$1")
                .bind(user)
                .execute(&mut *tx)
                .await
                .unwrap_err();
            assert_eq!(code(&error), "23514");
            tx.rollback().await.unwrap();
        } else if !force {
            assert_eq!(
                remove(&pool, false, org, actor).await.unwrap(),
                TenantRemovalOutcome::BlockedHasData
            );
        } else {
            let error = remove(&pool, force, org, actor)
                .await
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("account identity reservation missing"),
                "{error}"
            );
        }
        assert_eq!(retired(&owner, user).await, None);
        assert_eq!(retired(&owner, second).await, Some(false));
        let counts: (i64, i64) = sqlx::query_as("SELECT (SELECT count(*) FROM users WHERE org_id=$1),(SELECT count(*) FROM organizations WHERE id=$1)").bind(org).fetch_one(&owner).await.unwrap();
        assert_eq!(counts, (2, 1));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn human_retention_and_governed_cascades_preserve_credential_history(owner: PgPool) {
    for mode in 0..3 {
        let (org, user, actor) = company(&owner, mode == 2).await;
        let key = Uuid::new_v4();
        removal_key(&owner, org, user, key).await;
        let rt = login(&owner, mode == 2, "removal-cascade").await;
        if mode == 0 {
            let mut tx = rt.begin().await.unwrap();
            sqlx::query("SELECT set_config('app.current_org',$1,true)")
                .bind(org.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
            sqlx::query("DELETE FROM users WHERE id=$1")
                .bind(user)
                .execute(&mut *tx)
                .await
                .unwrap();
            tx.commit().await.unwrap();
        } else if mode == 1 {
            assert_eq!(
                remove(&rt, false, org, actor).await.unwrap(),
                TenantRemovalOutcome::BlockedHasData
            );
            assert_eq!(retired(&owner, user).await, Some(false));
            assert!(removal_events(&owner, key).await.is_empty());
            let preserved:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1) AND EXISTS(SELECT 1 FROM auth_webauthn_credentials WHERE id=$2) AND EXISTS(SELECT 1 FROM organizations WHERE id=$3)").bind(user).bind(key).bind(org).fetch_one(&owner).await.unwrap();
            assert!(preserved);
            continue;
        } else {
            assert_eq!(
                remove(&rt, mode == 2, org, actor).await.unwrap(),
                TenantRemovalOutcome::Removed
            );
        }
        let events = removal_events(&owner, key).await;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["account_id"], user.to_string());
        assert_eq!(events[0]["company_id"], org.to_string());
        let retained: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)")
            .bind(user)
            .fetch_one(&owner)
            .await
            .unwrap();
        assert!(!retained);
        if mode != 0 {
            let retained: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organizations WHERE id=$1)")
                    .bind(org)
                    .fetch_one(&owner)
                    .await
                    .unwrap();
            assert!(!retained);
        }
    }
}
