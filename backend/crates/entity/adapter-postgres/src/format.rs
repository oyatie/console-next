//! Identifiers on the wire: canonical digits with the masked form beside them.

use console_entity_application::{DirectorView, Formatted};
use console_entity_domain::codes::DirectorRole;
use console_kernel_core::kr::{BizRegNo, CorpRegNo, PhoneE164};

pub(crate) fn fmt_brn(raw: Option<String>) -> Option<Formatted> {
    raw.and_then(|v| BizRegNo::parse(&v).ok())
        .map(|b| Formatted {
            value: b.as_str().into(),
            display: b.display(),
        })
}

pub(crate) fn fmt_crn(raw: Option<String>) -> Option<Formatted> {
    raw.and_then(|v| CorpRegNo::parse(&v).ok())
        .map(|c| Formatted {
            value: c.as_str().into(),
            display: c.display(),
        })
}

pub(crate) fn fmt_phone(raw: Option<String>) -> Option<Formatted> {
    raw.and_then(|v| PhoneE164::parse(&v).ok())
        .map(|p| Formatted {
            value: p.as_str().into(),
            display: p.display(),
        })
}

/// The 임원 of one revision row (`director_roles/names/dates`, printed order).
pub(crate) fn directors(r: &sqlx::postgres::PgRow) -> Result<Vec<DirectorView>, sqlx::Error> {
    use sqlx::Row;
    let roles: Vec<String> = r
        .try_get::<Option<_>, _>("director_roles")?
        .unwrap_or_default();
    let names: Vec<String> = r
        .try_get::<Option<_>, _>("director_names")?
        .unwrap_or_default();
    let dates: Vec<Option<time::Date>> = r
        .try_get::<Option<_>, _>("director_dates")?
        .unwrap_or_default();
    Ok(roles
        .iter()
        .zip(names)
        .zip(dates)
        .filter_map(|((role, name), appointed_on)| {
            Some(DirectorView {
                role: DirectorRole::parse(role)?,
                name,
                appointed_on,
            })
        })
        .collect())
}
