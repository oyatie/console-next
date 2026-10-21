//! juso.go.kr responses → wire shapes. Pure; tested on recorded responses.
//!
//! Formats and error codes were read from the official guide pages
//! (business.juso.go.kr 「도로명주소 검색 API」 and 「상세주소 검색 API」,
//! 2026-10-05) and checked against live responses the same day:
//! every field arrives as a JSON string; `countPerPage` is capped at 100;
//! the 상세주소 API answers only GET query parameters.

use console_entity_domain::KrAddress;
use console_entity_domain::codes::AddressSource;
use serde::Serialize;
use serde_json::Value;

/// What one juso answer means for the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Answer<T> {
    Ok {
        items: Vec<T>,
        total: u64,
    },
    /// 「주소를 상세히」(E0006) or 「검색 범위 초과」(E0015).
    TooBroad,
    /// The keyword itself is refused; the code names why (field `q`).
    InvalidQuery(&'static str),
    /// E0001 (not approved) or E0014 (development key expired).
    KeyRejected,
    /// -999, an unknown code, or a body we cannot read.
    Failed,
}

/// One 상세주소 option. A building may have 동 only, 층·호 only, or all three.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DetailOption {
    pub dong: Option<String>,
    pub floor: Option<String>,
    pub ho: Option<String>,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn number(v: &Value, key: &str) -> Option<i32> {
    text(v, key).and_then(|s| s.parse().ok())
}

fn flag(v: &Value, key: &str) -> Option<bool> {
    text(v, key).map(|s| s == "1")
}

fn common(body: &Value) -> Option<(&str, u64, &Value)> {
    let results = body.get("results")?;
    let common = results.get("common")?;
    let code = common.get("errorCode")?.as_str()?;
    let total = common
        .get("totalCount")
        .and_then(Value::as_str)
        .and_then(|t| t.parse().ok())
        .unwrap_or(0);
    Some((code, total, results.get("juso").unwrap_or(&Value::Null)))
}

/// One road-address hit as a full `KrAddress` (codes included, no 상세주소 yet).
fn address(j: &Value) -> Option<KrAddress> {
    Some(KrAddress {
        source: AddressSource::Juso,
        road_addr_part1: text(j, "roadAddrPart1")?,
        road_addr_part2: text(j, "roadAddrPart2"),
        jibun_addr: text(j, "jibunAddr"),
        eng_addr: text(j, "engAddr"),
        zip_no: text(j, "zipNo"),
        adm_cd: text(j, "admCd"),
        rn_mgt_sn: text(j, "rnMgtSn"),
        bd_mgt_sn: text(j, "bdMgtSn"),
        si_nm: text(j, "siNm")?,
        sgg_nm: text(j, "sggNm"),
        emd_nm: text(j, "emdNm"),
        li_nm: text(j, "liNm"),
        bd_nm: text(j, "bdNm"),
        udrt_yn: flag(j, "udrtYn"),
        buld_mnnm: number(j, "buldMnnm"),
        buld_slno: number(j, "buldSlno"),
        mt_yn: flag(j, "mtYn"),
        lnbr_mnnm: number(j, "lnbrMnnm"),
        lnbr_slno: number(j, "lnbrSlno"),
        detail: None,
        as_printed: None,
    })
}

/// 도로명주소 검색 API (`addrLinkApi.do`).
pub(crate) fn road(body: &str) -> Answer<KrAddress> {
    let Ok(body) = serde_json::from_str::<Value>(body) else {
        return Answer::Failed;
    };
    let Some((code, total, juso)) = common(&body) else {
        return Answer::Failed;
    };
    match code {
        "0" => Answer::Ok {
            items: juso
                .as_array()
                .map(|a| a.iter().filter_map(address).collect())
                .unwrap_or_default(),
            total,
        },
        "E0001" | "E0014" => Answer::KeyRejected,
        "E0006" | "E0015" => Answer::TooBroad,
        "E0005" => Answer::InvalidQuery("required"),
        "E0008" => Answer::InvalidQuery("too_short"),
        "E0009" | "E0012" => Answer::InvalidQuery("needs_text"),
        "E0010" | "E0011" => Answer::InvalidQuery("too_long"),
        "E0013" => Answer::InvalidQuery("forbidden_characters"),
        _ => Answer::Failed,
    }
}

