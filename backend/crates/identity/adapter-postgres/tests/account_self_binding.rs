// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod second_person_support;

use console_identity_adapter_postgres::{PgOrgError, PgOrgStore, self_binding::SelfBindingCommand};
use console_kernel_core::{OrgId, TraceContext, UserId};
use console_platform_auth::{MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope};
use console_platform_request_context::scope_org;
use console_platform_test_support::{
    runtime_role_pool,
    soft_passkey::{SoftKey, passkey_service},
};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

async fn fixture(pool: &PgPool) -> (PgOrgStore, UserId, Uuid, SoftKey) {
    let actor = second_person_support::holder(pool, None, &[], false, 0, false).await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(actor)
        .execute(pool)
        .await
        .unwrap();
    let actor = UserId::from_uuid(actor);
    let employee = employee(pool).await;
    let runtime = runtime_role_pool(pool).await;
    let key = SoftKey::enroll(&runtime, OrgId::one(), actor).await;
    (PgOrgStore::new(runtime), actor, employee, key)
}

async fn employee(pool: &PgPool) -> Uuid {
    sqlx::query_scalar("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key) \
        VALUES($1,'Synthetic','Operator','fixture','fixture',1,gen_random_uuid()::text) RETURNING id")
        .bind(OrgId::one().as_uuid()).fetch_one(pool).await.unwrap()
}

async fn envelope(
    pool: &PgPool,
    actor: UserId,
    employee: Uuid,
    key: &mut SoftKey,
) -> serde_json::Value {
    let payload = json!({"command":"account_link.self_bind","org_id":OrgId::one(),"account_id":actor,"employee_id":employee});
    let hash: String =
        sqlx::query_scalar("SELECT governed_exception_fingerprint($1,'{}'::daterange[])")
            .bind(payload)
            .fetch_one(pool)
            .await
            .unwrap();
    let binding = MobilePasskeyStepUpBinding::bound(
        console_platform_auth::MobileStepUpActionKind::ExceptionDecide,
        *actor.as_uuid(),
        hash,
    );
    let start = passkey_service()
        .start_mobile_step_up(pool, *actor.as_uuid(), binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{"type":"public-key","id":key.credential_id()}]);
    json!({"binding":binding,"assertion":{"ceremony_id":start.ceremony_id,"credential":key.assert(&challenge).unwrap()}})
}

async fn bind(
    store: &PgOrgStore,
    actor: UserId,
    employee: Uuid,
    proof: serde_json::Value,
) -> Result<Uuid, PgOrgError> {
    scope_org(
        OrgId::one(),
        store.self_bind_account(
            SelfBindingCommand {
                actor,
                employee,
                step_up: serde_json::from_value::<MobilePasskeyStepUpEnvelope>(proof).unwrap(),
                trace: TraceContext::generate(),
            },
            &passkey_service(),
        ),
    )
    .await
}

fn code(error: PgOrgError) -> &'static str {
    match error {
        PgOrgError::Domain(error) => error.code.unwrap(),
        other => panic!("{other:?}"),
    }
}

