-- SPDX-License-Identifier: LicenseRef-Proprietary
SELECT a.id
FROM audit_events a
WHERE a.org_id=$1 AND a.created_at >= $2 AND a.created_at < $3
  AND a.created_at < $4 AND a.after_snap ? 'self_read'
  AND ($5::text IS NULL OR a.id=ANY($6) OR EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      COALESCE(a.actor_display,(SELECT u.display_name FROM person_accounts_current u
        WHERE u.org_id=a.org_id AND u.id=a.actor),''), a.actor::text, a.ip, a.action, a.target_type,
      COALESCE(a.principal_type,a.after_snap->>'principal_type',''),
      {outcome},
      COALESCE(a.after_snap->>'subject_count','0'), a.after_snap->>'export_purpose',
      a.after_snap->>'row_count',
      (a.occurred_at AT TIME ZONE $7)::text, (a.created_at AT TIME ZONE $7)::text
    ]) field WHERE strpos(lower(field),$5)>0
  ))
  AND ($8::text IS NULL OR a.actor=($8::text)::uuid)
  AND ($9::text IS NULL OR a.action=$9)
  AND ($10::text IS NULL OR a.target_type=$10)
  AND ($11::text IS NULL OR a.created_at >= (($11::text)::date::timestamp AT TIME ZONE $7))
  AND ($12::text IS NULL OR a.created_at < ((($12::text)::date + 1)::timestamp AT TIME ZONE $7))