/// 상세주소 검색 API (`addrDetailApi.do`). Its E0002–E0006 mean a building
/// identifier was missing: our request was wrong, so they are failures.
pub(crate) fn detail(body: &str) -> Answer<DetailOption> {
    let Ok(body) = serde_json::from_str::<Value>(body) else {
        return Answer::Failed;
    };
    let Some((code, total, juso)) = common(&body) else {
        return Answer::Failed;
    };
    match code {
        "0" => Answer::Ok {
            items: juso
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|j| DetailOption {
                            dong: text(j, "dongNm"),
                            floor: text(j, "floorNm"),
                            ho: text(j, "hoNm"),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            total,
        },
        "E0001" | "E0014" => Answer::KeyRejected,
        _ => Answer::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROAD_OK: &str = include_str!("../tests/fixtures/road_ok.json");
    const ROAD_E0001: &str = include_str!("../tests/fixtures/road_e0001.json");
    const ROAD_E0006: &str = include_str!("../tests/fixtures/road_e0006.json");
    const ROAD_E0008: &str = include_str!("../tests/fixtures/road_e0008.json");
    const DONG: &str = include_str!("../tests/fixtures/detail_dong.json");
    const FLOORHO: &str = include_str!("../tests/fixtures/detail_floorho.json");
    const EMPTY: &str = include_str!("../tests/fixtures/detail_empty.json");

    #[test]
    fn a_road_hit_maps_to_a_full_juso_address() {
        let Answer::Ok { items, total } = road(ROAD_OK) else {
            panic!("expected Ok");
        };
        assert_eq!(total, 1);
        let a = &items[0];
        assert_eq!(a.source, AddressSource::Juso);
        assert_eq!(a.road_addr_part1, "경기도 성남시 분당구 판교역로 166");
        assert_eq!(a.road_addr_part2.as_deref(), Some("(백현동)"));
        assert_eq!(a.zip_no.as_deref(), Some("13529"));
        assert_eq!(a.adm_cd.as_deref(), Some("4113511000"));
        assert_eq!(a.rn_mgt_sn.as_deref(), Some("411353179025"));
        assert_eq!(a.bd_mgt_sn.as_deref(), Some("4113511000105320000000002"));
        assert_eq!(a.sgg_nm.as_deref(), Some("성남시 분당구"));
        assert_eq!(a.li_nm, None);
        assert_eq!(
            (a.udrt_yn, a.buld_mnnm, a.buld_slno),
            (Some(false), Some(166), Some(0))
        );
        assert_eq!(
            (a.mt_yn, a.lnbr_mnnm, a.lnbr_slno),
            (Some(false), Some(532), Some(0))
        );
        assert_eq!(a.detail, None);
        // The hit passes the domain's own validation for a JUSO address.
        let input = serde_json::from_value(serde_json::to_value(a).unwrap()).unwrap();
        let mut issues = console_entity_domain::Issues::default();
        assert!(
            console_entity_domain::address::validate_address(&mut issues, "a", &input).is_some()
        );
    }

    #[test]
    fn juso_codes_map_to_outcomes() {
        assert_eq!(road(ROAD_E0001), Answer::KeyRejected);
        assert_eq!(road(ROAD_E0006), Answer::TooBroad);
        assert_eq!(road(ROAD_E0008), Answer::InvalidQuery("too_short"));
        assert_eq!(road("<html>"), Answer::Failed);
        assert_eq!(
            road(&ROAD_E0001.replace("E0001", "E0014")),
            Answer::KeyRejected
        );
        assert_eq!(road(&ROAD_E0001.replace("E0001", "-999")), Answer::Failed);
    }

    #[test]
    fn detail_lists_dong_then_floor_and_ho() {
        let Answer::Ok { items, total } = detail(DONG) else {
            panic!("expected Ok");
        };
        assert_eq!(total, 93);
        assert_eq!(
            items[0],
            DetailOption {
                dong: Some("101동".into()),
                floor: None,
                ho: None
            }
        );
        let Answer::Ok { items, .. } = detail(FLOORHO) else {
            panic!("expected Ok");
        };
        assert_eq!(
            items[0],
            DetailOption {
                dong: Some("101동".into()),
                floor: Some("1층".into()),
                ho: Some("101호".into())
            }
        );
        assert_eq!(
            detail(EMPTY),
            Answer::Ok {
                items: vec![],
                total: 0
            }
        );
        assert_eq!(detail(&EMPTY.replace("\"0\"", "\"E0002\"")), Answer::Failed);
        assert_eq!(
            detail(&EMPTY.replace("\"0\"", "\"E0001\"")),
            Answer::KeyRejected
        );
    }
}
