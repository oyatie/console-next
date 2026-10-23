//! Official reference lists as bundled, versioned data (entity design §4;
//! lane corrections #10). A list is a file imported from a cited official
//! source, never typed by hand and never seeded into a tenant. A record that
//! uses a code stores `{code, label, list_key, version}`, so a later version
//! of the list never rewrites a stored label.
//!
//! A list whose source is unverified is `NOT_LOADED`; one waiting on a
//! licence answer is `HOLD`. Either way it is served (empty), so the form
//! falls back to the printed text and never dead-ends.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::sync::LazyLock;

use serde::Serialize;
pub mod brn;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ListStatus {
    Loaded,
    /// No verified machine-readable official source yet.
    NotLoaded,
    /// A source exists but its licence is an open owner question (O-5).
    Hold,
}

/// Where a loaded list came from: enough to re-download and re-verify it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Source {
    pub title: &'static str,
    pub url: &'static str,
    pub retrieved_on: &'static str,
    /// SHA-256 of the official data file as published (inside the download
    /// archive, before derivation).
    pub sha256: &'static str,
    /// How the bundled file was derived from it.
    pub derivation: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ListInfo {
    pub key: &'static str,
    /// The source's own title (data, as published), or `None` while not loaded.
    pub title: Option<&'static str>,
    pub version: Option<&'static str>,
    pub status: ListStatus,
    pub source: Option<Source>,
    /// Why a list is not loaded (a code for the catalogs).
    pub reason: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Code {
    pub code: &'static str,
    pub label: &'static str,
    pub parent_label: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation_url: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abstract_workplace: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub biz_kinds: Option<Vec<&'static str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_office: Option<bool>,
}

const ADMIN_REGION_TSV: &str = include_str!("../data/admin_region-2026-10-01.tsv");
pub const WORKPLACE_NOT_REGISTERED_REASON_KEY: &str = "workplace_not_registered_reason";
const WORKPLACE_NOT_REGISTERED_REASON_TSV: &str =
    include_str!("../data/workplace-not-registered-reason-2026-10-22.tsv");

const fn empty(key: &'static str, status: ListStatus, reason: &'static str) -> ListInfo {
    ListInfo {
        key,
        title: None,
        version: None,
        status,
        source: None,
        reason: Some(reason),
    }
}

/// Every list the product names, in display order.
pub const LISTS: &[ListInfo] = &[
    ListInfo {
        key: "brn_classification",
        title: Some("사업자등록번호 부여체계"),
        version: Some("2026-10-13"),
        status: ListStatus::Loaded,
        source: Some(Source {
            title: "국세청 사업자등록번호 부여체계 (2020-11-11)",
            url: "https://www.nts.go.kr/nts/na/ntt/selectNttInfo.do?mi=2448&nttSn=1386",
            retrieved_on: "2026-10-13",
            sha256: "d6a5b7e773d590360cc2d2216cbf1588156feb3fbad8459cf55a1fe9297aef92",
            derivation: "published middle-code ranges transcribed; kinds mapped to the entity model; 82 and 84 do not distinguish head and branch",
        }),
        reason: None,
    },
    ListInfo {
        key: "admin_region",
        title: Some("법정동코드 전체자료 (시도·시군구)"),
        version: Some("2026-10-01"),
        status: ListStatus::Loaded,
        source: Some(Source {
            title: "행정표준코드관리시스템 법정동코드 전체자료 (행정안전부)",
            url: "https://www.code.go.kr/stdcode/regCodeL.do",
            retrieved_on: "2026-10-05",
            sha256: "962fd4cdfb6ccf2887b745eb97db55f71112b9f9a32c1f8fbd7692fb069b1df0",
            derivation: "rows marked 존재 at 시도 level (NN00000000, or a 시도 with no 시군구 such as 세종) and 시군구 level (NNNNN00000); the label drops the 시도 prefix, which becomes parent_label",
        }),
        reason: None,
    },
    ListInfo {
        key: WORKPLACE_NOT_REGISTERED_REASON_KEY,
        title: Some("사업자등록 미대상 사유"),
        version: Some("2026-10-22"),
        status: ListStatus::Loaded,
        source: Some(Source {
            title: "부가가치세법 제6조(납세지)",
            url: "https://law.go.kr/LSW/lsLinkCommonInfo.do?lsJoLnkSeq=1032154331",
            retrieved_on: "2026-10-22",
            sha256: "3ce3ff3ee06a4f9b189ebd538f12f1902c50cb92d1f7b878bcccd5da7402098f",
            derivation: "제6조제5항제1호·제2호와 고정된 장소를 사업장으로 정한 제6조제2항을 코드화; 각 행의 citation_url은 해당 조문",
        }),
        reason: None,
    },
    // 국세청 업종코드 (고시 2026-14) is published as images only (design §4).
    empty(
        "nts_industry_code",
        ListStatus::NotLoaded,
        "no_machine_readable_source",
    ),
    // 세무서 codes: no verified official file (design §4).
    empty("tax_office", ListStatus::NotLoaded, "no_verified_source"),
    // 공단 지사 codes: no verified official file (design §4).
    empty(
        "insurance_branch",
        ListStatus::NotLoaded,
        "no_verified_source",
    ),
    // KSIC (국가데이터처 고시 2024-203): licence asked of 국가데이터처 (O-5).
    empty("ksic", ListStatus::Hold, "licence_pending"),
    // Bank codes: licence asked of 금융결제원 (O-5).
    empty("bank", ListStatus::Hold, "licence_pending"),
];

static ADMIN_REGION: LazyLock<Vec<Code>> = LazyLock::new(|| parse_tsv(ADMIN_REGION_TSV));
static WORKPLACE_NOT_REGISTERED_REASON: LazyLock<Vec<Code>> =
    LazyLock::new(|| parse_workplace_reason_tsv(WORKPLACE_NOT_REGISTERED_REASON_TSV));

fn parse_tsv(raw: &'static str) -> Vec<Code> {
    raw.lines()
        .filter(|l| !l.is_empty())
        .filter_map(|l| {
            let mut cols = l.split('\t');
            let code = cols.next()?;
            let label = cols.next()?;
            let parent = cols.next().filter(|p| !p.is_empty());
            Some(Code {
                code,
                label,
                parent_label: parent,
                citation_url: None,
                abstract_workplace: None,
                biz_kinds: None,
                head_office: None,
            })
        })
        .collect()
}

fn parse_workplace_reason_tsv(raw: &'static str) -> Vec<Code> {
    raw.lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let mut columns = line.split('\t');
            Some(Code {
                code: columns.next()?,
                label: columns.next()?,
                parent_label: None,
                citation_url: columns.next(),
                abstract_workplace: columns.next().and_then(|value| value.parse().ok()),
                biz_kinds: None,
                head_office: None,
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    UnknownList,
    Unavailable,
    RetiredVersion,
    UnknownCode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCode {
    pub list: ListInfo,
    pub code: Code,
}

/// Resolve an input code against the one loaded version. A caller may omit
/// the version for an N-1 client; a supplied stale version is never restamped.
pub fn resolve(key: &str, code: &str, version: Option<&str>) -> Result<ResolvedCode, ResolveError> {
    let list = info(key).ok_or(ResolveError::UnknownList)?;
    if list.status != ListStatus::Loaded {
        return Err(ResolveError::Unavailable);
    }
    if version.is_some_and(|version| Some(version) != list.version) {
        return Err(ResolveError::RetiredVersion);
    }
    let code = codes(key)
        .iter()
        .find(|candidate| candidate.code == code)
        .cloned()
        .ok_or(ResolveError::UnknownCode)?;
    Ok(ResolvedCode { list, code })
}

fn codes(key: &str) -> &'static [Code] {
    match key {
        "admin_region" => &ADMIN_REGION,
        "brn_classification" => &brn::CODES,
        WORKPLACE_NOT_REGISTERED_REASON_KEY => &WORKPLACE_NOT_REGISTERED_REASON,
        _ => &[],
    }
}

/// The list's state, or `None` for a key the product does not name.
#[must_use]
pub fn info(key: &str) -> Option<ListInfo> {
    LISTS.iter().find(|l| l.key == key).copied()
}

/// Codes of `key` matching `q`: every whitespace-separated word of `q` must
/// appear in the code, the label or the parent label. At most `limit`, in list
/// order. `None` for an unknown key.
#[must_use]
pub fn search(key: &str, q: &str, limit: usize) -> Option<(ListInfo, Vec<Code>)> {
    let list = info(key)?;
    let words: Vec<&str> = q.split_whitespace().collect();
    let hits = codes(key)
        .iter()
        .filter(|c| {
            words.iter().all(|w| {
                c.code.starts_with(w)
                    || c.label.contains(w)
                    || c.parent_label.is_some_and(|p| p.contains(w))
            })
        })
        .take(limit)
        .cloned()
        .collect();
    Some((list, hits))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_region_is_loaded_with_sido_and_sigungu() {
        let (list, all) = search("admin_region", "", usize::MAX).unwrap();
        assert_eq!(list.status, ListStatus::Loaded);
        assert!(all.len() > 250, "{}", all.len());
        let seoul = all.iter().find(|c| c.code == "1100000000").unwrap();
        assert_eq!((seoul.label, seoul.parent_label), ("서울특별시", None));
        let (_, hits) = search("admin_region", "경기 분당", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].label, "성남시 분당구");
        assert_eq!(hits[0].parent_label, Some("경기도"));
        // 세종 has no 시군구: it is a 시도-level row of its own.
        let (_, sejong) = search("admin_region", "세종", 10).unwrap();
        assert_eq!(sejong.len(), 1);
        assert_eq!(sejong[0].parent_label, None);
        // Every code is ten digits and unique.
        let mut seen = std::collections::HashSet::new();
        for c in &all {
            assert!(c.code.len() == 10 && c.code.bytes().all(|b| b.is_ascii_digit()));
            assert!(seen.insert(c.code));
        }
    }

    #[test]
    fn unverified_and_licence_held_lists_are_served_empty() {
        for key in [
            "tax_office",
            "nts_industry_code",
            "insurance_branch",
            "ksic",
            "bank",
        ] {
            let (list, hits) = search(key, "", 50).unwrap();
            assert_ne!(list.status, ListStatus::Loaded, "{key}");
            assert!(hits.is_empty() && list.version.is_none() && list.reason.is_some());
        }
        assert!(search("nope", "", 50).is_none());
    }

    #[test]
    fn wire_shape_uses_screaming_status() {
        let v = serde_json::to_value(info("ksic").unwrap()).unwrap();
        assert_eq!(v["status"], "HOLD");
        assert_eq!(v["key"], "ksic");
    }

    #[test]
    fn workplace_not_registered_reason_is_loaded_and_searchable() {
        let (list, all) = search("workplace_not_registered_reason", "", usize::MAX).unwrap();
        assert_eq!(list.status, ListStatus::Loaded);
        assert_eq!(list.version, Some("2026-10-22"));
        assert_eq!(all.len(), 3, "only reasons supported by VAT Act article 6");
        let depot = all.iter().find(|c| c.code == "VAT_DEPOT").unwrap();
        assert_eq!(depot.label, "하치장");
        assert_eq!(depot.parent_label, None);
        assert_eq!(depot.abstract_workplace, Some(false));
        assert!(
            depot
                .citation_url
                .unwrap()
                .starts_with("https://www.law.go.kr/")
        );
        let remote = all.iter().find(|c| c.code == "REMOTE_TELEWORK").unwrap();
        assert_eq!(remote.abstract_workplace, Some(true));
        let source = list.source.unwrap();
        assert_eq!(
            source.sha256,
            "3ce3ff3ee06a4f9b189ebd538f12f1902c50cb92d1f7b878bcccd5da7402098f"
        );
        assert_ne!(
            source.sha256, "2d2b3b98d40e3ab3c1ab96a8e8b78afcc813e7cb3e54733c8cab24b59b647ba8",
            "the source hash is the retrieved official page, not the derived TSV"
        );

        let current = resolve(
            "workplace_not_registered_reason",
            "VAT_DEPOT",
            Some("2026-10-22"),
        )
        .unwrap();
        assert_eq!(
            (current.list.key, current.code.label),
            ("workplace_not_registered_reason", "하치장")
        );
        assert_eq!(
            resolve(
                "workplace_not_registered_reason",
                "VAT_DEPOT",
                Some("2026-10-21")
            ),
            Err(ResolveError::RetiredVersion),
        );
        assert_eq!(
            resolve(
                "workplace_not_registered_reason",
                "DISPATCH_CLIENT_SITE",
                Some("2026-10-22")
            ),
            Err(ResolveError::UnknownCode),
        );
    }
}
