//! Shared natural-person SoD overlay; callers already authorize the action.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "independent_people";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action independent_people appliesTo {
  principal: [Subject], resource: [Resource],
  context: { "independent": Bool }
};"#;
const POLICIES: &str = r#"permit (principal, action == Action::"independent_people", resource)
when { principal.org == resource.org && context.independent };"#;

fn bundle() -> Result<&'static ActionBundle, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)
}

/// Load and lock both account/person bindings until the caller commits.
/// Compilation or evaluation diagnostics are a refusal.
pub async fn authorized_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    maker: Option<uuid::Uuid>,
    checker: uuid::Uuid,
) -> Result<bool, sqlx::Error> {
    let (org, independent): (Option<String>, bool) = sqlx::query_as(
        "SELECT NULLIF(current_setting('app.current_org',true),''), \
         public.console_independent_people(NULLIF(current_setting('app.current_org',true),'')::uuid,$1,$2)",
    ).bind(maker).bind(checker).fetch_one(tx.as_mut()).await?;
    let Some(org) = org else {
        return Ok(false);
    };
    Ok(bundle()
        .and_then(|b| {
            b.decide(
                &checker.to_string(),
                &org,
                &[],
                &org,
                &[("independent", Fact::Bool(independent))],
            )
        })
        .unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_and_non_independent_facts_deny() {
        let bundle = bundle().unwrap();
        assert!(bundle.decide("u", "o", &[], "o", &[]).is_err());
        assert_eq!(
            bundle.decide("u", "o", &[], "o", &[("independent", Fact::Bool(false))]),
            Ok(false)
        );
        assert_eq!(
            bundle.decide("u", "o", &[], "o", &[("independent", Fact::Bool(true))]),
            Ok(true)
        );
        assert_eq!(
            bundle.decide(
                "u",
                "o",
                &[],
                "foreign",
                &[("independent", Fact::Bool(true))]
            ),
            Ok(false)
        );
    }
}
