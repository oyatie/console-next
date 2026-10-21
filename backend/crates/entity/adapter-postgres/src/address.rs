//! `entity_addresses`: immutable structured address rows.

use std::collections::HashMap;

use console_entity_domain::KrAddress;
use console_entity_domain::codes::AddressSource;
use sqlx::Row;
use uuid::Uuid;

use crate::{PgEntityError, Tx};

macro_rules! columns {
    () => {
        "source, road_addr_part1, road_addr_part2, jibun_addr, eng_addr, zip_no, adm_cd, rn_mgt_sn, \
         bd_mgt_sn, si_nm, sgg_nm, emd_nm, li_nm, bd_nm, udrt_yn, buld_mnnm, buld_slno, mt_yn, \
         lnbr_mnnm, lnbr_slno, detail, as_printed"
    };
}

pub(crate) async fn insert_address(tx: &mut Tx<'_>, a: &KrAddress) -> Result<Uuid, PgEntityError> {
    let sql = concat!(
        "INSERT INTO entity_addresses (org_id, ",
        columns!(),
        ") VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, \
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id"
    );
    Ok(sqlx::query_scalar(sql)
        .bind(a.source.as_str())
        .bind(&a.road_addr_part1)
        .bind(&a.road_addr_part2)
        .bind(&a.jibun_addr)
        .bind(&a.eng_addr)
        .bind(&a.zip_no)
        .bind(&a.adm_cd)
        .bind(&a.rn_mgt_sn)
        .bind(&a.bd_mgt_sn)
        .bind(&a.si_nm)
        .bind(&a.sgg_nm)
        .bind(&a.emd_nm)
        .bind(&a.li_nm)
        .bind(&a.bd_nm)
        .bind(a.udrt_yn)
        .bind(a.buld_mnnm)
        .bind(a.buld_slno)
        .bind(a.mt_yn)
        .bind(a.lnbr_mnnm)
        .bind(a.lnbr_slno)
        .bind(&a.detail)
        .bind(&a.as_printed)
        .fetch_one(tx.as_mut())
        .await?)
}

pub(crate) async fn insert_optional(
    tx: &mut Tx<'_>,
    a: Option<&KrAddress>,
) -> Result<Option<Uuid>, PgEntityError> {
    match a {
        Some(a) => Ok(Some(insert_address(tx, a).await?)),
        None => Ok(None),
    }
}

/// Load every address in `ids` (missing ids are simply absent).
pub(crate) async fn load_addresses(
    tx: &mut Tx<'_>,
    ids: &[Uuid],
) -> Result<HashMap<Uuid, KrAddress>, PgEntityError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let sql = concat!(
        "SELECT id, ",
        columns!(),
        " FROM entity_addresses WHERE id = ANY($1)"
    );
    let rows = sqlx::query(sql).bind(ids).fetch_all(tx.as_mut()).await?;
    rows.iter()
        .map(|r| {
            let source: String = r.try_get("source")?;
            Ok((
                r.try_get("id")?,
                KrAddress {
                    source: AddressSource::parse(&source)
                        .unwrap_or(AddressSource::ManualUnverified),
                    road_addr_part1: r.try_get("road_addr_part1")?,
                    road_addr_part2: r.try_get("road_addr_part2")?,
                    jibun_addr: r.try_get("jibun_addr")?,
                    eng_addr: r.try_get("eng_addr")?,
                    zip_no: r.try_get("zip_no")?,
                    adm_cd: r.try_get("adm_cd")?,
                    rn_mgt_sn: r.try_get("rn_mgt_sn")?,
                    bd_mgt_sn: r.try_get("bd_mgt_sn")?,
                    si_nm: r.try_get("si_nm")?,
                    sgg_nm: r.try_get("sgg_nm")?,
                    emd_nm: r.try_get("emd_nm")?,
                    li_nm: r.try_get("li_nm")?,
                    bd_nm: r.try_get("bd_nm")?,
                    udrt_yn: r.try_get("udrt_yn")?,
                    buld_mnnm: r.try_get("buld_mnnm")?,
                    buld_slno: r.try_get("buld_slno")?,
                    mt_yn: r.try_get("mt_yn")?,
                    lnbr_mnnm: r.try_get("lnbr_mnnm")?,
                    lnbr_slno: r.try_get("lnbr_slno")?,
                    detail: r.try_get("detail")?,
                    as_printed: r.try_get("as_printed")?,
                },
            ))
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(PgEntityError::from)
}
