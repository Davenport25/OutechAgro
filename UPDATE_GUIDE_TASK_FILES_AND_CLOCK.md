# Olutech PMS — Task Files + Automatic Time Clock

**Staging release: 21 November 2026.** Based on `Olutech_PMS_Weekly_Deliverables_Reports_STAGING_ONLY_2026-11-21.zip`.

## 1. Files now live inside Tasks

- The standalone **Files** sidebar item has been removed. Older `/files` bookmarks redirect to `/tasks?view=open`.
- Open **Tasks**, then a task's **Files & Evidence** panel to upload, list, download, edit the title/notes/access level, or delete files.
- Each upload is linked to exactly one task; attached files use the same existing file records and underlying storage format, so the upgrade does not remove older files.
- Previously uploaded records with no task association remain under **Tasks → Existing unassigned files**. An owner or an administrator can attach them to a task.
- When a task is deleted or operations are reset, task attachments are **retained**, but only their uploader and Level 5 can read or reassign the orphaned files. Older general/project files preserve their existing clearance-based access rules.
- Task-specific downloads also verify the employee can view the task; a URL alone cannot bypass task access rules.
- New uploads are capped at **4 MB per file** because the current PMS stores a Base64 archive inside its main JSON/Upstash record. A separate object-storage solution is advisable for large collections or heavy use.

## 2. Automatic time clock policy (Africa/Lagos)

> **Attendance notice:** Official clock-in window is **9:00 AM–6:00 PM**. Clock-in records started **before 6:00 PM** are automatically clocked out **at 6:00 PM**. Clock-in records started **at or after 6:00 PM** automatically clock out **30 minutes after clock-in**, including after midnight. Employees can clock out earlier if they finish sooner.

- A clock-in at 9:00 AM closes at 6:00 PM (9 hours of recorded elapsed time).
- A clock-in at 5:50 PM closes at 6:00 PM (10 minutes).
- A clock-in at 6:15 PM closes at 6:45 PM (30 minutes).
- A clock-in at 11:50 PM closes at 12:20 AM the following day (30 minutes).
- The 9 AM–6 PM standard schedule and expected-hours default were updated from 8 to 9 hours in the seed and the existing-work-settings migration. Historical clock-outs already completed are not rewritten.
- Each user's attendance records remain private; Level 5 can review them individually. The existing AKIN exemption is retained.
- A browser on the Time Clock page checks every 30 seconds. A deployed serverless instance does **not** stay running continuously. If all users close the site, the next incoming request reconciles any expired session **at its originally scheduled checkout timestamp**. For a hard guarantee of updates at the exact moment while the site is completely idle, use an external periodic scheduler in a future release.

## 3. What has not changed

Projects, task timers, user editing, Level 1 task creation, workflow handoffs, weekly deliverable reports with PDF export, approvals, delays, dashboard, themes, reset/backup, and existing authentication remain intact.

## 4. Safe local test

Unzip into a *new folder*, then from its VS Code terminal:

```bash
npm install
npm test
npm start
```

Open `http://localhost:3000`. Test with disposable task records. The included tests use isolated temporary databases and do not connect to production Upstash.

**Do not push this release to the production GitHub branch without staging and backing up production first.** The ZIP does not include `.env`, `storage/db.json`, or local uploaded files. No GitHub, Vercel, or Upstash production changes were made during its preparation.
