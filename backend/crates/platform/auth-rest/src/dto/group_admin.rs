use serde::Deserialize;
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub(crate) struct GroupAdminMemberOrgResponse {
    pub(crate) id: Uuid,
    pub(crate) slug: String,
    pub(crate) name: String,
    pub(crate) status: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct GroupAdminGroupResponse {
    pub(crate) id: Uuid,
    pub(crate) slug: String,
    pub(crate) name: String,
    pub(crate) status: String,
    pub(crate) members: Vec<GroupAdminMemberOrgResponse>,
}

#[derive(Debug, Serialize)]
pub(crate) struct GroupAdminGroupsResponse {
    pub(crate) groups: Vec<GroupAdminGroupResponse>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GroupAdminTenantContextStartRequest {
    pub(crate) org_id: Uuid,
}

#[derive(Debug, Serialize)]
pub(crate) struct GroupAdminTenantContextStartResponse {
    pub(crate) access_token: String,
    pub(crate) token_type: &'static str,
    pub(crate) acting_org_id: Uuid,
    pub(crate) acting_org_name: String,
    pub(crate) acting_role: &'static str,
    #[serde(with = "time::serde::rfc3339")]
    pub(crate) expires_at: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GroupAdminTenantContextExitRequest {
    pub(crate) org_id: Uuid,
}

#[derive(Debug, Serialize)]
pub(crate) struct GroupAdminTenantContextExitResponse {
    pub(crate) ended: bool,
}
