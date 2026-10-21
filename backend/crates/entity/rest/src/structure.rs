//! 회사 구조 labels (review R15, R16): a 사업장's code takes
//! `legal_entity_manage` on that 사업장; the order of a 법인's 사업장 takes it
//! on the 법인, the order of the tenant's 법인 on the tenant (a tenant grant,
//! like a new 법인); the order of 부서 takes the org-change apply permission,
//! like every other setup 부서 write.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use console_entity_application::{ReorderStructure, SetWorkplaceCode, Target};
use uuid::Uuid;

use crate::EntityRestState;
use crate::auth::{Need, manager, writer};
use crate::error::RestError;

type Result<T> = std::result::Result<T, RestError>;

pub(crate) async fn set_code(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<SetWorkplaceCode>,
) -> Result<Response> {
    let a = manager(&s, &h, Target::Workplace(id)).await?;
    Ok(Json(s.store.set_workplace_code(&a, id, b).await?).into_response())
}

pub(crate) async fn reorder(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Json(b): Json<ReorderStructure>,
) -> Result<Response> {
    let p = &b.parent;
    let a = match (p.legal_entity_id, p.workplace_id, p.org_unit_id) {
        (Some(entity), _, _) => manager(&s, &h, Target::Entity(entity)).await?,
        (None, None, None) => manager(&s, &h, Target::Tenant).await?,
        _ => writer(&s, &h, Need::Structure).await?,
    };
    Ok(Json(s.store.reorder_structure(&a, b).await?).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reorder_names_its_parent_flat() {
        let b: ReorderStructure = serde_json::from_str(
            r#"{"workplace_id":"00000000-0000-0000-0000-000000000001","children":[]}"#,
        )
        .unwrap();
        assert_eq!(b.parent.workplace_id, Some(Uuid::from_u128(1)));
        assert!(b.parent.legal_entity_id.is_none() && b.children.is_empty());
        assert!(b.expected_children.is_none());
    }

    #[test]
    fn a_tenant_reorder_names_no_parent_and_may_pin_the_order_it_read() {
        let b: ReorderStructure = serde_json::from_str(
            r#"{"children":["00000000-0000-0000-0000-000000000002"],"expected_children":["00000000-0000-0000-0000-000000000002"]}"#,
        )
        .unwrap();
        assert_eq!(
            b.parent,
            console_entity_application::StructureParent::default()
        );
        assert_eq!(b.expected_children, Some(vec![Uuid::from_u128(2)]));
    }
}
