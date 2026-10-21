# Deployment secrets

Keep secret values outside this repository. Production provisioning and custody are
maintained in the private console-infra repository; its runbook is authoritative.

Set `CONSOLE_COLDSTART_OTP` to a fresh one-time secret, or leave it unset to disable
cold-start sign-in. Never use the published development value in a deployment.
Keep `CONSOLE_COOKIE_SECURE` enabled for HTTPS deployments.
