#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! End-options erase unused departments, retire used ones, and refuse invalid operations without writes.

mod common;

use common::*;
use console_entity_application::OrgSetupOp;
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0C0D_0001);
const ORG2: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0C0D_0002);

async fn exists(owner: &PgPool, units: &[Uuid]) -> (i64, i64) {
    sqlx::query_as(
        "SELECT (SELECT count(*) FROM org_units WHERE id = ANY($1)), \
                (SELECT count(*) FROM org_unit_revisions WHERE org_unit_id = ANY($1))",
    )
    .bind(units)
    .fetch_one(owner)
    .await
    .unwrap()
}

async fn audits(owner: &PgPool, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action = $1")
        .bind(action)
        .fetch_one(owner)
        .await
        .unwrap()
}

async fn batch(
    store: &console_entity_adapter_postgres::PgEntityStore,
    actor: &console_entity_application::Actor,
    ops: Vec<OrgSetupOp>,
) -> Vec<Uuid> {
    store
        .apply_org_setup_batch(&cmd(actor), ops, port())
        .await
        .unwrap()
        .units
        .iter()
        .map(|u| u.org_unit_id)
        .collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_never_used_department_is_erased_with_its_sub_departments(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (_, [(hq, _), _]) = two_workplaces(&store, &actor).await;
    let ids = batch(
        &store,
        &actor,
        vec![
            under_workplace("a", "영업부", hq),
            under_ref("b", "영업1팀", "a"),
        ],
    )
    .await;
    let (dept, team) = (ids[0], ids[1]);

    let options = store
        .org_unit_end_options(&actor, dept, port())
        .await
        .unwrap();
    assert!(options.delete.allowed);
    assert_eq!(options.dissolve.refusal, Some("org_unit_never_used"));
    assert_eq!(
        (options.units, options.people_ever, options.members),
        (2, 0, 0)
    );

    // A stale pin is refused and changes nothing.
    let (c, _, remedy) = code(
        store
            .erase_org_unit(&cmd(&actor), dept, 9)
            .await
            .unwrap_err(),
    );
    assert_eq!((c, remedy), ("stale_revision", Some("reload_and_reapply")));
    assert_eq!(exists(&owner, &[dept, team]).await, (2, 2));
    assert_eq!(audits(&owner, "org_unit.erase").await, 0);

    // Erase: the anchors and their revisions are gone, one audit row each.
    let once = cmd(&actor);
    let erased = store.erase_org_unit(&once, dept, 1).await.unwrap();
    assert_eq!((erased.erased, erased.change_mode.as_str()), (2, "SETUP"));
    assert_eq!(exists(&owner, &[dept, team]).await, (0, 0));
    assert_eq!(audits(&owner, "org_unit.erase").await, 2);
    // The same Idempotency-Key replays the answer and writes nothing more.
    let again = store.erase_org_unit(&once, dept, 1).await.unwrap();
    assert_eq!(again.erased, 2);
    assert_eq!(audits(&owner, "org_unit.erase").await, 2);
    // The structure read no longer shows them.
    let tree = store.org_structure(&actor).await.unwrap();
    assert!(tree.entities[0].children[0].children.is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_used_department_is_dissolved_not_erased_and_the_refusals_change_nothing(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (entity, [(hq, _), _]) = two_workplaces(&store, &actor).await;
    let ids = batch(
        &store,
        &actor,
        vec![
            under_workplace("a", "생산부", hq),
            under_workplace("b", "임시부", hq),
            under_workplace("c", "총무부", hq),
        ],
    )
    .await;
    let (used, unused, other) = (ids[0], ids[1], ids[2]);
    let kim = person(&owner, &store, &actor, (entity, hq, used), "kim").await;
    set_operating(&owner, ORG).await;

    let options = store
        .org_unit_end_options(&actor, used, port())
        .await
        .unwrap();
    assert_eq!(options.phase, "OPERATING");
    assert_eq!(options.delete.refusal, Some("org_unit_has_people_history"));
    assert_eq!(options.dissolve.refusal, Some("org_unit_has_members"));

    // Erase of a used unit: 409 with its code, the unit untouched, no audit.
    let (c, _, remedy) = code(
        store
            .erase_org_unit(&cmd(&actor), used, 1)
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (c, remedy),
        ("org_unit_has_people_history", Some("dissolve_instead"))
    );
    let (c, _, remedy) = code(
        store
            .dissolve_org_unit(&cmd(&actor), used, 1, port())
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (c, remedy),
        ("org_unit_has_members", Some("move_people_first"))
    );
    assert_eq!(unit_head(&owner, used).await.1, "active");
    assert_eq!(audits(&owner, "org_unit.erase").await, 0);

    // Once nobody is placed there, 폐지 applies at once, GOVERNED, history kept.
    sqlx::query("UPDATE employees SET employment_status = 'EXITED' WHERE id = $1")
        .bind(kim)
        .execute(&owner)
        .await
        .unwrap();
    let options = store
        .org_unit_end_options(&actor, used, port())
        .await
        .unwrap();
    assert!(options.dissolve.allowed);
    assert_eq!(options.delete.refusal, Some("org_unit_has_people_history"));
    let done = store
        .dissolve_org_unit(&cmd(&actor), used, 1, port())
        .await
        .unwrap();
    assert_eq!(done.change_mode, "GOVERNED");
    assert_eq!(unit_head(&owner, used).await.1, "dissolved");
    assert_eq!(exists(&owner, &[used]).await, (1, 2));

    // A never-used unit after go-live is erased (not 폐지), recorded GOVERNED.
    let (c, _, _) = code(
        store
            .dissolve_org_unit(&cmd(&actor), unused, 1, port())
            .await
            .unwrap_err(),
    );
    assert_eq!(c, "org_unit_never_used");
    let erased = store.erase_org_unit(&cmd(&actor), unused, 1).await.unwrap();
    assert_eq!(erased.change_mode, "GOVERNED");
    assert_eq!(exists(&owner, &[unused]).await, (0, 0));

    // 부서장 and 부서 코드 after go-live, directly.
    let set = store
        .set_org_unit_details(&cmd(&actor), other, 1, Some("GA-01".into()), None, port())
        .await
        .unwrap();
    assert_eq!(set.change_mode, "GOVERNED");
    let code_now: Option<String> = sqlx::query_scalar(
        "SELECT attributes->>'code' FROM org_unit_revisions WHERE org_unit_id = $1 ORDER BY version DESC LIMIT 1",
    )
    .bind(other)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(code_now.as_deref(), Some("GA-01"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_routed_tenant_gets_no_direct_dissolve_or_details_after_go_live(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG2, "B").await;
    let (_, [(hq, _), _]) = two_workplaces(&store, &actor).await;
    let ids = batch(&store, &actor, vec![under_workplace("a", "기획부", hq)]).await;
    set_operating(&owner, ORG2).await;
    sqlx::query(
        "INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code) \
         VALUES ($1, 'approval.policy.org_structure', '\"route\"', $2, 'BW01')",
    )
    .bind(ORG2)
    .bind(*actor.user.as_uuid())
    .execute(&owner)
    .await
    .unwrap();
    let (c, _, remedy) = code(
        store
            .set_org_unit_details(&cmd(&actor), ids[0], 1, Some("P-1".into()), None, port())
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (c, remedy),
        ("org_change_routed", Some("submit_org_change"))
    );
    assert_eq!(unit_head(&owner, ids[0]).await.3, 1, "nothing written");
    // A never-used unit is still erased: there is no history for 결재 to keep.
    let options = store
        .org_unit_end_options(&actor, ids[0], port())
        .await
        .unwrap();
    assert!(options.delete.allowed);
    store.erase_org_unit(&cmd(&actor), ids[0], 1).await.unwrap();
}
