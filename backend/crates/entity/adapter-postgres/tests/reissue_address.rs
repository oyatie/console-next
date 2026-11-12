// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Linked certificate addresses follow dated revisions; independently entered addresses stay independent.

mod common;
mod reissue_support;

use common::*;
use console_entity_application::ReadOptions;
use reissue_support::*;
use sqlx::PgPool;
use time::macros::date;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn only_linked_workplace_addresses_follow_the_certificate(owner: PgPool) {
    for (org, linked) in [(ORG, true), (ORG_B, false)] {
        let (store, actor) = tenant(&owner, org, "address").await;
        let (entity, reg, _) = setup(&store, &actor).await;
        let mut input = workplace_from(reg, "본사");
        input.input.same_address_as_registration = linked;
        // Identical text is not a link: an independently entered address has its own identity.
        if !linked {
            input.input.address = certificate(BRN).business_address;
        }
        let w = store
            .create_workplace(&cmd(&actor), entity, input, port())
            .await
            .unwrap()
            .record;
        let original = w.current.unwrap().address.unwrap().road_addr_part1;
        let history_len = store
            .workplace_history(&actor, w.id, true)
            .await
            .unwrap()
            .len();
        let known_at: time::OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&owner)
            .await
            .unwrap();
        let doc = upload(&store, &actor, "moved").await;
        let mut reissue = moved(&store, &actor, entity, reg, Some(doc)).await;
        reissue.entity = None;
        store
            .reissue_registration(&cmd(&actor), reg, reissue)
            .await
            .unwrap();

        for (as_of, known_at, expected) in [
            (date!(2026 - 09 - 30), None, original.as_str()),
            (date!(2026 - 10 - 02), Some(known_at), original.as_str()),
            (
                date!(2026 - 10 - 02),
                None,
                if linked { BUSAN } else { original.as_str() },
            ),
        ] {
            let e = store
                .get_entity_at(
                    &actor,
                    entity,
                    true,
                    ReadOptions {
                        as_of: Some(as_of),
                        known_at,
                    },
                )
                .await
                .unwrap();
            let current = e
                .workplaces
                .iter()
                .find(|x| x.id == w.id)
                .unwrap()
                .current
                .as_ref()
                .unwrap();
            assert_eq!(current.address.as_ref().unwrap().road_addr_part1, expected);
        }
        assert_eq!(
            store
                .workplace_history(&actor, w.id, true)
                .await
                .unwrap()
                .len(),
            history_len,
            "a certificate change resolves the link without fabricating a workplace revision"
        );
    }
}
