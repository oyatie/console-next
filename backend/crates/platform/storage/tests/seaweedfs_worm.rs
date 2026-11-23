use console_platform_storage::{
    CopyObjectRequest, S3ObjectStore, S3StorageConfig, SeaweedS3Storage,
};
use std::{env, io, process::Command};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

#[tokio::test]
async fn seaweedfs_compliance_retention_protects_locked_object_version()
-> Result<(), Box<dyn std::error::Error>> {
    let bucket = format!("worm-{}", uuid::Uuid::new_v4());
    let primary = format!("primary-{}", uuid::Uuid::new_v4());
    let key = format!("evidence/{}.txt", uuid::Uuid::new_v4());
    let storage = SeaweedS3Storage::from_config(&S3StorageConfig {
        endpoint_url: env::var("CONSOLE_STORAGE_TEST_S3_ENDPOINT")?,
        region: "us-east-1".to_owned(),
        access_key_id: env::var("AWS_ACCESS_KEY_ID")?,
        secret_access_key: env::var("AWS_SECRET_ACCESS_KEY")?,
        primary_bucket: primary.clone(),
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

    storage.create_bucket(&primary, false).await?;
    storage
        .put_bytes(&primary, &key, "text/plain", evidence.to_vec())
        .await?;
    let replica_deadline = retain_until + Duration::days(1);
    storage
        .copy_object(CopyObjectRequest {
            source_bucket: primary,
            source_key: key.clone(),
            destination_bucket: bucket.clone(),
            destination_key: key.clone(),
            retain_until: Some(replica_deadline),
        })
        .await?;
    let copied = storage
        .get_object_retention(bucket.clone(), key.clone())
        .await?;
    assert_eq!(copied.mode.as_deref(), Some("COMPLIANCE"));
    let deadline = replica_deadline.format(&Rfc3339)?;
    assert_eq!(copied.retain_until.as_deref(), Some(deadline.as_str()));

    let url = format!(
        "{}/{bucket}/{key}",
        env::var("CONSOLE_STORAGE_TEST_S3_ENDPOINT")?
    );
    let replica_version = signed_curl(
        &url,
        &[
            "--head",
            "--output",
            "/dev/null",
            "--write-out",
            "%header{x-amz-version-id}",
        ],
    )?;
    assert!(!replica_version.is_empty());
    assert_ne!(replica_version, version_id);
    let denial = storage
        .delete_object_version(&bucket, &key, &replica_version)
        .await
        .err()
        .ok_or_else(|| io::Error::other("retained replica was deleted"))?;
    assert!(
        denial.to_string().contains("<Code>AccessDenied</Code>"),
        "{denial}"
    );
    let mut version_url = url::Url::parse(&url)?;
    version_url
        .query_pairs_mut()
        .append_pair("versionId", &replica_version);
    let mut retention_url = version_url.clone();
    retention_url.query_pairs_mut().append_pair("retention", "");
    for (mode, date) in [
        ("COMPLIANCE", retain_until.format(&Rfc3339)?),
        ("GOVERNANCE", deadline),
    ] {
        let body = format!(
            "<Retention><Mode>{mode}</Mode><RetainUntilDate>{date}</RetainUntilDate></Retention>"
        );
        assert_access_denied(
            retention_url.as_str(),
            &[
                "-X",
                "PUT",
                "-H",
                "Content-Type: application/xml",
                "--data-binary",
                &body,
            ],
        )?;
    }
    assert_access_denied(
        version_url.as_str(),
        &[
            "-X",
            "DELETE",
            "-H",
            "x-amz-bypass-governance-retention: true",
        ],
    )?;
    let retained = storage
        .head_object_version(&bucket, &key, &replica_version)
        .await?;
    assert_eq!(retained.object_lock_mode, copied.mode);
    assert_eq!(retained.retain_until, copied.retain_until);
    Ok(())
}

fn assert_access_denied(url: &str, args: &[&str]) -> io::Result<()> {
    let mut args = args.to_vec();
    args.extend(["--write-out", "\n%{http_code}"]);
    let response = signed_curl(url, &args)?;
    assert!(
        response.ends_with("\n403") && response.contains("<Code>AccessDenied</Code>"),
        "{response}"
    );
    Ok(())
}

fn signed_curl(url: &str, args: &[&str]) -> io::Result<String> {
    let output = Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            "--aws-sigv4",
            "aws:amz:us-east-1:s3",
            "--variable",
            "%AWS_ACCESS_KEY_ID",
            "--variable",
            "%AWS_SECRET_ACCESS_KEY",
            "--expand-user",
            "{{AWS_ACCESS_KEY_ID}}:{{AWS_SECRET_ACCESS_KEY}}",
        ])
        .args(args)
        .arg(url)
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(String::from_utf8_lossy(&output.stderr)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
