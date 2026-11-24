# Olutech PMS — Fresh Start Release (STAGING ONLY)

Based on the 21 November 2026 custom PMS staging release.

## Changes

- Seed data now starts with 0 projects, 0 tasks, 0 approvals, 0 delays, 0 NXP checklist entries, 0 retired risks, and 0 workflow handoffs.
- New Level 5 feature inside **Storage Status → Start Fresh — Operational Records**.
- Before reset, a Level 5 user must download an offline JSON backup, enter their current password, type `RESET OPERATIONS`, and confirm deletion.
- The server automatically creates and verifies an additional backup before clearing stored data. Any failed backup stops the reset.
- The reset also clears task timers, workflow handoffs, linked conversations, and the old NXP checklist, which would otherwise recreate old tasks. Retired risks referencing removed items are cleared; unrelated risks remain.
- Existing users, passwords, roles, attendance, file records, lessons, Excel import history, retired Action Log data, and audit records are retained.
- Added safe tests for Level 5-only access, backup success/failure, zero-regeneration, and preserved data. All 35 original integration checks still pass.

## Not performed

- No live database deletion or migration.
- No change to GitHub or Vercel production.
- No Upstash credential use.

**Caution:** Existing full-JSON Upstash storage is not transactional. Avoid resets while other staff are making changes. Before any production deployment, test this release against a separate staging database, and make an independently stored backup. See FRESH_START_GUIDE.md.
