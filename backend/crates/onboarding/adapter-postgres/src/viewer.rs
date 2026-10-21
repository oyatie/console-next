//! Setup decisions use the same live Cedar slice as the record's own door.
use console_kernel_core::ErrorKind;
use console_onboarding_domain::Checklist;
use console_platform_authz::access::{AccessSlice, Domain, Level, NodePath, load_access_subject};
use sqlx::{Postgres, Transaction};

use crate::{OnboardingActor, PgOnboardingError, refused};

pub(crate) async fn checklist_permissions(
    tx: &mut Transaction<'_, Postgres>,
    actor: &OnboardingActor,
    checklist: &mut Checklist,
) -> Result<(), PgOnboardingError> {
    let subject = load_access_subject(
        tx,
        actor.org,
        *actor.user.as_uuid(),
        time::OffsetDateTime::now_utc(),
    )
    .await?;
    apply_permissions(&subject, checklist)
}

fn apply_permissions(
    subject: &console_platform_authz::access::AccessSubject,
    checklist: &mut Checklist,
) -> Result<(), PgOnboardingError> {
    let slice = AccessSlice::compile(subject).map_err(|_| {
        refused(
            ErrorKind::Forbidden,
            "forbidden",
            Some("request_setup_permission"),
        )
    })?;
    let readable = subject.grants.iter().any(|g| {
        g.lines.iter().any(|line| {
            line.levels.iter().any(|level| {
                slice.allows(
                    &format!("{}::{}", line.domain.as_str(), level.as_str()),
                    &g.scope,
                ) == Ok(true)
            })
        })
    }) || slice.allows("tenant::approve", &NodePath::tenant(subject.org))
        == Ok(true);
    if !readable {
        return Err(refused(
            ErrorKind::Forbidden,
            "forbidden",
            Some("request_setup_permission"),
        ));
    }
    for step in &mut checklist.steps {
        step.can_act = if matches!(step.needs, "tenant_ops" | "own_account") {
            subject.is_ops
                && slice.allows("tenant::approve", &NodePath::tenant(subject.org)) == Ok(true)
        } else if matches!(step.key, "entity" | "roles") {
            slice.allows(step.needs, &NodePath::tenant(subject.org)) == Ok(true)
        } else {
            let scopes = std::iter::once(NodePath::tenant(subject.org))
                .chain(subject.grants.iter().map(|g| g.scope.clone()));
            scopes
                .into_iter()
                .any(|scope| slice.allows(step.needs, &scope) == Ok(true))
        };
        step.skippable &= slice.allows(step.needs, &NodePath::tenant(subject.org)) == Ok(true);
    }
    Ok(())
}

pub(crate) async fn require_ops(
    tx: &mut Transaction<'_, Postgres>,
    actor: &OnboardingActor,
) -> Result<(), PgOnboardingError> {
    let mut subject = load_access_subject(
        tx,
        actor.org,
        *actor.user.as_uuid(),
        time::OffsetDateTime::now_utc(),
    )
    .await?;
    // These acts belong to the contracting ops holder, never to a delegated tenant grant.
    subject.grants.clear();
    let allowed = AccessSlice::compile(&subject)
        .and_then(|slice| slice.allows("tenant::approve", &NodePath::tenant(subject.org)))
        .unwrap_or(false);
    if allowed {
        Ok(())
    } else {
        Err(refused(
            ErrorKind::Forbidden,
            "forbidden",
            Some("tenant_ops_required"),
        ))
    }
}

pub(crate) async fn require_step(
    tx: &mut Transaction<'_, Postgres>,
    actor: &OnboardingActor,
    step: &str,
) -> Result<(), PgOnboardingError> {
    let (domain, level) = match step {
        "org" => (Domain::Org, Level::Edit),
        "employees" => (Domain::HrBasic, Level::Edit),
        "roles" => (Domain::Access, Level::Edit),
        _ => return Err(refused(ErrorKind::Validation, "step_not_skippable", None)),
    };
    let subject = load_access_subject(
        tx,
        actor.org,
        *actor.user.as_uuid(),
        time::OffsetDateTime::now_utc(),
    )
    .await?;
    let slice = AccessSlice::compile(&subject).map_err(|_| {
        refused(
            ErrorKind::Forbidden,
            "forbidden",
            Some("request_setup_permission"),
        )
    })?;
    // Skips are tenant-wide choices; a scoped grant cannot complete the tenant's step.
    if slice.allows(
        &format!("{}::{}", domain.as_str(), level.as_str()),
        &NodePath::tenant(subject.org),
    ) != Ok(true)
    {
        return Err(refused(
            ErrorKind::Forbidden,
            "forbidden",
            Some("request_setup_permission"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use console_kernel_core::{BranchScope, OrgId, TenantPhase};
    use console_onboarding_domain::{SetupFacts, checklist};
    use console_platform_authz::access::{AccessSubject, HeldGrant, RoleLine};
    use uuid::Uuid;

    fn subject() -> AccessSubject {
        AccessSubject {
            org: OrgId::new(),
            account: Uuid::new_v4(),
            is_ops: false,
            phase: TenantPhase::Setup,
            grants: Vec::new(),
        }
    }

    #[test]
    fn no_setup_grant_is_forbidden_and_does_not_change_permissions() {
        let s = subject();
        let mut c = checklist(&SetupFacts::default());
        let before = c.clone();
        assert!(matches!(
            apply_permissions(&s, &mut c),
            Err(PgOnboardingError::Refused {
                kind: ErrorKind::Forbidden,
                code: "forbidden",
                remedy: Some("request_setup_permission"),
                ..
            })
        ));
        assert_eq!(before, c);
    }

    #[test]
    fn an_hr_edit_grant_only_arms_the_employee_step() {
        let mut s = subject();
        s.grants.push(HeldGrant {
            grant_id: Uuid::new_v4(),
            role_id: Uuid::new_v4(),
            role_version: 1,
            lines: vec![RoleLine {
                domain: Domain::HrBasic,
                levels: vec![Level::Edit],
            }],
            scope: NodePath::tenant(s.org),
            branches: BranchScope::All,
        });
        let mut c = checklist(&SetupFacts::default());
        apply_permissions(&s, &mut c).unwrap();
        assert_eq!(
            c.steps
                .iter()
                .filter(|s| s.can_act)
                .map(|s| s.key)
                .collect::<Vec<_>>(),
            vec!["employees"]
        );
        assert_eq!(c.steps[0].needs, "org::edit");
    }
}
