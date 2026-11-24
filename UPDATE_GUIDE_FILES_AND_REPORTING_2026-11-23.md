# Olutech Agro PMS - Unassigned File Deletion & Reporting Accounts

**Release type:** Staging only. Based on `Olutech_PMS_Professional_UI_Redesign_STAGING_ONLY_2026-11-23.zip`.

## 1. Delete unassigned files directly

Open **Tasks -> Existing unassigned files**. An authorized user sees a **Delete file** button beside an unassigned file. A confirmation prompt is shown before deletion. No task attachment step is required.

The existing `/files/delete` backend, permissions, audit trail, and file-removal flow are reused. Users still need to have access to the file and permission to manage it (uploader or Level 3+, subject to the file clearance). Deleted file records cannot be recovered through the application. A cloud backup should be taken before production rollout.

## 2. Akin & System Administrator: access users, not task-delivery staff

These two accounts **remain in Users**, with their existing email, role, clearance, access to approvals, and login capabilities unchanged:

- `akin@olutechagro.com` / AKIN
- `admin@olutechagro.com` / System Administrator

They are excluded from:

- Weekly Deliverables HTML employee selector, employee scorecard, summary totals, and PDF export (including historical tasks still bearing their names)
- Weekly Staff Operations and Accountability Register tables on the Level 5 dashboard
- KPI & Performance Monitoring employee list
- New task and workflow-assignee suggestions, with backend validation to prevent entering these names manually on new assignments

**No historical tasks are removed or reassigned.** Existing records, approval requests, and audit history remain intact. Akin and System Administrator can still create or approve work according to their current permissions; they simply are not scored as owners of task deliverables. Any old task assigned to them is excluded from deliverables reports and should be reassigned by a manager if it is still operationally active.

## 3. Test locally, then in isolated staging

1. Extract into a NEW directory; do not overwrite your production repo yet.
2. In the directory containing `server.js` and `package.json`, run `npm install`, then `npm test`.
3. Run `npm start`; open `http://localhost:3000` and test with *local test data only*.
4. For a Vercel preview, use a **separate project and separate Upstash database/persistence key**.
5. Back up production Upstash, verify staging, and only then consider controlled production deployment.

**Do not point this staging app at production Upstash.** The ZIP does not contain `storage/db.json`, uploads, `.env`, or live database credentials; extracting it alone will not alter any live records.

## 4. Verification

Automated regression checks: `npm test` passed in an isolated database, including:

- 75 application integration checks
- Local and mock-cloud clean-start/reset checks
- 25 weekly-report/PDF checks

The tests cover unassigned file deletion permission/visibility/audit, weekly PDF filtering, Akin and admin login continuity, executive/KPI scorecards, and server-side task/workflow assignment restrictions. They are not a substitute for staging validation against a representative copy of your data.
