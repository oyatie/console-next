//! Who reaches a change set, and its open / discard lifecycle.

use console_hr_adapter_postgres::change_sets::OpenChangeSetRequest;
use sqlx::PgPool;
use uuid::Uuid;

use super::{fixture, key, line, promote, signed, wire};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn only_the_owner_reaches_a_set(pool: PgPool) {
    let f = fixture(pool).await;
    let set = f.open_with_lines(&[(f.a, "과장")]).await;
    let o = f.other.clone();
    assert_eq!(
        wire(f.hr.change_set(o.clone(), set).await.unwrap_err()).0,
        404
    );
    assert_eq!(
        wire(
            f.hr.put_change_set_line(o.clone(), set, line(f.b, "대리"))
                .await
                .unwrap_err()
        )
        .0,
        404
    );
    assert_eq!(
        wire(
            f.hr.commit_change_set(o.clone(), set, key(), signed())
                .await
                .unwrap_err()
        )
        .0,
        404
    );
    assert_eq!(
        wire(f.hr.discard_change_set(o.clone(), set).await.unwrap_err()).0,
        404
    );
    assert!(f.hr.change_sets(o.clone()).await.unwrap().is_empty());

    // 「+ 발령안」 by the other actor opens their own draft, never this one;
    // their line on A shows as another draft on that person.
    let theirs =
        f.hr.open_change_set(o.clone(), promote())
            .await
            .unwrap()
            .summary
            .id;
    assert_ne!(theirs, set);
    f.hr.put_change_set_line(o, theirs, line(f.a, "차장"))
        .await
        .unwrap();
    let mine = f.hr.change_set(f.me.clone(), set).await.unwrap();
    assert_eq!(mine.lines[0].other_open_drafts, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn one_open_draft_per_intent_and_discard_closes_it(pool: PgPool) {
    let f = fixture(pool).await;
    let (x, y) = tokio::join!(
        f.hr.open_change_set(f.me.clone(), promote()),
        f.hr.open_change_set(f.me.clone(), promote()),
    );
    let set = x.unwrap().summary.id;
    assert_eq!(y.unwrap().summary.id, set);

    let transfer = OpenChangeSetRequest {
        intent: "transfer".to_owned(),
    };
    let moves =
        f.hr.open_change_set(f.me.clone(), transfer)
            .await
            .unwrap()
            .summary
            .id;
    assert_ne!(moves, set);
    // A TRANSFER line names its unit; an unknown employee is 404.
    let refused =
        f.hr.put_change_set_line(f.me.clone(), moves, line(f.a, "과장"))
            .await;
    assert_eq!(wire(refused.unwrap_err()).0, 422);
    let ghost =
        f.hr.put_change_set_line(f.me.clone(), set, line(Uuid::new_v4(), "과장"))
            .await;
    assert_eq!(wire(ghost.unwrap_err()).0, 404);
    let bad = OpenChangeSetRequest {
        intent: "TERMINATE".to_owned(),
    };
    assert_eq!(
        wire(f.hr.open_change_set(f.me.clone(), bad).await.unwrap_err()).0,
        422
    );

    let drafted =
        f.hr.put_change_set_line(f.me.clone(), set, line(f.a, "과장"))
            .await
            .unwrap();
    f.hr.remove_change_set_line(f.me.clone(), set, drafted.id)
        .await
        .unwrap();
    assert!(
        f.hr.change_set(f.me.clone(), set)
            .await
            .unwrap()
            .lines
            .is_empty()
    );
    let empty =
        f.hr.commit_change_set(f.me.clone(), set, key(), signed())
            .await
            .unwrap_err();
    assert_eq!(wire(empty).0, 422);

    f.hr.discard_change_set(f.me.clone(), set).await.unwrap();
    f.hr.discard_change_set(f.me.clone(), set).await.unwrap();
    assert_eq!(f.state(set).await, "DISCARDED");
    // Draft writes are audited (ids only), the repeat discard is not.
    let audited: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM audit_events WHERE target_id = $1 ORDER BY occurred_at",
    )
    .bind(set.to_string())
    .fetch_all(&f.owner)
    .await
    .unwrap();
    assert_eq!(
        audited,
        [
            "employee.change_set.open",
            "employee.change_set.line_put",
            "employee.change_set.line_remove",
            "employee.change_set.discard"
        ]
    );
    let reopened =
        f.hr.open_change_set(f.me.clone(), promote())
            .await
            .unwrap()
            .summary
            .id;
    assert_ne!(reopened, set);
}
