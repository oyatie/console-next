// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) const REVIEW_DAYS: i32 = 3;

pub(super) struct World {
    pub(super) org: OrgId,
    pub(super) actor: UserId,
    pub(super) id: Uuid,
    pub(super) steps: Vec<Uuid>,
    pub(super) store: PgOrgChangeStore,
    pub(super) key: SoftKey,
}

pub(super) async fn world(pool: &PgPool) -> World {
    world_with_route(pool, true).await
}

pub(super) async fn world_with_route(pool: &PgPool, routed: bool) -> World {
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(pool, *org.as_uuid(), "sole-decision").await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(actor.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    person_fixtures::bind_user_to_distinct_person(pool, actor).await;
    if routed {
        sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,'approval.policy.org_structure','\"route\"',$2,'TEST')").bind(org.as_uuid()).bind(actor.as_uuid()).execute(pool).await.unwrap();
    }
    sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,'review.sole_holder_exception.due',$3,$2,'TEST')").bind(org.as_uuid()).bind(actor.as_uuid()).bind(json!(REVIEW_DAYS)).execute(pool).await.unwrap();
    let id = sqlx::query_scalar("INSERT INTO org_change_requests(org_id,code,kind,status,target_kind,target_ref,target_label,effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) VALUES($1,'OC-2026-0001','REORG','IN_APPROVAL','REGION','region','Region',CURRENT_DATE,'Review','[]',$2,$3,repeat('a',64)) RETURNING id")
        .bind(org.as_uuid()).bind(actor.as_uuid()).bind(Uuid::new_v4().to_string()).fetch_one(pool).await.unwrap();
    let mut steps = Vec::new();
    for order in 1_i16..=4 {
        steps.push(sqlx::query_scalar("INSERT INTO org_change_approval_steps(org_id,request_id,step_order,role_key) VALUES($1,$2,$3,'hr') RETURNING id").bind(org.as_uuid()).bind(id).bind(order).fetch_one(pool).await.unwrap());
    }
    let key = SoftKey::enroll(pool, org, actor).await;
    let store = PgOrgChangeStore::new(runtime_role_pool(pool).await).with_sole_holder_decision(
        Arc::new(implementation::PgSoleHolderDecisionPort(passkey_service())),
    );
    World {
        org,
        actor,
        id,
        steps,
        store,
        key,
    }
}

pub(super) async fn command(pool: &PgPool, w: &mut World) -> StepDecisionCommand {
    let consent = scope_org(w.org, w.store.sole_holder_consent(w.actor, w.id))
        .await
        .unwrap()
        .unwrap();
    command_for_consent(pool, w, consent).await
}

pub(super) async fn command_for_consent(
    pool: &PgPool,
    w: &mut World,
    consent: Value,
) -> StepDecisionCommand {
    let binding = MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::ExceptionDecide,
        w.id,
        consent["payload_hash"].as_str().unwrap().into(),
    );
    let start = passkey_service()
        .start_mobile_step_up(pool, *w.actor.as_uuid(), binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{"type":"public-key","id":w.key.credential_id()}]);
    let credential = w.key.assert(&challenge).unwrap();
    StepDecisionCommand {
        approved: true,
        expected_version: Some(consent["expected_version"].as_str().unwrap().into()),
        step_up: Some(
            json!({"binding":binding,"assertion":{"ceremony_id":start.ceremony_id,"credential":credential}}),
        ),
        ..Default::default()
    }
}

pub(super) async fn snapshot(pool: &PgPool, w: &World) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(s) ORDER BY step_order) FROM org_change_approval_steps s WHERE request_id=$1),(SELECT count(*) FROM governed_exceptions),(SELECT count(*) FROM notifications),(SELECT count(*) FROM step_up_assertions),(SELECT count(*) FROM audit_events),(SELECT status FROM org_change_requests WHERE id=$1))")
        .bind(w.id).fetch_one(pool).await.unwrap()
}
