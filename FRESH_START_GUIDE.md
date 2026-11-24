# Olutech PMS — Fresh Start (Staging only)

## What is cleared

All projects, tasks, approvals and delays. Linked NXP checklist tasks, task-timer entries, workflow handoffs and project/task chat messages are also cleared because they would otherwise recreate tasks or remain orphaned. Risks referencing deleted projects, tasks or delays are removed. Other unrelated records remain intact.

## What is deliberately preserved

Staff/user accounts and passwords, clearance levels, attendance/time-clock records, uploaded file records and attachments, lessons learned, Excel import history, retired Action Log items, unlinked risks, and audit history.

## New installs vs existing live PMS

- `data/seed.json` has empty project/task/approval/delay/NXP/risk lists. Starting with a NEW isolated local database shows empty registers.
- On an existing Vercel deployment, changing the seed DOES NOT erase your live Upstash records.
- No production action was performed when this ZIP was created.

## To clear the existing running PMS (only after testing)

1. Deploy to a **separate staging project and separate Upstash test database**; check login and pages first. Do not point staging to the production Upstash credentials.
2. Take a full independent backup of production, and ensure no other users are entering data during the reset.
3. After separately approving the release for production, log in as a Level 5 admin and open **Storage Status**.
4. Click **Download full database backup (JSON)** and store it securely offline. It contains sensitive staff and session data.
5. In **Start Fresh — Operational Records**, enter the exact phrase `RESET OPERATIONS`, your current password, and check the acknowledgement. The reset will not run unless a second, **verified** backup is saved under a distinct Upstash key (or a local backup file, for local development).
6. Confirm the deletion and verify that Projects, Tasks, Approvals, and Delays display zero items. The backup identifier will be displayed on success.

**Important:** Do not initiate the reset if employees are actively updating the PMS. The existing whole-JSON Upstash architecture is not transactional, so concurrent requests can overwrite each other even with this guarded tool. A backup does not prevent concurrent writes. Before production, resolve the underlying data-concurrency limitation if possible.

Do not publish, commit, or send backup JSON files: they can contain login sessions and private company data. Never add `storage/db.json` to Git.

### Automated tests

Run `npm test` locally. The test suite uses isolated temporary databases and a mock Upstash service. It never reads or writes production credentials or production databases.

### Cloud-backup caveat

The verified pre-reset backup is stored under a second key in the **same** Upstash instance. It is a recovery checkpoint, not an independent disaster-recovery backup. Keep the separately downloaded JSON backup somewhere encrypted and access-controlled.
