//! AX-3: the tenant compiler. Role lines become Cedar templates, grants become
//! links, and two platform policies sit beside them (access-model §4.2):
//!
//! * `platform.isolation` — a `forbid` across tenants (GR-1);
//! * `platform.ops` — the ops account's break-glass `permit` (GR-3). Tenant
//!   policy is permit-only from role lines here, so nothing can deny ops.
//!
//! Fail-closed (GR-4): any parse, link or strict-validation error or warning
//! refuses the slice, and any evaluation diagnostic error or incomplete
//! ancestor chain is an error, never an allow. Only the subject's own grants
//! are linked (the per-principal slice, §4.4).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::str::FromStr;
use std::sync::OnceLock;

use cedar_policy::{
    Authorizer, Context, Decision, Entities, Entity, EntityId, EntityTypeName, EntityUid, Policy,
    PolicyId, PolicySet, Request, RestrictedExpression, Schema, SlotId, Template, ValidationMode,
    Validator,
};
use uuid::Uuid;

use super::catalog::{Domain, action_group};
use super::model::{AccessSubject, NodeKind, NodePath};
use super::tags::tagged;

/// Why the engine could not decide (always a deny for the caller).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AccessEngineError {
    #[error("access schema: {0}")]
    Schema(String),
    #[error("access policy set: {0}")]
    Compile(String),
    #[error("authz_fact_missing: {0}")]
    FactMissing(String),
    #[error("access evaluation: {0}")]
    Evaluation(String),
}

const APPLIES: &str =
    "appliesTo { principal: [Account], resource: [Tenant, LegalEntity, Workplace, Dept] };";

const PLATFORM_POLICIES: [(&str, &str); 2] = [
    (
        "platform.isolation",
        "forbid (principal, action, resource) unless { resource.org == principal.org };",
    ),
    (
        "platform.ops",
        "permit (principal, action, resource) when { principal.is_ops };",
    ),
];

/// The platform schema: the node hierarchy, grants, accounts, one action group
/// per offered (domain, level) and one action per tagged operation key.
#[must_use]
pub fn schema_source() -> String {
    let mut src = String::from(
        "entity Tenant = { org: String };\n\
         entity LegalEntity in [Tenant] = { org: String };\n\
         entity Workplace in [LegalEntity] = { org: String };\n\
         entity Dept in [Workplace, Dept] = { org: String };\n\
         entity Grant;\n\
         entity Account in [Grant] = { org: String, is_ops: Bool };\n",
    );
    for domain in Domain::ALL {
        for level in domain.offered() {
            src.push_str(&format!(
                "action \"{}\" {APPLIES}\n",
                action_group(domain, *level)
            ));
        }
    }
    for (feature, domain, level) in tagged() {
        src.push_str(&format!(
            "action \"{}\" in [\"{}\"] {APPLIES}\n",
            feature.as_str(),
            action_group(domain, level)
        ));
    }
    src
}

fn schema() -> Result<&'static Schema, AccessEngineError> {
    static SCHEMA: OnceLock<Result<Schema, String>> = OnceLock::new();
    SCHEMA
        .get_or_init(|| Schema::from_str(&schema_source()).map_err(|e| e.to_string()))
        .as_ref()
        .map_err(|e| AccessEngineError::Schema(e.clone()))
}

fn uid(ty: &str, id: &str) -> Result<EntityUid, AccessEngineError> {
    let ty = EntityTypeName::from_str(ty).map_err(|e| AccessEngineError::Compile(e.to_string()))?;
    Ok(EntityUid::from_type_name_and_id(ty, EntityId::new(id)))
}

fn node_uid(kind: NodeKind, id: Uuid) -> Result<EntityUid, AccessEngineError> {
    uid(kind.cedar_type(), &id.to_string())
}

fn compile_err(e: impl std::fmt::Display) -> AccessEngineError {
    AccessEngineError::Compile(e.to_string())
}

/// The template source of one role line.
#[must_use]
pub fn template_source(domain: Domain, levels: &[super::catalog::Level]) -> String {
    let actions: Vec<String> = levels
        .iter()
        .map(|l| format!("Action::\"{}\"", action_group(domain, *l)))
        .collect();
    format!(
        "permit (principal in ?principal, action in [{}], resource in ?resource);",
        actions.join(", ")
    )
}

/// A compiled per-principal slice: platform policies, the templates of the
/// subject's role versions, one link per held grant × line.
#[derive(Debug)]
pub struct AccessSlice {
    policies: PolicySet,
    subject: Vec<Entity>,
    principal: EntityUid,
    org: String,
}

