//! One-time repair keeps old rows and audits each correction.
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_the_one_time_correction_repairs_same_entity_rows_and_lists_the_rest(
    owner: PgPool,
) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let user = *actor.user.as_uuid();
    let (entity, hq, plant, _, team) = chart(&store, &actor).await;
    // org-01 shape: bound at 본사 from the start, 부서 under 공장.
    let whole = person(&owner, &store, &actor, (entity, plant, team), "w").await;
    // move-02 shape: hired at 본사, an applied 전보 into 조립파트 on 05-01.
    let moved = person(&owner, &store, &actor, (entity, plant, team), "m").await;
    // move-01 shape: a 부서 of another 법인.
    let crossed = person(&owner, &store, &actor, (entity, plant, team), "x").await;
    let fine = person(&owner, &store, &actor, (entity, plant, team), "f").await;
    let (other, other_wp, site, far) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let unit = |id: Uuid, attrs: String| {
        format!(
            "INSERT INTO org_units (org_id, id) VALUES ('{ORG}', '{id}'); \
             INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
             VALUES ('{ORG}', '{id}', 1, gen_random_uuid(), '{user}', decode(repeat('ab', 32), 'hex'), '{attrs}', '{{}}');"
        )
    };
    let at_hq = |id: Uuid| {
        format!(
            "UPDATE employment_assignments SET superseded_at = now() WHERE employee_id = '{id}'; \
             INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, cause, actor_id, command_id) \
             VALUES ('{ORG}', '{id}', '{entity}', '{hq}', '2026-01-02', 'HIRE', '{user}', gen_random_uuid());"
        )
    };
    raw(
        &owner,
        [
            at_hq(whole),
            at_hq(moved),
            format!(
                "INSERT INTO employee_lifecycle_events (org_id, employee_id, event_type, to_status, effective_date, comment, created_by, state, to_org_unit_id) \
                 VALUES ('{ORG}', '{moved}', 'TRANSFER', 'ACTIVE', '2026-05-01', '전보', '{user}', 'APPLIED', '{team}');"
            ),
            format!(
                "INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) VALUES ('{ORG}', '{other}', true, 'MIGRATION'); \
                 INSERT INTO workplaces (org_id, id, legal_entity_id, needs_confirmation, created_change_mode) VALUES ('{ORG}', '{other_wp}', '{other}', true, 'MIGRATION');"
            ),
            unit(site, r#"{"kind": "site", "name": "판교오피스"}"#.into()),
            unit(far, format!(r#"{{"kind": "department", "name": "기획팀", "parent_id": "{site}"}}"#)),
            format!(
                "INSERT INTO org_unit_placements (org_id, org_unit_id, legal_entity_id, workplace_id, represents_workplace, valid_from, change_mode, command_id) \
                 VALUES ('{ORG}', '{site}', '{other}', '{other_wp}', true, '2026-01-01', 'MIGRATION', gen_random_uuid()); \
                 UPDATE employees SET org_unit_id = '{far}' WHERE id = '{crossed}';"
            ),
        ]
        .concat(),
    )
    .await;
    let detect = || async {
        let mut found: Vec<(Uuid, Uuid, Uuid, bool)> = sqlx::query_as(
            "SELECT employee_id, workplace_id, unit_workplace_id, unit_legal_entity_id <> legal_entity_id FROM placement_mismatches()",
        )
        .fetch_all(&owner)
        .await
        .unwrap();
        found.sort();
        found
    };
    let mut expected = vec![
        (whole, hq, plant, false),
        (moved, hq, plant, false),
        (crossed, plant, other_wp, true),
    ];
    expected.sort();
    assert_eq!(detect().await, expected);
    assert!(!expected.iter().any(|(e, ..)| *e == fine));

    let corrected: i32 = sqlx::query_scalar("SELECT placement_correct_mismatches()")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(corrected, 2);
    assert_eq!(
        live(&owner, whole).await,
        [("2026-01-02".into(), None, plant, "MIGRATION".into())]
    );
    assert_eq!(
        live(&owner, moved).await,
        [
            (
                "2026-01-02".into(),
                Some("2026-05-01".into()),
                hq,
                "HIRE".into()
            ),
            ("2026-05-01".into(), None, plant, "TRANSFER".into()),
        ]
    );
    // Only the 전적-shaped row is left, untouched, for a person to decide.
    assert_eq!(detect().await, vec![(crossed, plant, other_wp, true)]);
    // Zero loss: the replaced rows stay, superseded; each repair is audited.
    let kept = "SELECT count(*) FROM employment_assignments WHERE employee_id = $1 AND superseded_at IS NOT NULL AND workplace_id IS NOT NULL";
    assert_eq!(
        (
            scalar(&owner, kept, whole).await,
            scalar(&owner, kept, moved).await
        ),
        (2, 2)
    );
    let audited = "SELECT count(*) FROM audit_events WHERE target_id = $1::text AND action = 'employment_assignment.placement_corrected' AND actor IS NULL";
    assert_eq!(
        (
            scalar(&owner, audited, whole).await,
            scalar(&owner, audited, moved).await
        ),
        (1, 1)
    );
    let again: i32 = sqlx::query_scalar("SELECT placement_correct_mismatches()")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(again, 0, "idempotent");
}
