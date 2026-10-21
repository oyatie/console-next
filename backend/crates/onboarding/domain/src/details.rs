//! The records and access that will exist when operations start.
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Breakdown {
    pub kind: String,
    pub id: String,
    pub name: String,
    pub legal_entity_id: String,
    pub people: i64,
    pub units: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Account {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RoleActivation {
    pub role_id: String,
    pub role: String,
    pub holders: Vec<Account>,
    pub scope_kind: String,
    pub scope_id: String,
    pub scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TermsVersion {
    pub version: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct PreviewDetails {
    pub terms_version: Option<TermsVersion>,
    pub breakdown: Vec<Breakdown>,
    pub roles_becoming_active: Vec<RoleActivation>,
    pub access_admin_holders: Vec<Account>,
    pub hr_accounts_with_no_grant: Vec<Account>,
}
