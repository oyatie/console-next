use console_platform_storage::{S3ObjectStore, S3StorageConfig, SeaweedS3Storage};
use std::{env, io};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

#[tokio::test]
async fn seaweedfs_compliance_retention_protects_locked_object_version()
-> Result<(), Box<dyn std::error::Error>> {
    let bucket = format!("worm-{}", uuid::Uuid::new_v4());
    let key = format!("evidence/{}.txt", uuid::Uuid::new_v4());
    let storage = SeaweedS3Storage::from_config(&S3StorageConfig {
        endpoint_url: env::var("CONSOLE_STORAGE_TEST_S3_ENDPOINT")?,
        region: "us-east-1".to_owned(),
        access_key_id: env::var("AWS_ACCESS_KEY_ID")?,
        secret_access_key: env::var("AWS_SECRET_ACCESS_KEY")?,
        primary_bucket: bucket.clone(),
        replica_bucket: bucket.clone(),
        force_path_style: true,
    })
    .await?;

    storage.create_bucket(&bucket, true).await?;
    let evidence = b"original evidence";
    let put = storage
        .put_bytes_with_result(&bucket, &key, "text/plain", evidence.to_vec())
        .await?;
    let version_id = put
        .version_id
        .ok_or_else(|| io::Error::other("SeaweedFS did not return a version id"))?;
    let retain_until = OffsetDateTime::now_utc().replace_nanosecond(0)? + Duration::days(1);
    storage
        .put_compliance_retention(&bucket, &key, retain_until)
        .await?;

    let retention = storage
        .get_object_retention(bucket.clone(), key.clone())
        .await?;
    assert_eq!(retention.mode.as_deref(), Some("COMPLIANCE"));
    assert_eq!(retention.retain_until, Some(retain_until.format(&Rfc3339)?));

    let denial = storage
        .delete_object_version(&bucket, &key, &version_id)
        .await
        .err()
        .ok_or_else(|| io::Error::other("retained version was deleted"))?;
    assert!(
        denial.to_string().contains("<Code>AccessDenied</Code>"),
        "expected AccessDenied for the retained version, got {denial}"
    );

    let second_put = storage
        .put_bytes_with_result(&bucket, &key, "text/plain", b"tampered evidence".to_vec())
        .await?;
    let replacement_id = second_put
        .version_id
        .ok_or_else(|| io::Error::other("missing replacement version id"))?;
    assert_ne!(replacement_id, version_id);
    let original = storage
        .head_object_version(&bucket, &key, &version_id)
        .await?;
    assert_eq!(original.size_bytes, i64::try_from(evidence.len())?);
    assert_eq!(original.object_lock_mode, retention.mode);
    assert_eq!(original.retain_until, retention.retain_until);
    storage
        .delete_object_version(&bucket, &key, &replacement_id)
        .await?;
    assert_eq!(storage.get_bytes(&bucket, &key).await?.0, evidence);
    Ok(())
}
