async fn audit_actions_for_target_type(pool: &PgPool, target_type: &str) -> Vec<String> {
    sqlx::query("SELECT action FROM audit_events WHERE target_type = $1 ORDER BY occurred_at")
        .bind(target_type)
        .fetch_all(pool)
        .await
        .unwrap()
        .iter()
        .map(|row| row.get::<String, _>("action"))
        .collect()
}
