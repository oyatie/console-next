//! DB fixtures shared by this crate's runtime-role tests: the `console_rt` pool and
//! owner-side seeding (split out of cedar_authoring_rls_as_runtime_role.rs, file-size cap 300).

use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

pub async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

pub async fn seed_org(pool: &PgPool, org_id: Uuid, slug: &str) {
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)")
        .bind(org_id)
        .bind(slug)
        .bind(format!("Org {slug}"))
        .execute(pool)
        .await
        .unwrap();
}

/// Seed a catalog entry as the OWNER (console_rt has no catalog INSERT). A `draft`
/// status entry needs no policy_version/bundle_digest, and the attach path reads
/// its `generated_policy_text` regardless of status.
pub async fn seed_catalog_entry(
    pool: &PgPool,
    org_id: Uuid,
    stable_key: &str,
    effect: &str,
    generated_text: &str,
) -> Uuid {
    sqlx::query_scalar(
        r#"
        INSERT INTO cedar_policy_catalog_entries
            (org_id, stable_key, title, natural_language_rule, effect, status, source,
             principal, action, resource, conditions, validation_status, generated_policy_text)
        VALUES ($1, $2, $3, 'authored in test', $4, 'draft', 'no_code_draft',
                '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 'valid', $5)
        RETURNING id
        "#,
    )
    .bind(org_id)
    .bind(stable_key)
    .bind(format!("Policy {stable_key}"))
    .bind(effect)
    .bind(generated_text)
    .fetch_one(pool)
    .await
    .unwrap()
}

pub async fn attach_object_policy(
    pool: &PgPool,
    org_id: Uuid,
    object_type_id: Uuid,
    cedar_policy_id: Uuid,
    effect: &str,
) {
    sqlx::query(
        r#"
        INSERT INTO ont_object_policies (org_id, object_type_id, cedar_policy_id, effect)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(org_id)
    .bind(object_type_id)
    .bind(cedar_policy_id)
    .bind(effect)
    .execute(pool)
    .await
    .unwrap();
}
