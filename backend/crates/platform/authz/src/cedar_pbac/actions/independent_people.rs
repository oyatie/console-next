//! Shared strongest-available-identity SoD overlay; callers already authorize the action.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "independent_people";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action independent_people appliesTo {
  principal: [Subject], resource: [Resource],
  context: { "makerIdentity": String, "checkerIdentity": String }
};"#;
const POLICIES: &str = r#"permit (principal, action == Action::"independent_people", resource)
when { principal.org == resource.org && context.makerIdentity != "" &&
       context.checkerIdentity != "" && context.makerIdentity != context.checkerIdentity &&
       !(context.makerIdentity like "ops:*") && !(context.checkerIdentity like "ops:*") };"#;

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
    let facts = sqlx::query_as::<_, (Option<String>, Option<String>, Option<String>)>(
        "SELECT NULLIF(current_setting('app.current_org',true),''), maker_identity, checker_identity \
         FROM public.console_decision_identities(NULLIF(current_setting('app.current_org',true),'')::uuid,$1,$2)",
    ).bind(maker).bind(checker).fetch_one(tx.as_mut()).await;
    // A failed resolver must return the caller's stable SoD refusal, never permission.
    let Ok((Some(org), Some(maker_identity), Some(checker_identity))) = facts else {
        return Ok(false);
    };
    Ok(bundle()
        .and_then(|b| {
            b.decide(
                &checker.to_string(),
                &org,
                &[],
                &org,
                &[
                    ("makerIdentity", Fact::Str(maker_identity)),
                    ("checkerIdentity", Fact::Str(checker_identity)),
                ],
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
        for (maker, checker, allowed) in [
            ("a", "a", false),
            ("", "b", false),
            ("a", "", false),
            ("a", "b", true),
            ("person:a", "person:a", false),
            ("person:a", "account:a", true),
            ("ops:a", "person:b", false),
            ("account:a", "ops:b", false),
        ] {
            let facts = [
                ("makerIdentity", Fact::Str(maker.into())),
                ("checkerIdentity", Fact::Str(checker.into())),
            ];
            assert_eq!(bundle.decide("u", "o", &[], "o", &facts), Ok(allowed));
            assert_eq!(bundle.decide("u", "o", &[], "foreign", &facts), Ok(false));
        }
    }
}
