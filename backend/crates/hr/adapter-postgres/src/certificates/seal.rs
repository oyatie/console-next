// SPDX-License-Identifier: LicenseRef-Proprietary
//! Inline PNG seals cannot load remote content or carry executable SVG.
use crate::HrError;
use base64::{Engine, engine::general_purpose::STANDARD};
pub(super) const MAX_BYTES: usize = 256 * 1024;
pub(super) fn validate(value: Option<&str>) -> Result<(), HrError> {
    let Some(value) = value else {
        return Ok(());
    };
    let bad = || super::invalid("seal must be a bounded PNG data URL");
    let encoded = value
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(bad)?;
    if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err(bad());
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| bad())?;
    if bytes.len() > MAX_BYTES
        || console_entity_domain::document::sniff(&bytes) != Some("image/png")
        || bytes.get(12..16) != Some(b"IHDR")
    {
        return Err(bad());
    }
    let dimension = |at| {
        bytes
            .get(at..at + 4)
            .and_then(|b| <[u8; 4]>::try_from(b).ok())
            .map(u32::from_be_bytes)
    };
    if !dimension(16).is_some_and(|n| (1..=2048).contains(&n))
        || !dimension(20).is_some_and(|n| (1..=2048).contains(&n))
    {
        return Err(bad());
    }
    Ok(())
}
pub(super) async fn store(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: uuid::Uuid,
    png: Option<&str>,
) -> Result<Option<uuid::Uuid>, HrError> {
    use sha2::{Digest, Sha256};
    let Some(png) = png else {
        return Ok(None);
    };
    let digest = Sha256::digest(png.as_bytes()).to_vec();
    sqlx::query("INSERT INTO hr_certificate_seals(org_id,sha256,png) VALUES($1,$2,$3) ON CONFLICT(org_id,sha256) DO NOTHING")
        .bind(org).bind(&digest).bind(png).execute(tx.as_mut()).await?;
    Ok(Some(
        sqlx::query_scalar("SELECT id FROM hr_certificate_seals WHERE org_id=$1 AND sha256=$2")
            .bind(org)
            .bind(digest)
            .fetch_one(tx.as_mut())
            .await?,
    ))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn remote_svg_corrupt_and_oversized_seals_are_refused() {
        assert!(validate(None).is_ok());
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHt8AAAAASUVORK5CYII=";
        assert!(validate(Some(png)).is_ok());
        for bad in [
            "https://example.invalid/seal.png".to_owned(),
            "data:image/svg+xml;base64,PHN2Zz4=".into(),
            "data:image/png;base64,eA==".into(),
            format!("data:image/png;base64,{}", "A".repeat(MAX_BYTES * 2)),
        ] {
            assert_eq!(
                validate(Some(&bad)).unwrap_err().code,
                "certificate_invalid"
            );
        }
    }
}
