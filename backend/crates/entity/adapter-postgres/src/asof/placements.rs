//! A dated workplace uses its latest live representing SITE, including same-day reopenings.
use crate::{PgEntityError, Tx};
use console_entity_application::ReadPoint;
use std::collections::HashMap;
use uuid::Uuid;

pub(crate) async fn represented(
    tx: &mut Tx<'_>,
    p: ReadPoint,
) -> Result<HashMap<Uuid, Uuid>, PgEntityError> {
    Ok(sqlx::query_as(
        "WITH heads AS (SELECT DISTINCT ON (org_unit_id) org_unit_id,attributes FROM org_unit_revisions \
            WHERE COALESCE(entity_try_iso_date(attributes->>'effective_from'),(created_at AT TIME ZONE 'Asia/Seoul')::date) <= $1 \
              AND created_at <= COALESCE($2::timestamptz,now()) \
            ORDER BY org_unit_id,COALESCE(entity_try_iso_date(attributes->>'effective_from'),(created_at AT TIME ZONE 'Asia/Seoul')::date) DESC,version DESC) \
         SELECT DISTINCT ON (p.workplace_id) p.workplace_id,p.org_unit_id FROM org_unit_placements p \
         JOIN heads h ON h.org_unit_id=p.org_unit_id AND COALESCE(h.attributes->>'status','active') <> 'dissolved' \
         WHERE p.represents_workplace AND p.valid_from <= $1 AND p.created_at <= COALESCE($2::timestamptz,now()) \
           AND (p.valid_to IS NULL OR p.valid_to > $1 OR p.valid_to_recorded_at > $2) \
         ORDER BY p.workplace_id,p.valid_from DESC,p.created_at DESC,p.id DESC",
    ).bind(p.as_of).bind(p.known_at).fetch_all(tx.as_mut()).await?.into_iter().collect())
}
