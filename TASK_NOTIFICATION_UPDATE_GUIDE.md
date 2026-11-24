# Olutech PMS — Task Notifications (23 November 2026)

## New feature

A notification bell is now visible in the top right of the PMS for every authenticated employee. New task events also appear as on-screen popups while the PMS is open.

| Event | Recipient | When it triggers |
| --- | --- | --- |
| Task assigned | Employee receiving the task | A task is created or reassigned using the PMS; also for workflow steps |
| Task opened | User who assigned that task | The assigned employee opens its task workspace for the **first time**; one alert per assignment, not per click/tab |
| Task closed | User who assigned that task | Task moves from an open status into Completed, Closed, Approved, Resolved, or Cancelled |

Notifications are scoped to the user ID of the recipient; the server checks login and permission before exposing them. Users can dismiss an individual popup (marking it read), open its task, mark individual items read, or mark all notifications read. The bell retains past notifications even after the popup is dismissed.

**Note about "Opened":** This means that the assignee opened the actual task details screen (`/tasks/view`), not that they merely loaded the task list or read an email. Opening a task after it was already closed does not produce an opened alert.

**Note about "Closed":** Completed and Closed are both closed task statuses in the PMS. The notification includes the exact status.

**Not external push notifications:** The popups work while the PMS is open in a browser. If the assigner is offline or has closed their browser, the notice is stored; it appears as unread in the PMS on their next visit. There is no email, WhatsApp, native OS push service, or background notification service in this update. The page checks for new messages every 20 seconds, and immediately on focus/return to the tab.

## Files changed

- `server.js`: notification data, event triggers, private feed/read endpoints, header control and safe JavaScript static serving.
- `public/notifications.js`: bell, panel, popup behavior, polling, mark-read controls.
- `public/interface.css`: notification styling for light, dark and mobile views.
- `maintenance/reset-operations.js`: wipes task-related notices when a Level 5 administrator completes a verified operational fresh-start reset.
- `tests/notifications.js`: isolated tests for permissions, creation, viewing, closure, read receipts and routing.
- `package.json`: includes notification checks in `npm test`.

## Local test

1. Extract the ZIP into a *new* folder.
2. Open that folder in VS Code.
3. Run `npm.cmd install` then `npm.cmd test`. Run `npm.cmd start` to browse the test app at `http://localhost:3000`.
4. Use a separate local database (`OLUTECH_DATA_DIR` or default local `storage/db.json`) and do **not** configure your production Upstash credentials in the local environment.
5. Have one employee assign a task to another. The assignee will see an assignment popup. When the assignee opens the task details, the assigner receives an opened popup. When it is completed, the assigner receives a closed popup.

## Deployment safety

No Vercel deployment, GitHub push, or Upstash mutation was performed in creating this staging package.

Before any production deployment: export an independent backup from the current Storage Status page; test using a separate Vercel project and **different Upstash database** (or an isolated key in a test-only instance). Confirm that old projects, tasks, attachments and passwords remain intact.

Known architectural limitation inherited from the existing PMS: one large Upstash JSON document is read and overwritten for saves. Concurrent employee changes can race. This notification update does not fix that. Production deployment should wait for a concurrency/persistence test and verified backup.
