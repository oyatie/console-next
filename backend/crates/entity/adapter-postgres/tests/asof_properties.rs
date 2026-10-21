#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Deterministic randomized effective/recorded sequences exercise the real read adapter.
mod common;
use common::*;
use console_entity_application::ReadOptions;
use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

#[derive(Clone)]
struct Revision {
    version: i32,
    effective: Date,
    recorded: OffsetDateTime,
    name: String,
}
fn next(state: &mut u64) -> u64 {
    *state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
    *state
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn randomized_bitemporal_revisions_choose_max_effective_version_before_known_cutoff(
    owner: PgPool,
) {
    let today: Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(&owner)
        .await
        .unwrap();
    for seed in [1_u64, 17, 42, 0xdead_beef] {
        let mut original = corporation("Initial", "000211-0006241");
        original.incorporated_on = Some((today - Duration::days(100)).to_string());
        let (store, actor) = tenant(&owner, Uuid::new_v4(), &format!("asof-property-{seed}")).await;
        let entity = store
            .create_entity(&cmd(&actor), original)
            .await
            .unwrap()
            .record
            .id;
        let recorded: OffsetDateTime = sqlx::query_scalar(
            "SELECT created_at FROM legal_entity_revisions WHERE legal_entity_id=$1 AND version=1",
        )
        .bind(entity)
        .fetch_one(&owner)
        .await
        .unwrap();
        let mut revisions = vec![Revision {
            version: 1,
            effective: today - Duration::days(100),
            recorded,
            name: "Initial".into(),
        }];
        let mut cutoffs = vec![
            sqlx::query_scalar::<_, OffsetDateTime>("SELECT clock_timestamp()")
                .fetch_one(&owner)
                .await
                .unwrap(),
        ];
        let mut rng = seed;
        for version in 2..=25 {
            // Small date corpus deliberately repeats effective dates and backdates corrections.
            let offset = i64::try_from(next(&mut rng) % 9).unwrap() * 10 - 40;
            let effective = today + Duration::days(offset);
            let name = format!("Revision {seed}-{version}");
            let recorded = sqlx::query_scalar(
                "INSERT INTO legal_entity_revisions (org_id,legal_entity_id,version,command_id, \
                 effective_from,name,change_mode,reason_code,payload_digest,settings_snapshot,created_at) \
                 VALUES ($1,$2,$3,$4,$5,$6,'MIGRATION','property',sha256('property'::bytea),'{}',clock_timestamp()) \
                 RETURNING created_at",
            ).bind(*actor.org.as_uuid()).bind(entity).bind(version).bind(Uuid::new_v4())
                .bind(effective).bind(&name).fetch_one(&owner).await.unwrap();
            revisions.push(Revision {
                version,
                effective,
                recorded,
                name,
            });
            cutoffs.push(
                sqlx::query_scalar::<_, OffsetDateTime>("SELECT clock_timestamp()")
                    .fetch_one(&owner)
                    .await
                    .unwrap(),
            );
        }
        for cutoff in [0, 4, 8, 12, 16, 20, 24] {
            let known = cutoffs[cutoff];
            for offset in [-45, -30, -15, 0, 15, 30, 45] {
                let as_of = today + Duration::days(offset);
                let expected = revisions
                    .iter()
                    .filter(|r| r.recorded <= known && r.effective <= as_of)
                    .max_by_key(|r| (r.effective, r.version))
                    .unwrap();
                let read = store
                    .get_entity_at(
                        &actor,
                        entity,
                        false,
                        ReadOptions {
                            as_of: Some(as_of),
                            known_at: Some(known),
                        },
                    )
                    .await
                    .unwrap();
                let actual = read.current.unwrap();
                assert_eq!(
                    (actual.version, actual.name.as_str()),
                    (expected.version, expected.name.as_str()),
                    "seed={seed}, cutoff={cutoff}, date={as_of}"
                );
                let mut expected_scheduled: Vec<_> = revisions
                    .iter()
                    .filter(|r| r.recorded <= known && r.effective > as_of)
                    .map(|r| (r.effective, r.version))
                    .collect();
                expected_scheduled.sort_unstable();
                assert_eq!(
                    read.scheduled
                        .iter()
                        .map(|r| (r.effective_from, r.version))
                        .collect::<Vec<_>>(),
                    expected_scheduled,
                    "scheduled seed={seed}, cutoff={cutoff}, date={as_of}"
                );
            }
        }
    }
}