async fn counts(pool: &PgPool, actor: UserId) -> (Option<Uuid>, i64, i64) {
    sqlx::query_as("SELECT employee_id, \
        (SELECT count(*) FROM account_link_self_attestations WHERE account_id=users.id), \
        (SELECT count(*) FROM audit_events WHERE action='account_link.self_attested' AND actor=users.id) \
        FROM users WHERE id=$1")
        .bind(actor.as_uuid()).fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn solo_binding_commits_identity_attestation_and_audit_once(pool: PgPool) {
    let (store, actor, employee, mut key) = fixture(&pool).await;
    sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,'review.sole_holder_exception.due','15',$2,'POLICY_REVIEW')")
        .bind(OrgId::one().as_uuid()).bind(actor.as_uuid()).execute(&pool).await.unwrap();
    let proof = envelope(store.pool(), actor, employee, &mut key).await;
    let receipt = bind(&store, actor, employee, proof.clone()).await.unwrap();
    assert_eq!(counts(&pool, actor).await, (Some(employee), 1, 1));
    let mut foreign_read = store.pool().begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(OrgId::new().to_string())
        .execute(foreign_read.as_mut())
        .await
        .unwrap();
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM account_link_self_attestations")
        .fetch_one(foreign_read.as_mut())
        .await
        .unwrap();
    assert_eq!(visible, 0, "self-attestation receipts are tenant isolated");
    foreign_read.rollback().await.unwrap();
    let (facts, due, days): (serde_json::Value, bool, i64) = sqlx::query_as(
        "SELECT eligibility,review_due_at=attested_at+make_interval(days=>review_days),review_days::bigint \
         FROM account_link_self_attestations WHERE id=$1")
        .bind(receipt).fetch_one(&pool).await.unwrap();
    assert_eq!(
        facts,
        json!({"subject_is_self":true,"operator":true,"unbound":true,"holds_permission":true,"other_holder":false})
    );
    assert!(due);
    assert_eq!(days, 15);
    assert_eq!(
        code(bind(&store, actor, employee, proof).await.unwrap_err()),
        "step_up_failed"
    );
    assert_eq!(counts(&pool, actor).await, (Some(employee), 1, 1));
    let assertions: i64 =
        sqlx::query_scalar("SELECT count(*) FROM step_up_assertions WHERE ceremony_id=$1")
            .bind(receipt)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(assertions, 1);
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn concurrent_commands_bind_only_one_employee(pool: PgPool) {
    let (store, actor, target, mut key) = fixture(&pool).await;
    let other = employee(&pool).await;
    let first = envelope(store.pool(), actor, target, &mut key).await;
    let mut second_key = SoftKey::enroll(store.pool(), OrgId::one(), actor).await;
    let second = envelope(store.pool(), actor, other, &mut second_key).await;
    let (first, second) = tokio::join!(
        bind(&store, actor, target, first),
        bind(&store, actor, other, second)
    );
    let winner = if first.is_ok() {
        assert_eq!(
            code(second.unwrap_err()),
            "account_link.refuse.solo_ineligible"
        );
        target
    } else {
        second.unwrap();
        assert_eq!(
            code(first.unwrap_err()),
            "account_link.refuse.solo_ineligible"
        );
        other
    };
    assert_eq!(counts(&pool, actor).await, (Some(winner), 1, 1));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn audit_failure_rolls_back_binding_receipt_and_assertion(pool: PgPool) {
    let (store, actor, employee, mut key) = fixture(&pool).await;
    sqlx::raw_sql("CREATE FUNCTION refuse_self_attestation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
        IF NEW.action='account_link.self_attested' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; \
        CREATE TRIGGER refuse_self_attestation_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION refuse_self_attestation_audit();")
        .execute(&pool).await.unwrap();
    let proof = envelope(store.pool(), actor, employee, &mut key).await;
    assert!(bind(&store, actor, employee, proof.clone()).await.is_err());
    assert_eq!(counts(&pool, actor).await, (None, 0, 0));
    let assertions: i64 =
        sqlx::query_scalar("SELECT count(*) FROM step_up_assertions WHERE user_id=$1")
            .bind(actor.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(assertions, 0);
    sqlx::query("DROP TRIGGER refuse_self_attestation_audit ON audit_events")
        .execute(&pool)
        .await
        .unwrap();
    bind(&store, actor, employee, proof).await.unwrap();
    assert_eq!(counts(&pool, actor).await, (Some(employee), 1, 1));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn second_eligible_account_created_after_ceremony_refuses_solo_binding(pool: PgPool) {
    use second_person_support::access::{CLOSE, Grant, go_live, grant};
    let (store, actor, employee, mut key) = fixture(&pool).await;
    let proof = envelope(store.pool(), actor, employee, &mut key).await;
    let second = second_person_support::holder(&pool, None, &[], false, 0, false).await;
    grant(
        &pool,
        second_person_support::org(),
        *actor.as_uuid(),
        second,
        Grant {
            domain: "access",
            level: "edit",
            age_days: 0,
            notified: false,
            ..CLOSE
        },
    )
    .await;
    go_live(&pool, second_person_support::org(), *actor.as_uuid()).await;
    assert_eq!(
        code(bind(&store, actor, employee, proof).await.unwrap_err()),
        "account_link.refuse.solo_ineligible"
    );
    assert_eq!(counts(&pool, actor).await, (None, 0, 0));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn proof_for_another_employee_cannot_authorize_this_command(pool: PgPool) {
    let (store, actor, target, mut key) = fixture(&pool).await;
    let other = employee(&pool).await;
    let proof = envelope(store.pool(), actor, target, &mut key).await;
    assert_eq!(
        code(bind(&store, actor, other, proof).await.unwrap_err()),
        "step_up_failed"
    );
    assert_eq!(counts(&pool, actor).await, (None, 0, 0));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn a_login_assertion_cannot_authorize_self_binding(pool: PgPool) {
    let (store, actor, employee, mut key) = fixture(&pool).await;
    let mut proof = envelope(store.pool(), actor, employee, &mut key).await;
    proof["assertion"] = key.step_up(store.pool()).await;
    assert_eq!(
        code(bind(&store, actor, employee, proof).await.unwrap_err()),
        "step_up_failed"
    );
    assert_eq!(counts(&pool, actor).await, (None, 0, 0));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn an_employee_already_linked_to_another_account_is_refused(pool: PgPool) {
    let (store, actor, employee, mut key) = fixture(&pool).await;
    let other = second_person_support::holder(&pool, None, &[], false, 0, false).await;
    sqlx::query("UPDATE users SET employee_id=$2 WHERE id=$1")
        .bind(other)
        .bind(employee)
        .execute(&pool)
        .await
        .unwrap();
    let proof = envelope(store.pool(), actor, employee, &mut key).await;
    assert_eq!(
        code(bind(&store, actor, employee, proof).await.unwrap_err()),
        "account_link.refuse.employee_taken"
    );
    assert_eq!(counts(&pool, actor).await, (None, 0, 0));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn missing_employee_is_refused_without_writing_receipts(pool: PgPool) {
    let (store, actor, _, mut key) = fixture(&pool).await;
    let employee = Uuid::new_v4();
    let proof = envelope(store.pool(), actor, employee, &mut key).await;
    assert_eq!(
        bind(&store, actor, employee, proof)
            .await
            .unwrap_err()
            .kind(),
        console_kernel_core::ErrorKind::NotFound
    );
    assert_eq!(counts(&pool, actor).await, (None, 0, 0));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn employee_from_another_tenant_is_not_visible(pool: PgPool) {
    let (store, actor, _, mut key) = fixture(&pool).await;
    let foreign =
        console_platform_test_support::seed_org_and_super_admin(&pool, Uuid::new_v4(), "Foreign")
            .await;
    let employee: Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key) \
        SELECT org_id,'Synthetic','Foreign','fixture','fixture',1,gen_random_uuid()::text FROM users WHERE id=$1 RETURNING id")
        .bind(foreign.as_uuid()).fetch_one(&pool).await.unwrap();
    let proof = envelope(store.pool(), actor, employee, &mut key).await;
    assert_eq!(
        bind(&store, actor, employee, proof)
            .await
            .unwrap_err()
            .kind(),
        console_kernel_core::ErrorKind::NotFound
    );
    assert_eq!(counts(&pool, actor).await, (None, 0, 0));
}
