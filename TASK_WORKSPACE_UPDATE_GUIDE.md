# Olutech Agro PMS - Task Workspace and Deletion Upgrade

**Release:** 23 November 2026 | **Status:** STAGING ONLY (not deployed)

## Changes

1. Each task now opens a dedicated task workspace through **Tasks -> Open Task**.
2. **Comments** and **Files** are separate, equally visible tabs for that task. The Comments tab shows the task's existing discussion thread and provides a message composer. The Files tab shows the attachments for only that task and supports uploading, downloading, and editing/deleting files where authorized.
3. Tasks remain in Open/Closed lists. Each row now has quick links to its own Comments and Files pages.
4. **Delete Task** is visible directly within each task row and on the task's detail view (with a deletion reason: Created in error / No longer needed / Duplicate task). The prior deletion control inside Update Task is retained. Bulk Delete Selected still works.
5. Task deletion requires Level 5 or task assignment/creator permissions, as before. Only Level 5 may delete workflow tasks. Confirmation is required; a deletion audit record and reason are saved. Task documents are preserved, with access restrictions kept, and logged timer entries remain in the audit history.
6. The clean-start `data/seed.json` already contains **zero preloaded projects and zero tasks**. This does not delete any live data in Upstash; the database backing your running Vercel site is separate.

## What did not change

Existing user management, workflows, attendance (9am to 6pm auto-checkout with 30-minute after-6pm rule), time-tracking, weekly PDF reports, projects, approvals, delays, and dark mode remain present.

## Test locally (never use production Upstash variables for testing)

Open the extracted folder in VS Code and run:

```powershell
npm.cmd install
npm.cmd test
npm.cmd start
```

Open http://localhost:3000. Test as a non-production test user with locally created sample tasks. An isolated local test database will be created automatically if no database exists.

The automated tests use temporary directories and deliberately blank cloud environment variables so they cannot alter live data.

## Important: Live data and production safety

- This release **does not** erase tasks already stored in live Upstash. Do not expect a GitHub code push or a seed update to clear production tasks.
- If you want to remove specific tasks from the live PMS, the updated interface permits individual or selected deletion after deployment. Only do so after backing up live operational data and confirming the tasks.
- The existing Level 5 clean-start reset under Storage Status clears multiple operational registers (not just tasks). **Do not use this if you only want to delete selected tasks.**
- Do not overwrite or upload `storage/db.json`, `.env`, or `storage/uploads/`. This ZIP contains none of those files.
- To test on Vercel, use a different Vercel staging project, separate Upstash database, and separate persistence key.
- Be aware that the application's legacy full-database Upstash write path can lose concurrent updates. A separate persistence redesign is needed before claiming production-grade transaction safety.

## Included validation

- `node --check server.js`
- `npm test`: 55 smoke/integration checks, reset tests (local and mocked cloud), 18 weekly-report tests.
- `data/seed.json` checked to include zero projects and zero tasks.

