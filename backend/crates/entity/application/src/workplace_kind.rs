//! 사업장 kind list (decisions #18): commands and the wire view.

use serde::{Deserialize, Deserializer, Serialize};

/// One kind as the list editor and the picker read it.
#[derive(Debug, Clone, Serialize)]
pub struct WorkplaceKindView {
    pub code: String,
    /// The tenant's label; `None` on a platform default = the catalog label.
    pub label: Option<String>,
    /// A platform default (labelled by the catalog unless relabelled).
    pub platform: bool,
    /// Offered in the picker. A deactivated kind still reads on its 사업장.
    pub active: bool,
}

/// Add a tenant kind; the server generates its code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateWorkplaceKind {
    pub label: Option<String>,
}

/// Relabel and/or (de)activate one kind. `label` absent keeps it; `null`
/// returns a platform default to its catalog label (refused on a tenant kind).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateWorkplaceKind {
    #[serde(default, deserialize_with = "present")]
    pub label: Option<Option<String>>,
    pub active: Option<bool>,
}

/// Set (or clear, `null` = 미지정) the kind of one 사업장.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetWorkplaceKind {
    pub kind_code: Option<String>,
}

/// A field that is present, even as `null`.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::deserialize(d)?))
}
