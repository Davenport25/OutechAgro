# Weekly Deliverables Reports (Zoho-style) - Olutech Agro PMS

## Where to find it

After logging in, open **Weekly Reports** in the left-hand menu, or visit `/reports/weekly`.

1. Choose any date in the week you want. The system automatically uses the **Monday-Sunday** week.
2. Level 5 administrators can view **All employees** or filter to one employee; all users can view **their own** reports. Team members cannot view someone else's report by editing the URL.
3. Optionally filter to a project, then select **View report**.
4. Select **Download PDF** for an on-demand, multi-page PDF (no paid service or external PDF dependency).

The PDF contains a company-branded overview, employee-by-employee scorecard, individual task details, project, priority/status, deadline, next action, work notes, evidence links and **time logged from task timers**.

## What counts as a weekly deliverable?

To avoid missing work, the selected week includes tasks with a deadline, creation date, update date, completion date, or timer activity during the week, **plus still-open past-due tasks carried over**. Existing tasks are not changed by reports. Report figures use the current database.

- **Deliverables**: the number of matching tasks owned by each person.
- **Due this week**: selected-week deadline.
- **Completed in week**: completed/closed task with a recorded completion date inside the selected week. Historical tasks without a completion date cannot reliably contribute to this figure.
- **Open now / overdue now / blocked now**: current status when the report is generated. Historical weeks are not frozen snapshots.
- **Hours**: actual overlap of each employee's task timer entries with the selected week. Running timers are counted only through the current time.
- **Completion rate**: currently completed tasks divided by deliverables for the selected week, not a historical week-end completion rate.

## Safety and migration

- This is a **staging-only source update**. It has **not been deployed** or connected to the production Upstash database.
- No reset of active records is needed to enable reporting.
- The empty starting seed from the previous clean-start release remains unchanged.
- Existing projects/tasks can continue to be read; reports only query the database and stream a PDF response.
- The existing Level 5 `Storage Status > Start Fresh` feature is preserved. Do not run it unless you deliberately want to erase operational records.
- To avoid data loss, test with an isolated Upstash/Vercel staging project and verify a production backup before making a production code deployment.

## Test locally

```bash
npm test
npm start
```

Then open `http://localhost:3000/reports/weekly` after logging in. You can add sample project/task records in the local database to test a nonempty PDF.

The ZIP excludes local data files, credentials, node_modules and test fixtures. The sample PDF provided separately contains **invented demonstration records**, not Olutech live operational data.
