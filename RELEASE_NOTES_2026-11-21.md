# Olutech Agro PMS — Requested Updates (Staging Candidate)

**Prepared from the eight files uploaded on 21 November 2026.** This is a code-only staging release. It has **not** been pushed to the GitHub repository, deployed to Vercel, or connected to the company's live Upstash database. The original project, task, chat, attendance, and approval data is not included in this ZIP, and nothing was deleted from production.

## Requested changes implemented

1. **Level 5 employee editor**: Users → Edit user changes name, official email, role, clearance, account status and password. New names/roles are reflected in project owners, task assignees/assigners and other live ownership fields when saved. Old spreadsheet defaults no longer undo explicit admin edits or re-enable disabled users. An employee's login identity keeps its stable ID.
2. **Deletion controls at the top** of Projects and Tasks: tick records and select **Delete selected projects/tasks**. The existing individual Delete buttons inside each record's edit area remain in place. Project deletion still blocks projects with linked active tasks, files, delays, approvals or lessons. Hidden legacy Action Log/Risk history is not deleted.
3. **Per-task timers**: Start, Stop, cumulative time logged and a time-entry history for each task. All user time entries persist in the same database as the rest of the PMS. Users cannot run two task timers simultaneously. A running timer stops if the task is closed/deleted or the employee account is disabled/deleted. Existing time logs are retained after task deletion.
4. **Projects simplified**: sponsor, phase and category have been removed from project creation/edit and project views, including workflow step phase controls. Historical stored values are retained for backward compatibility.
5. **Closed tasks are separate**: default Tasks page shows only Open Tasks; completed/closed/cancelled tasks appear only when the user clicks the **Closed Tasks** tab.
6. **Every clearance level can create normal tasks**: task button now says **Create Task**. Project creation and workflow structure editing remain Level 5 only.
7. **Action Log and Risks retired from active PMS**: removed from navigation and executive dashboards. Their endpoints are disabled, importer skips their sheets, and automatic risk generation stops. Historical Action Log/Risk records remain in the database; other modules, including Delays and Approvals, remain.
8. **Manual Time Clock**: no automatic clock-out at 5 PM or upon any request. Each employee sees only their own attendance record; Level 5 can select an employee to see that employee's history separately. Already recorded historical automatic clock-outs are not rewritten.
9. **Light/Dark theme**: new Theme selector immediately beside Logout. Preference is saved per user and restored on sign-in.
10. **Other PMS functions preserved**: projects, workflows and handoff, dashboards, Tasks, Delays, KPI, Lessons, Approvals, Files, Excel import (excluding retired modules), Storage Status, persistent chats, permissions, login and passwords.

## Notes and limitations

- The uploaded app uses one whole JSON object stored in Upstash. Its existing last-writer-wins design may lose simultaneous edits, especially if multiple employees save tasks/timers at once. **This release does not replace that persistence architecture or guarantee safe concurrent writes.** A transactional database or atomic update layer is recommended before production rollout.
- The uploaded app also has a temporary local-storage fallback on Vercel if cloud storage fails. This release retains that behavior to avoid changing the production storage architecture unexpectedly; it needs a separate safety hardening step before production.
- Running task timers continue until manually stopped, the task is closed/deleted or the account is disabled/deleted. Timer records may cover more than one workday. Time Clock is independent of task timers.
- The old Action Log/Risk data remains stored but is no longer visible/operable from the web UI; this is deliberate to avoid irreversible data deletion.
- This ZIP contains no `.env`, `storage/db.json`, cached uploads, or Git repository metadata. Any current live data must continue to be loaded via the hosting environment's existing persistent storage configuration; do not replace it with the bundled `data/seed.json`.

## What was tested

Run `npm test` for **35 isolated end-to-end tests**. These exercise sign-in, dashboard routes, navigation, user edit and persistence after reload, name propagation into projects/tasks, Level 1 task creation, timer start/stop persistence, task deletion access controls, project deletion safeguards, manual attendance across different days, employee-record privacy, theme persistence, stylesheet serving, and the Vercel-style routing query. Tests run with a **temporary local database** created and destroyed by the test; they never use production storage.

## Required staging acceptance tests before production

1. Back up and independently verify a restore point for the live Upstash database. Keep credentials out of chat, GitHub and files.
2. Create a separate Vercel project and **separate Upstash database / key** for staging. Never reuse production Upstash credentials or the production persistence key in staging.
3. Use staging employee accounts to verify project/workflow behavior, chat and file downloads, timers across browser sessions, employee rename and permission changes, manual attendance, mobile layouts, and dark/light themes.
4. Perform a concurrency test with at least two employees updating different tasks simultaneously; resolve any lost-update issue before using this release with live project data.
5. After acceptance, plan a reversible deployment with a backup, specific commit/tag, and rollback procedure. Do not use `git push --force`; deploy a reviewed branch/PR instead.

## Local commands

```bash
npm install
npm test
npm start
```

Open http://localhost:3000. The app will build a **local test database** from `data/seed.json` if no local database exists; this is not a copy of your live database. Default seed passwords are temporary and should not be used for Internet-facing deployments.
