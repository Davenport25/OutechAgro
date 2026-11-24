'use strict';

// Cleans operational registers without touching users, attendance, files, lessons,
// imported workbook history, authentication sessions, or the audit trail.
// Must be called ONLY after a verified backup has been created.
function operationalCounts(db) {
  return Object.fromEntries(['projects','tasks','approvals','delays','nxpChecklist',
    'projectHandoffs','taskTimeEntries','chatMessages','risks','notifications'].map(key =>
    [key, Array.isArray(db[key]) ? db[key].length : 0]));
}

function clearOperationalRecords(db) {
  const before = operationalCounts(db);
  const projectIds = new Set((db.projects || []).map(item => String(item.id)));
  const taskIds = new Set((db.tasks || []).map(item => String(item.id)));
  const delayIds = new Set((db.delays || []).map(item => String(item.id)));
  for (const field of ['projects','tasks','approvals','delays','nxpChecklist',
    'projectHandoffs','taskTimeEntries']) db[field] = [];
  // Remove conversations linked to deleted project/task records, but not user accounts.
  db.chatMessages = (db.chatMessages || []).filter(message => {
    const type = String(message.targetType || '').toLowerCase();
    return type !== 'project' && type !== 'task';
  });
  // Retired Risk Register records are preserved except those referring to a deleted
  // project, task, or delay. Otherwise, old risk counters could survive the reset.
  db.risks = (db.risks || []).filter(risk => {
    if (risk.projectId && projectIds.has(String(risk.projectId))) return false;
    if (risk.relatedTaskId && taskIds.has(String(risk.relatedTaskId))) return false;
    if (risk.taskId && taskIds.has(String(risk.taskId))) return false;
    if (risk.relatedDelayId && delayIds.has(String(risk.relatedDelayId))) return false;
    return true;
  });
  // Old task alerts cannot outlive a full operational reset.
  db.notifications = (db.notifications || []).filter(n => n.type && !String(n.type).startsWith('task_'));
  const after = operationalCounts(db);
  return { before, removed: Object.fromEntries(Object.keys(before).map(key => [key, before[key] - after[key]])), after };
}

module.exports = { operationalCounts, clearOperationalRecords };
