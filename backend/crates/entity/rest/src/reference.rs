//! Reference reads for the entity forms: official code lists (bundled,
//! versioned) and the 도로명주소 / 상세주소 proxies (juso.go.kr through the
//! server; `UNAVAILABLE` when no usable key is configured).

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use console_entity_adapter_juso::{
    AddressDetail, AddressSearch, Building, JusoRefusal, SearchStatus,
};
use console_entity_domain::Refusal;
use console_entity_domain::refusal::Issues;
use console_kernel_core::ErrorKind;
use serde::Deserialize;
use serde_json::json;

use crate::EntityRestState;
use crate::auth::{Need, actor};
use crate::error::RestError;
use console_entity_application::Target;

type Result<T> = std::result::Result<T, RestError>;

/// Codes returned per request; the picker narrows by typing.
const CODES_PER_PAGE: usize = 50;

#[derive(Debug, Deserialize)]
pub(crate) struct CodesQuery {
    #[serde(default)]
    q: String,
    /// Accepted for the contract; every bundled list has one version today.
    #[serde(default)]
    #[allow(dead_code)]
    as_of: Option<String>,
}

pub(crate) async fn codes(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Path(key): Path<String>,
    Query(q): Query<CodesQuery>,
) -> Result<Response> {
    actor(&s, &h, Need::Read, Target::Tenant).await?;
    let (list, items) = console_refdata::search(&key, &q.q, CODES_PER_PAGE)
        .ok_or_else(|| Refusal::not_found("ref_list_not_found"))?;
    Ok(Json(json!({ "list": list, "items": items })).into_response())
}

fn refused(r: JusoRefusal) -> RestError {
    match r {
        JusoRefusal::InvalidQuery(code) => RestError(Refusal::field("q", code)),
        JusoRefusal::RateLimited => RestError(
            Refusal::new(
                ErrorKind::Conflict,
                "rate_limited",
                "too many address searches; try again in a minute",
            )
            .with_remedy("retry_later"),
        ),
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct SearchQuery {
    #[serde(default)]
    q: String,
    page: Option<u32>,
}

pub(crate) async fn address_search(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Query(q): Query<SearchQuery>,
) -> Result<Response> {
    let (a, _) = actor(&s, &h, Need::Read, Target::Tenant).await?;
    let keyword = q.q.trim();
    if keyword.is_empty() {
        return Err(RestError(Refusal::field("q", "required")));
    }
    if keyword.chars().count() > 80 {
        return Err(RestError(Refusal::field("q", "too_long")));
    }
    let out = match &s.juso {
        None => AddressSearch {
            status: SearchStatus::Unavailable,
            items: vec![],
            total: 0,
        },
        Some(juso) => juso
            .search(*a.user.as_uuid(), keyword, q.page.unwrap_or(1))
            .await
            .map_err(refused)?,
    };
    Ok(Json(out).into_response())
}

/// The building a picked road address names (its juso codes), and the 동
/// whose 층·호 are wanted (absent: list the 동).
#[derive(Debug, Deserialize)]
pub(crate) struct DetailQuery {
    adm_cd: Option<String>,
    rn_mgt_sn: Option<String>,
    udrt_yn: Option<bool>,
    buld_mnnm: Option<u32>,
    buld_slno: Option<u32>,
    dong: Option<String>,
}

fn building(q: &DetailQuery) -> std::result::Result<Building, Refusal> {
    let mut is = Issues::default();
    let digits = |is: &mut Issues, field: &str, v: &Option<String>, len: usize| match v
        .as_deref()
        .map(str::trim)
    {
        Some(d) if d.len() == len && d.bytes().all(|b| b.is_ascii_digit()) => Some(d.to_owned()),
        Some(_) => {
            is.push(field, "invalid_option");
            None
        }
        None => {
            is.push(field, "required");
            None
        }
    };
    let adm_cd = digits(&mut is, "adm_cd", &q.adm_cd, 10);
    let rn_mgt_sn = digits(&mut is, "rn_mgt_sn", &q.rn_mgt_sn, 12);
    for (field, missing) in [
        ("udrt_yn", q.udrt_yn.is_none()),
        ("buld_mnnm", q.buld_mnnm.is_none()),
        ("buld_slno", q.buld_slno.is_none()),
    ] {
        if missing {
            is.push(field, "required");
        }
    }
    if q.dong.as_deref().is_some_and(|d| d.chars().count() > 50) {
        is.push("dong", "too_long");
    }
    is.finish_opt(|| {
        Some(Building {
            adm_cd: adm_cd?,
            rn_mgt_sn: rn_mgt_sn?,
            udrt_yn: q.udrt_yn?,
            buld_mnnm: q.buld_mnnm?,
            buld_slno: q.buld_slno?,
        })
    })
}

pub(crate) async fn address_detail(
    State(s): State<EntityRestState>,
    h: HeaderMap,
    Query(q): Query<DetailQuery>,
) -> Result<Response> {
    let (a, _) = actor(&s, &h, Need::Read, Target::Tenant).await?;
    let b = building(&q)?;
    let out = match &s.juso {
        None => AddressDetail {
            status: SearchStatus::Unavailable,
            items: vec![],
        },
        Some(juso) => juso
            .detail(*a.user.as_uuid(), &b, q.dong.as_deref())
            .await
            .map_err(refused)?,
    };
    Ok(Json(out).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_building_needs_every_juso_code() {
        let q = DetailQuery {
            adm_cd: Some("1171010700".into()),
            rn_mgt_sn: Some("117102005011".into()),
            udrt_yn: Some(false),
            buld_mnnm: Some(345),
            buld_slno: Some(0),
            dong: None,
        };
        assert_eq!(building(&q).unwrap().buld_mnnm, 345);
        let bad = DetailQuery {
            adm_cd: Some("11".into()),
            udrt_yn: None,
            ..q
        };
        let fields: Vec<_> = building(&bad)
            .unwrap_err()
            .fields
            .into_iter()
            .map(|f| (f.field, f.code))
            .collect();
        assert_eq!(
            fields,
            vec![
                ("adm_cd".to_owned(), "invalid_option"),
                ("udrt_yn".to_owned(), "required")
            ]
        );
    }
}
