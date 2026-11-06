-- SPDX-License-Identifier: LicenseRef-Proprietary
COALESCE(a.outcome,CASE WHEN a.after_snap->>'denied'='true'
  OR a.action ~ '([.]refused$|_refused$|[.]denied$)' THEN 'DENIED' ELSE 'ALLOWED' END)
