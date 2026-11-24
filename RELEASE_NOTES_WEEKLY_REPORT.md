# Release notes - Weekly Deliverables Reports

**Date:** 21 November 2026  
**Deployment:** STAGING ONLY - production unaffected

Added:
- Sidebar menu **Weekly Reports** for all signed-in employees.
- Read-only dashboard at `/reports/weekly`, with week, project and authorised employee filters.
- Direct downloadable PDF at `/reports/weekly.pdf` with the same filters and authentication checks.
- Employee-level task completion, open, overdue, blocked, evidence and task timer summaries.
- Summary and detailed PDF pages, with automatic wrapping and pagination.
- Completion timestamps added when newly created tasks are already complete or when tasks are changed to Closed/Approved, improving future weekly completion reporting.
- Automated weekly-report tests, including access control and Vercel rewrite compatibility.

Retained:
- Existing project/task workflows, task timers, staff editing, user deletion, approvals, delays, manual attendance, themes, clean-start controls and data structures.
- All existing live records are untouched; the supplied seed remains empty.

Limitations:
- Reports are current-state snapshots for a selected week, **not** immutable historical week-end snapshots.
- For older closed tasks missing `completedAt`/`completionDate`, the system cannot infer the precise completion week. They appear in the report if due or otherwise active in the selected week, but are not counted as "Completed in week" without a date.
- PDF uses standard built-in fonts; uncommon Unicode characters are transliterated in the PDF, but remain unchanged in the PMS database.
