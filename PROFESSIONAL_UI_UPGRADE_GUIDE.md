# Olutech Agro PMS — Professional UI Upgrade

**Release date:** 23 November 2026  
**Status:** Staging only; no live database or Vercel deployment was modified.

## What's changed

The interface has been redesigned to feel like a professional, lightweight operations platform while keeping the existing PMS modules and business rules unchanged.

- **Application header:** company wordmark, current user identity, per-user theme selector, password-administration link when eligible, and logout.
- **Sidebar:** navigation grouped into Workspace, Operations, and Administration, with simple vector icons and active-page highlighting.
- **Responsive mobile navigation:** opens as an accessible side drawer instead of a difficult-to-scroll horizontal menu; supports a backdrop and Escape to close.
- **Dashboard:** clearer executive hero, calmer KPI cards, improved spacing and hierarchy for management tables.
- **Projects and tasks:** more legible table headers, stronger forms, task status controls and workspaces, improved chips and progress bars.
- **Task Comments and Files:** same behavior as before; visual alignment is updated to the new design system.
- **Weekly Reports and Time Clock:** consistent filter panels and readout cards.
- **Light/dark modes:** improved contrast and consistent backgrounds while retaining each employee's existing theme preference.
- **Sign-in screen:** cleaner typography, form treatment and visual styling.

### Preserved features

The application retains the previous version's data and behavior: clearance permissions, employee edit/delete management, task creation/deletion, task timers, task-specific comments/files, projects and workflows, weekly deliverables PDF export, approvals and delays, 9 AM–6 PM clock rules, reset-with-backup controls, persistence, and Vercel rewrites.

The **code changes** are limited to the application layout/navigation functions in `server.js`, a new `public/interface.css` file, and five additional UI assertions in `tests/smoke.js`. There are **no database schema changes** in this release. Existing `public/styles.css`, `data/seed.json`, `vercel.json` and other application modules are preserved.

## Preview

Open `UI_PREVIEWS/` for screenshots of the staging build with an empty test dataset. These are screenshots, not evidence of production status.

## Testing

Use Node.js LTS (v18+), then from the extracted folder:

```powershell
npm.cmd install
npm.cmd test
npm.cmd start
```

Open `http://localhost:3000` and test the dashboard, user management, reports, task workspace and theme selector. For a local-only test, do not add the live Upstash credentials to your local `.env` or shell environment.

**Test results during packaging:** 60 integration checks, reset tests, mocked cloud-reset tests and 18 weekly-report checks passed. Screenshots were rendered and reviewed at 1440px desktop and 390px mobile widths, including dark mode and mobile drawer navigation.

## Protecting production

1. Keep the production GitHub repository, Vercel deployment and Upstash database unchanged while testing.
2. Create a separate staging Vercel project with separate database credentials (do not allow preview deployments to share the live Upstash database).
3. Back up the production Upstash database and verify the backup before promotion.
4. Review staging functions/routes, including `/dashboard`, `/projects`, `/tasks`, `/tasks/view`, `/attendance`, `/admin/users`, `/reports/weekly`, and PDF export.
5. Promote with a regular reviewed Git commit / pull request. **Do not use `git push --force`.**

**Data safety:** Extraction, `npm.cmd test` and the local server run do not modify your production Upstash database unless you explicitly give the test environment production credentials. This package intentionally excludes `.env`, `storage/db.json`, local uploads, and production files.

## Quick rollback

The main redesign is in `public/interface.css`. For visual rollback, remove its `<link>` line from the `page()` function and restore the previous `page()` and `navHtml()` layout functions from your earlier ZIP or Git commit. Existing application data is unaffected by this presentation change.
