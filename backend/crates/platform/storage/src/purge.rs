// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{SeaweedS3Storage, StorageError, s3_response_error};
use reqwest::Method;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Version {
    key: String,
    version_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Versions {
    prefix: String,
    is_truncated: bool,
    #[serde(default)]
    version: Vec<Version>,
    #[serde(default)]
    delete_marker: Vec<Version>,
}

impl SeaweedS3Storage {
    pub(super) async fn purge_key(&self, bucket: &str, key: &str) -> Result<(), StorageError> {
        if key.is_empty() {
            return Err(StorageError::S3("empty purge key".into()));
        }
        // An unversioned bucket has no version inventory. A suspended bucket can
        // still contain every version accumulated before suspension.
        let response = self
            .s3_empty(
                Method::GET,
                self.bucket_subresource_url(bucket, "versioning")?,
            )
            .await?;
        if !response.status().is_success() {
            return Err(s3_response_error("read bucket versioning", response).await);
        }
        let body = response.text().await.map_err(super::reqwest_error)?;
        if !bucket_versioning(&body)? {
            return match self.delete_object(bucket, key).await {
                Err(StorageError::Response {
                    status: 404, code, ..
                }) if code == "NoSuchKey" => Ok(()),
                result => result,
            };
        }
        let mut previous = Vec::new();
        loop {
            let mut url = self.bucket_subresource_url(bucket, "versions")?;
            url.query_pairs_mut()
                .append_pair("prefix", key)
                .append_pair("max-keys", "100");
            let response = self.s3_empty(Method::GET, url).await?;
            if !response.status().is_success() {
                return Err(s3_response_error("list object versions", response).await);
            }
            let body = response.text().await.map_err(super::reqwest_error)?;
            let page: Versions = quick_xml::de::from_str(&body)
                .map_err(|_| StorageError::S3("invalid version listing".into()))?;
            let ids = page.exact_versions(key)?;
            if ids.is_empty() {
                return Ok(());
            }
            if ids == previous {
                return Err(StorageError::S3(
                    "version listing did not advance after delete".into(),
                ));
            }
            previous = ids;
            for id in &previous {
                match self.delete_object_version(bucket, key, id).await {
                    Err(StorageError::Response {
                        status: 404, code, ..
                    }) if matches!(code.as_str(), "NoSuchKey" | "NoSuchVersion") => {}
                    Err(err @ StorageError::Response { status: 403, .. }) => {
                        if let Ok(head) = self.head_object_version(bucket, key, id).await
                            && matches!(
                                head.object_lock_mode.as_deref(),
                                Some("COMPLIANCE" | "GOVERNANCE")
                            )
                            && head
                                .retain_until
                                .as_deref()
                                .and_then(|value| {
                                    time::OffsetDateTime::parse(
                                        value,
                                        &time::format_description::well_known::Rfc3339,
                                    )
                                    .ok()
                                })
                                .is_some_and(|deadline| deadline > time::OffsetDateTime::now_utc())
                        {
                            return Err(StorageError::Retained);
                        }
                        return Err(err);
                    }
                    result => result?,
                }
            }
            // Re-read from the start. The removed entries no longer occupy page one.
        }
    }
}

fn bucket_versioning(xml: &str) -> Result<bool, StorageError> {
    use quick_xml::{Reader, events::Event};
    #[derive(Deserialize)]
    struct Configuration {
        #[serde(rename = "Status")]
        status: Option<String>,
    }
    let invalid = || StorageError::S3("invalid bucket versioning response".into());
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    loop {
        match reader.read_event().map_err(|_| invalid())? {
            Event::Start(tag) | Event::Empty(tag)
                if tag.local_name().as_ref() == b"VersioningConfiguration" =>
            {
                break;
            }
            Event::Decl(_) | Event::Comment(_) => continue,
            _ => return Err(invalid()),
        }
    }
    let config: Configuration = quick_xml::de::from_str(xml).map_err(|_| invalid())?;
    match config.status.as_deref() {
        None => Ok(false),
        Some("Enabled" | "Suspended") => Ok(true),
        _ => Err(invalid()),
    }
}

impl Versions {
    fn exact_versions(self, key: &str) -> Result<Vec<String>, StorageError> {
        if self.prefix != key
            || (self.is_truncated && self.version.is_empty() && self.delete_marker.is_empty())
        {
            return Err(StorageError::S3(
                "inconsistent object version listing".into(),
            ));
        }
        // ListObjectVersions orders keys lexically. Longer prefix matches sort after the exact key.
        self.version
            .into_iter()
            .chain(self.delete_marker)
            .filter(|version| version.key == key)
            .map(|version| {
                if version.version_id.is_empty() {
                    Err(StorageError::S3("missing version ID".into()))
                } else {
                    Ok(version.version_id)
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_unknown_versioning_and_preserves_suspended_history() {
        assert!(!bucket_versioning("<VersioningConfiguration/>").unwrap());
        assert!(
            bucket_versioning(
                "<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>"
            )
            .unwrap()
        );
        assert!(bucket_versioning("<Error/>").is_err());
    }

    #[test]
    fn removes_exact_versions_and_markers_without_touching_neighbor_keys() {
        let xml = "<ListVersionsResult><Prefix>a&amp;b</Prefix><IsTruncated>true</IsTruncated><DeleteMarker><Key>a&amp;b</Key><VersionId>d</VersionId></DeleteMarker><Version><Key>a&amp;b</Key><VersionId>null</VersionId></Version><Version><Key>a&amp;bb</Key><VersionId>keep</VersionId></Version></ListVersionsResult>";
        let page: Versions = quick_xml::de::from_str(xml).unwrap();
        assert_eq!(page.exact_versions("a&b").unwrap(), ["null", "d"]);
    }
}