impl AccessSlice {
    /// # Errors
    /// Any schema, parse, link or strict-validation error or warning.
    pub fn compile(subject: &AccessSubject) -> Result<Self, AccessEngineError> {
        crate::cedar_stack::with_cedar_stack(|| {
            let schema = schema()?;
            let mut policies = PolicySet::new();
            for (id, src) in PLATFORM_POLICIES {
                let policy = Policy::parse(Some(PolicyId::new(id)), src).map_err(compile_err)?;
                policies.add(policy).map_err(compile_err)?;
            }
            let mut templates = BTreeSet::new();
            for grant in &subject.grants {
                let target = grant.scope.node().ok_or_else(|| {
                    AccessEngineError::FactMissing(format!("grant {} has no scope", grant.grant_id))
                })?;
                for line in &grant.lines {
                    let template_id = format!(
                        "t:{}:{}:{}",
                        grant.role_id,
                        grant.role_version,
                        line.domain.as_str()
                    );
                    if templates.insert(template_id.clone()) {
                        let src = template_source(line.domain, &line.levels);
                        let template = Template::parse(Some(PolicyId::new(&template_id)), src)
                            .map_err(compile_err)?;
                        policies.add_template(template).map_err(compile_err)?;
                    }
                    let slots = HashMap::from([
                        (
                            SlotId::principal(),
                            uid("Grant", &grant.grant_id.to_string())?,
                        ),
                        (SlotId::resource(), node_uid(target.kind, target.id)?),
                    ]);
                    let link_id = format!("l:{}:{}", grant.grant_id, line.domain.as_str());
                    policies
                        .link(PolicyId::new(&template_id), PolicyId::new(link_id), slots)
                        .map_err(compile_err)?;
                }
            }
            // Only the source-defined platform policy set can reuse validation.
            static PLATFORM_VALIDATED: OnceLock<()> = OnceLock::new();
            if !subject.grants.is_empty() || PLATFORM_VALIDATED.get().is_none() {
                let result =
                    Validator::new(schema.clone()).validate(&policies, ValidationMode::Strict);
                if !result.validation_passed_without_warnings() {
                    let detail: Vec<String> = result
                        .validation_errors()
                        .map(ToString::to_string)
                        .chain(result.validation_warnings().map(ToString::to_string))
                        .collect();
                    return Err(AccessEngineError::Compile(detail.join("; ")));
                }
                if subject.grants.is_empty() {
                    let _ = PLATFORM_VALIDATED.set(());
                }
            }
            let org = subject.org.as_uuid().to_string();
            let principal = uid("Account", &subject.account.to_string())?;
            let grant_uids = subject
                .grants
                .iter()
                .map(|g| uid("Grant", &g.grant_id.to_string()))
                .collect::<Result<HashSet<_>, _>>()?;
            let mut entities = vec![
                Entity::new(
                    principal.clone(),
                    HashMap::from([
                        (
                            "org".to_owned(),
                            RestrictedExpression::new_string(org.clone()),
                        ),
                        (
                            "is_ops".to_owned(),
                            RestrictedExpression::new_bool(subject.is_ops),
                        ),
                    ]),
                    grant_uids.clone(),
                )
                .map_err(compile_err)?,
            ];
            for grant in grant_uids {
                entities.push(Entity::with_uid(grant));
            }
            Ok(Self {
                policies,
                subject: entities,
                principal,
                org,
            })
        })
    }

    /// Does the subject hold `action` (an operation key or a `domain::level`
    /// group) on `resource`?
    ///
    /// # Errors
    /// An incomplete or foreign ancestor chain (GR-27), or any Cedar error.
    pub fn allows(&self, action: &str, resource: &NodePath) -> Result<bool, AccessEngineError> {
        crate::cedar_stack::with_cedar_stack(|| {
            let schema = schema()?;
            let nodes = self.node_entities(resource)?;
            let target = resource
                .node()
                .ok_or_else(|| AccessEngineError::FactMissing("empty resource path".into()))?;
            let entities =
                Entities::from_entities(self.subject.iter().cloned().chain(nodes), Some(schema))
                    .map_err(|e| AccessEngineError::Evaluation(e.to_string()))?;
            let request = Request::new(
                self.principal.clone(),
                uid("Action", action)?,
                node_uid(target.kind, target.id)?,
                Context::empty(),
                Some(schema),
            )
            .map_err(|e| AccessEngineError::Evaluation(e.to_string()))?;
            let response = Authorizer::new().is_authorized(&request, &self.policies, &entities);
            let errors: Vec<String> = response
                .diagnostics()
                .errors()
                .map(ToString::to_string)
                .collect();
            if !errors.is_empty() {
                return Err(AccessEngineError::Evaluation(errors.join("; ")));
            }
            Ok(response.decision() == Decision::Allow)
        })
    }

    fn node_entities(&self, path: &NodePath) -> Result<Vec<Entity>, AccessEngineError> {
        // GR-27: Cedar accepts a parent of any type, so the shape is checked
        // here — every link one level up, ending at this tenant.
        let linked = path.0.windows(2).all(|w| {
            matches!(
                (w[0].kind, w[1].kind),
                (
                    NodeKind::Department,
                    NodeKind::Department | NodeKind::Workplace
                ) | (NodeKind::Workplace, NodeKind::LegalEntity)
                    | (NodeKind::LegalEntity, NodeKind::Tenant)
            )
        });
        let complete = linked
            && path
                .0
                .last()
                .is_some_and(|n| n.kind == NodeKind::Tenant && n.id.to_string() == self.org);
        if !complete {
            return Err(AccessEngineError::FactMissing(
                "the ancestor chain does not end at this tenant".into(),
            ));
        }
        let mut out = Vec::with_capacity(path.0.len());
        for (i, node) in path.0.iter().enumerate() {
            let parents = path
                .0
                .get(i + 1)
                .map(|p| node_uid(p.kind, p.id))
                .transpose()?
                .into_iter()
                .collect::<HashSet<_>>();
            let entity = Entity::new(
                node_uid(node.kind, node.id)?,
                HashMap::from([(
                    "org".to_owned(),
                    RestrictedExpression::new_string(self.org.clone()),
                )]),
                parents,
            )
            .map_err(compile_err)?;
            out.push(entity);
        }
        Ok(out)
    }
}
