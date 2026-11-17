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

/// Evaluate a set-loaded pair from the canonical decision-people fact loader.
pub fn decide_people(
    org: uuid::Uuid,
    actor: uuid::Uuid,
    maker: Option<uuid::Uuid>,
    checker: Option<uuid::Uuid>,
) -> Result<bool, String> {
    bundle()?.decide(
        &actor.to_string(),
        &org.to_string(),
        &[],
        &org.to_string(),
        &[
            (
                "makerPerson",
                Fact::Str(maker.map_or_else(String::new, |id| id.to_string())),
            ),
            (
                "checkerPerson",
                Fact::Str(checker.map_or_else(String::new, |id| id.to_string())),
            ),
        ],
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    IdentityUnbound,
    SamePerson,
}

impl Refusal {
    #[must_use]
    pub const fn code(self, unbound: &'static str, same_person: &'static str) -> &'static str {
        match self {
            Self::IdentityUnbound => unbound,
            Self::SamePerson => same_person,
        }
    }
}

/// Resolve reviewed employee-bound people. Missing facts and resolver/Cedar errors deny.
pub async fn refusal_in_tx(
    conn: &mut sqlx::PgConnection,
    maker: Option<uuid::Uuid>,
    checker: uuid::Uuid,
) -> Option<Refusal> {
    let facts = sqlx::query_as::<_, (Option<String>, Option<uuid::Uuid>, Option<uuid::Uuid>)>(
        "SELECT NULLIF(current_setting('app.current_org',true),''), maker_person, checker_person \
         FROM public.console_decision_people(NULLIF(current_setting('app.current_org',true),'')::uuid,$1,$2)",
    ).bind(maker).bind(checker).fetch_one(conn).await;
    let Ok((Some(org), Some(maker_person), Some(checker_person))) = facts else {
        return Some(Refusal::IdentityUnbound);
    };
    match bundle().and_then(|b| {
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
    }) {
        Ok(true) => None,
        Ok(false) => Some(Refusal::SamePerson),
        Err(_) => Some(Refusal::IdentityUnbound),
    }
}

pub async fn authorized_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    maker: Option<uuid::Uuid>,
    checker: uuid::Uuid,
) -> Result<bool, sqlx::Error> {
    Ok(refusal_in_tx(tx.as_mut(), maker, checker).await.is_none())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_and_non_independent_facts_deny() {
        let bundle = bundle().unwrap();
        let org = uuid::Uuid::new_v4();
        let maker = uuid::Uuid::new_v4();
        let checker = uuid::Uuid::new_v4();
        for (a, b, allowed) in [
            (None, Some(checker), false),
            (Some(maker), None, false),
            (Some(maker), Some(maker), false),
            (Some(maker), Some(checker), true),
        ] {
            assert_eq!(super::decide_people(org, checker, a, b), Ok(allowed));
        }
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
