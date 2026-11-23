// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{
    CopyObjectRequest, HeaderMap, HeaderName, HeaderValue, Method, Rfc3339, SeaweedS3Storage,
    StorageError, Timestamp, ensure_success, header_string, header_value, s3_response_error, sigv4,
};

impl SeaweedS3Storage {
    pub async fn put_compliance_retention(
        &self,
        bucket: &str,
        key: &str,
        retain_until: Timestamp,
    ) -> Result<(), StorageError> {
        self.put_retention_at(
            self.object_subresource_url(bucket, key, "retention")?,
            retain_until,
        )
        .await
    }

    async fn put_retention_at(
        &self,
        url: url::Url,
        retain_until: Timestamp,
    ) -> Result<(), StorageError> {
        let retain_until = retain_until
            .format(&Rfc3339)
            .map_err(|err| StorageError::S3(format!("invalid retain-until timestamp: {err}")))?;
        let response = self
            .s3(
                Method::PUT,
                url,
                sigv4::content_type("application/xml")?,
                format!("<Retention><Mode>COMPLIANCE</Mode><RetainUntilDate>{retain_until}</RetainUntilDate></Retention>").into(),
            )
            .await?;
        ensure_success("put object retention", response).await
    }

    pub(super) async fn copy_replica(
        &self,
        request: CopyObjectRequest,
    ) -> Result<(), StorageError> {
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("x-amz-copy-source"),
            header_value(&format!(
                "/{}/{}",
                request.source_bucket, request.source_key
            ))?,
        );
        if let Some(retain_until) = request.retain_until {
            headers.insert(
                HeaderName::from_static("x-amz-object-lock-mode"),
                HeaderValue::from_static("COMPLIANCE"),
            );
            headers.insert(
                HeaderName::from_static("x-amz-object-lock-retain-until-date"),
                header_value(&retain_until.format(&Rfc3339).map_err(|err| {
                    StorageError::S3(format!("invalid retain-until timestamp: {err}"))
                })?)?,
            );
        }
        let mut url = self.object_url(&request.destination_bucket, &request.destination_key)?;
        let response = self
            .s3(Method::PUT, url.clone(), headers, Vec::new())
            .await?;
        if !response.status().is_success() {
            return Err(s3_response_error("copy object", response).await);
        }
        if let Some(retain_until) = request.retain_until {
            // Bind retention to this copy even if another attempt writes the same key.
            let version = header_string(response.headers(), "x-amz-version-id")
                .filter(|id| !id.is_empty() && id != "null")
                .ok_or_else(|| StorageError::S3("retained copy has no version ID".into()))?;
            url.query_pairs_mut()
                .append_pair("retention", "")
                .append_pair("versionId", &version);
            self.put_retention_at(url, retain_until).await?;
        }
        Ok(())
    }
}
