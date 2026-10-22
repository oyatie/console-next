//! Shared natural-person SoD overlay; callers already authorize the action.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "independent_people";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action independent_people appliesTo {
  principal: [Subject], resource: [Resource],
  context: { "makerPerson": String, "checkerPerson": String }
};"#;
const POLICIES: &str = r#"permit (principal, action == Action::"independent_people", resource)
when { principal.org == resource.org && context.makerPerson != "" &&
       context.checkerPerson != "" && context.makerPerson != context.checkerPerson };"#;

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
    let facts = sqlx::query_as::<_, (Option<String>, Option<uuid::Uuid>, Option<uuid::Uuid>)>(
        "SELECT NULLIF(current_setting('app.current_org',true),''), maker_person, checker_person \
         FROM public.console_decision_people(NULLIF(current_setting('app.current_org',true),'')::uuid,$1,$2)",
    ).bind(maker).bind(checker).fetch_one(tx.as_mut()).await;
    // A failed resolver must return the caller's stable SoD refusal, never permission.
    let Ok((Some(org), Some(maker_person), Some(checker_person))) = facts else {
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
                    ("makerPerson", Fact::Str(maker_person.to_string())),
                    ("checkerPerson", Fact::Str(checker_person.to_string())),
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
        ] {
            let facts = [
                ("makerPerson", Fact::Str(maker.into())),
                ("checkerPerson", Fact::Str(checker.into())),
            ];
            assert_eq!(bundle.decide("u", "o", &[], "o", &facts), Ok(allowed));
            assert_eq!(bundle.decide("u", "o", &[], "foreign", &facts), Ok(false));
        }
    }
}
