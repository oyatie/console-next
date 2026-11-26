// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

impl<S: S3ObjectStore> EvidenceService<S> {
    pub async fn replicate_once(
        &self,
        media_id: EvidenceId,
        trace: TraceContext,
        occurred_at: Timestamp,
    ) -> Result<ReplicationOutcome, StorageError> {
        self.replicate(media_id, trace, occurred_at, false).await
    }

    pub async fn retry_due_replicas(&self, org: OrgId) -> Result<(), StorageError> {
        let ids = with_org_conn::<_, Vec<uuid::Uuid>, StorageError>(&self.pool, org, |tx| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    "SELECT id FROM evidence_media WHERE upload_confirmed_at IS NOT NULL
                AND worm_replica_status = 'PENDING' AND next_retry_at <= clock_timestamp()
                AND (replica_lease_until IS NULL OR replica_lease_until <= clock_timestamp())
                ORDER BY next_retry_at, id LIMIT 16",
                )
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await?;
        for id in ids {
            self.replicate(
                EvidenceId::from_uuid(id),
                TraceContext::generate(),
                Timestamp::now_utc(),
                true,
            )
            .await?;
        }
        Ok(())
    }

    async fn replicate(
        &self,
        media_id: EvidenceId,
        trace: TraceContext,
        occurred_at: Timestamp,
        due_only: bool,
    ) -> Result<ReplicationOutcome, StorageError> {
        let org = current_org().map_err(KernelError::from)?;
        let lease = with_org_conn::<_, Option<Timestamp>, StorageError>(&self.pool, org, move |tx| Box::pin(async move {
            Ok(sqlx::query_scalar("UPDATE evidence_media SET replica_lease_until = clock_timestamp() + interval '5 minutes'
                WHERE id = $1 AND worm_replica_status <> 'VERIFIED'
                  AND (NOT $2 OR (worm_replica_status = 'PENDING' AND next_retry_at <= clock_timestamp() AND upload_confirmed_at IS NOT NULL))
                  AND (replica_lease_until IS NULL OR replica_lease_until <= clock_timestamp())
                RETURNING replica_lease_until").bind(media_id.as_uuid()).bind(due_only).fetch_optional(tx.as_mut()).await?)
        })).await?;
        let media = evidence_media_by_id(&self.pool, media_id).await?;
        let Some(lease) = lease else {
            return Ok(ReplicationOutcome {
                media_id,
                status: media.worm_replica_status,
                retry_count: media.retry_count,
            });
        };

        let result = self
            .copy_and_verify_replica(&media, occurred_at)
            .await
            .map(|()| WormReplicaStatus::Verified);
        match result {
            Ok(status) => self
                .record_replication_success(media, trace, occurred_at, lease)
                .await
                .map(|media| ReplicationOutcome {
                    media_id,
                    status,
                    retry_count: media.retry_count,
                }),
            Err(err) => {
                let message = err.to_string();
                tracing::error!(
                    media_id = %media_id,
                    work_order_id = %media.work_order_id,
                    retry_count = media.retry_count + 1,
                    error = %message,
                    "evidence WORM replication attempt failed"
                );
                self.record_replication_failure(media, message, trace, occurred_at, lease)
                    .await
            }
        }
    }

    async fn copy_and_verify_replica(
        &self,
        media: &EvidenceMedia,
        now: Timestamp,
    ) -> Result<(), StorageError> {
        // The object store reports whole seconds. Round up to cover the entire policy period.
        let deadline = now + self.replication.retention_period;
        let retain_until = deadline
            + Duration::nanoseconds(i64::from(
                (1_000_000_000 - deadline.nanosecond()) % 1_000_000_000,
            ));
        self.object_store
            .copy_object(CopyObjectRequest {
                source_bucket: self.primary_bucket.clone(),
                source_key: media.s3_key.clone(),
                destination_bucket: self.replica_bucket.clone(),
                destination_key: media.s3_key.clone(),
                retain_until: Some(retain_until),
            })
            .await?;
        let head = self
            .object_store
            .head_object(self.replica_bucket.clone(), media.s3_key.clone())
            .await?;
        if head.size_bytes != media.size_bytes {
            return Err(StorageError::Verification(format!(
                "replica size mismatch: expected {}, got {}",
                media.size_bytes, head.size_bytes
            )));
        }
        if let (Some(expected), Some(actual)) = (
            media.checksum_sha256.as_deref(),
            head.checksum_sha256.as_deref(),
        ) && expected != actual
        {
            return Err(StorageError::Verification(
                "replica checksum_sha256 mismatch".to_owned(),
            ));
        }
        let retention = self
            .object_store
            .get_object_retention(self.replica_bucket.clone(), media.s3_key.clone())
            .await?;
        let retention_mode = retention.mode.or(head.object_lock_mode);
        if retention_mode.as_deref() != Some("COMPLIANCE") {
            return Err(StorageError::Verification(
                "replica object is not under COMPLIANCE retention".to_owned(),
            ));
        }
        let actual = retention.retain_until.or(head.retain_until);
        if actual.and_then(|date| Timestamp::parse(&date, &Rfc3339).ok()) != Some(retain_until) {
            return Err(StorageError::Verification(
                "replica retain-until differs from the requested deadline".to_owned(),
            ));
        }
        Ok(())
    }

    async fn record_replication_success(
        &self,
        media: EvidenceMedia,
        trace: TraceContext,
        occurred_at: Timestamp,
        lease: Timestamp,
    ) -> Result<EvidenceMedia, StorageError> {
        let org = current_org().map_err(KernelError::from)?;
        let branch_id = branch_for_work_order(&self.pool, media.work_order_id).await?;
        let event = evidence_audit_event(
            "evidence.verify",
            None,
            branch_id,
            media.id,
            trace,
            occurred_at,
        )?
        .with_org(org);
        with_audit::<_, EvidenceMedia, StorageError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let written = sqlx::query(
                    r#"
                    UPDATE evidence_media
                    SET replica_lease_until = NULL, worm_replica_status = 'VERIFIED',
                        verified_at = $2,
                        last_error = NULL,
                        next_retry_at = $2,
                        updated_at = $2
                    WHERE id = $1 AND replica_lease_until = $3
                    "#,
                )
                .bind(*media.id.as_uuid())
                .bind(occurred_at)
                .bind(lease)
                .execute(tx.as_mut())
                .await?;
                if written.rows_affected() == 0 {
                    return Err(StorageError::Verification("replica lease changed".into()));
                }
                evidence_media_by_id_tx(tx, media.id).await
            })
        })
        .await
    }

    async fn record_replication_failure(
        &self,
        media: EvidenceMedia,
        error: String,
        trace: TraceContext,
        occurred_at: Timestamp,
        lease: Timestamp,
    ) -> Result<ReplicationOutcome, StorageError> {
        let org = current_org().map_err(KernelError::from)?;
        let branch_id = branch_for_work_order(&self.pool, media.work_order_id).await?;
        let next_retry_count = media.retry_count + 1;
        let next_status = if next_retry_count >= self.replication.max_retries {
            WormReplicaStatus::Failed
        } else {
            WormReplicaStatus::Pending
        };
        let next_retry_at = if next_status == WormReplicaStatus::Failed {
            occurred_at
        } else {
            occurred_at + retry_delay(next_retry_count, &self.replication)
        };
        if next_status == WormReplicaStatus::Failed {
            tracing::error!(
                media_id = %media.id,
                work_order_id = %media.work_order_id,
                retry_count = next_retry_count,
                "evidence WORM replication reached max retries and is visible in admin queue"
            );
        }
        let event = evidence_audit_event(
            "evidence.verify",
            None,
            branch_id,
            media.id,
            trace,
            occurred_at,
        )?
        .with_org(org);
        with_audit::<_, (), StorageError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let written = sqlx::query(
                    r#"
                    UPDATE evidence_media
                    SET replica_lease_until = NULL, worm_replica_status = $2,
                        retry_count = $3,
                        next_retry_at = $4,
                        last_error = $5,
                        updated_at = $6
                    WHERE id = $1 AND replica_lease_until = $7
                    "#,
                )
                .bind(*media.id.as_uuid())
                .bind(next_status.as_db_str())
                .bind(next_retry_count)
                .bind(next_retry_at)
                .bind(error)
                .bind(occurred_at)
                .bind(lease)
                .execute(tx.as_mut())
                .await?;
                if written.rows_affected() == 0 {
                    return Err(StorageError::Verification("replica lease changed".into()));
                }
                Ok(())
            })
        })
        .await?;
        Ok(ReplicationOutcome {
            media_id: media.id,
            status: next_status,
            retry_count: next_retry_count,
        })
    }
}
