'use strict';

// Read-only weekly reporting. This module does not mutate the PMS database.
const zlib = require('zlib');

function isoDate(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return '';
  const d = new Date(match[1] + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0,10) !== match[1] ? '' : match[1];
}

function lagosToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const p = Object.fromEntries(parts.map(i => [i.type, i.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function addDays(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}

function weekMonday(input) {
  const date = isoDate(input || lagosToday());
  if (!date) throw new Error('Select a valid week date.');
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

// These are login/approval accounts, not staff scored for task delivery.
// Check account email as well as legacy task-assignment display names.
function isExcludedFromDeliverables(value) {
  if (!value) return false;
  if (typeof value === 'object') {
    return isExcludedFromDeliverables(value.email || value.username) ||
      isExcludedFromDeliverables(value.displayName);
  }
  const raw = String(value).trim().toLowerCase().replace(/\s+/g, ' ');
  if (['admin@olutechagro.com', 'akin@olutechagro.com'].includes(raw)) return true;
  return ['admin', 'system administrator', 'system admin', 'akin', 'akin olutunla',
    'mr akin', 'mr akin olutunla'].includes(raw);
}
function same(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
function isComplete(task) { return ['completed','closed','approved','skipped'].includes(String(task.status || '').trim().toLowerCase()); }
function isClosed(task) { return isComplete(task) || String(task.status || '').trim().toLowerCase() === 'cancelled'; }
function isBlocked(task) { return ['blocked','delayed'].includes(String(task.status || '').trim().toLowerCase()); }
function within(date, start, end) { return !!date && date >= start && date <= end; }
function completedDate(task) { return isoDate(task.completedAt || task.completionDate); }
function createdDate(task) { return isoDate(task.dateLogged || task.createdAt); }
function updatedDate(task) { return isoDate(task.lastUpdateDate || task.updatedAt); }
function nonNegative(n) { return Math.max(0, Number(n) || 0); }
function formatHours(ms) { return (nonNegative(ms) / 3600000).toFixed(1); }
function prettyDate(date) {
  const d = isoDate(date);
  if (!d) return '-';
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'});
}

function timeOverlapMs(entry, weekStartMs, weekEndMs, nowMs) {
  const from = Date.parse(entry.startedAt || '');
  if (!Number.isFinite(from)) return 0;
  const end = entry.stoppedAt ? Date.parse(entry.stoppedAt) : nowMs;
  if (!Number.isFinite(end) || end <= from) return 0;
  return Math.max(0, Math.min(end, weekEndMs, nowMs) - Math.max(from, weekStartMs));
}

function buildWeeklyReport(db, viewer, opts = {}) {
  const monday = weekMonday(opts.week);
  const sunday = addDays(monday, 6);
  const nextMonday = addDays(monday, 7);
  const weekStartMs = Date.parse(`${monday}T00:00:00+01:00`);
  const weekEndMs = Date.parse(`${nextMonday}T00:00:00+01:00`);
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : Date.now();
  const admin = Number(viewer.clearance || 1) >= 5;
  const users = (db.users || []).filter(u => u && u.accountEnabled !== false);
  const reportingUsers = users.filter(u => !isExcludedFromDeliverables(u));
  const selection = String(opts.employee || 'all');
  if (!admin && selection !== 'all' && selection !== String(viewer.id)) throw new Error('You can only view your own weekly deliverables.');
  if (admin && selection !== 'all' && !reportingUsers.some(u => String(u.id) === selection)) throw new Error('Employee not available for deliverables reporting.');
  const projectSelection = String(opts.project || 'all');
  if (projectSelection !== 'all' && !(db.projects || []).some(p => String(p.id) === projectSelection)) throw new Error('Project not found.');
  const projects = new Map((db.projects || []).map(p => [String(p.id), p]));
  const ids = new Map(users.map(u => [String(u.id), u]));
  const names = new Map(users.map(u => [String(u.displayName || '').trim().toLowerCase(), u]));
  const records = new Map();
  function getOwner(task) {
    return ids.get(String(task.assignedUserId || '')) || names.get(String(task.assignedTo || '').trim().toLowerCase()) || null;
  }
  function keyFor(task, owner) { return owner ? String(owner.id) : 'legacy:' + String(task.assignedTo || 'Unassigned').toLowerCase(); }
  function ensureRow(key, name, role, userId) {
    if (!records.has(key)) records.set(key, { id: key, userId: userId || null, name, role: role || '', tasks: [], hoursMs: 0, assigned: 0, due: 0, completed: 0, currentlyDone: 0, open: 0, overdue: 0, blocked: 0, evidence: 0, completionRate: 0 });
    return records.get(key);
  }

  const selectedUsers = admin ? reportingUsers.filter(u => selection === 'all' || String(u.id) === selection) : (isExcludedFromDeliverables(viewer) ? [] : [viewer]);
  for (const u of selectedUsers) ensureRow(String(u.id), u.displayName || u.username, u.role, String(u.id));

  const timeByTask = new Map();
  for (const entry of db.taskTimeEntries || []) {
    const ms = timeOverlapMs(entry, weekStartMs, weekEndMs, nowMs);
    if (!ms) continue;
    const key = String(entry.taskId || '');
    const existing = timeByTask.get(key) || { totalMs: 0, users: new Map() };
    existing.totalMs += ms;
    existing.users.set(String(entry.userId || ''), (existing.users.get(String(entry.userId || '')) || 0) + ms);
    timeByTask.set(key, existing);
  }

  for (const task of db.tasks || []) {
    if (!task || !task.id) continue;
    if (projectSelection !== 'all' && String(task.projectId) !== projectSelection) continue;
    const owner = getOwner(task);
    if (isExcludedFromDeliverables(owner) || isExcludedFromDeliverables(task.assignedTo)) continue;
    if (!admin && (!owner || String(owner.id) !== String(viewer.id))) continue;
    if (admin && selection !== 'all' && (!owner || String(owner.id) !== selection)) continue;
    if (admin && selection === 'all' && !owner && !task.assignedTo) continue;
    const dueDate = isoDate(task.dueDate);
    const completedOn = completedDate(task);
    const createdOn = createdDate(task);
    const updatedOn = updatedDate(task);
    const time = timeByTask.get(String(task.id));
    const carryOver = !!dueDate && dueDate < monday && !isClosed(task);
    const inScope = within(dueDate, monday, sunday) || (isComplete(task) && within(completedOn, monday, sunday))
      || within(createdOn, monday, sunday) || within(updatedOn, monday, sunday) || Boolean(time) || carryOver;
    if (!inScope) continue;
    const key = keyFor(task, owner);
    const group = ensureRow(key, owner ? owner.displayName : (task.assignedTo || 'Former employee'), owner ? owner.role : 'Historical assignment', owner ? String(owner.id) : null);
    const doneWeek = isComplete(task) && within(completedOn, monday, sunday);
    const overdueNow = !isClosed(task) && !!dueDate && dueDate < lagosToday(new Date(nowMs));
    const blocked = !isClosed(task) && isBlocked(task);
    const item = {
      id: task.id, title: task.title || '(Untitled deliverable)', projectId: task.projectId || '', project: projects.get(String(task.projectId || ''))?.name || task.projectName || 'Unassigned project',
      status: task.status || 'Not Started', priority: task.priority || 'Normal', dueDate, completedOn, createdOn,
      nextAction: task.nextAction || '', comments: task.comments || task.managerComment || '', evidenceLink: task.evidenceLink || '',
      doneWeek, overdueNow, blocked, dueWeek: within(dueDate, monday, sunday), timeMs: time?.totalMs || 0
    };
    group.tasks.push(item);
    group.assigned++;
    if (item.dueWeek) group.due++;
    if (doneWeek) group.completed++;
    if (isComplete(task)) group.currentlyDone++;
    if (!isClosed(task)) group.open++;
    if (overdueNow) group.overdue++;
    if (blocked) group.blocked++;
    if (item.evidenceLink) group.evidence++;
  }

  // Hour totals are attributed to the person who used the timer, even after a task is reassigned.
  for (const [taskId, time] of timeByTask) {
    const task = (db.tasks || []).find(t => String(t.id) === taskId);
    if (projectSelection !== 'all' && String(task?.projectId) !== projectSelection) continue;
    for (const [uid, ms] of time.users) {
      if (!admin && uid !== String(viewer.id)) continue;
      if (admin && selection !== 'all' && uid !== selection) continue;
      const u = ids.get(uid);
      if (!u || isExcludedFromDeliverables(u)) continue;
      const row = ensureRow(uid, u.displayName || u.username, u.role, uid);
      row.hoursMs += ms;
    }
  }
  const people = [...records.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const person of people) {
    person.tasks.sort((a,b) => Number(b.overdueNow) - Number(a.overdueNow) || Number(b.blocked) - Number(a.blocked) || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')) || String(a.id).localeCompare(String(b.id)));
    person.completionRate = person.assigned ? Math.round(person.currentlyDone / person.assigned * 100) : 0;
  }
  const totals = { assigned: 0, due: 0, completed: 0, currentlyDone: 0, open: 0, overdue: 0, blocked: 0, evidence: 0, hoursMs: 0 };
  for (const person of people) for (const key of Object.keys(totals)) totals[key] += person[key];
  return { monday, sunday, generatedAt: new Date(nowMs).toISOString(), project: projectSelection, employee: admin ? selection : String(viewer.id), people, totals, scopeNote: 'Tasks due, created, updated or completed within the week; timer activity during the week; plus open overdue carryovers. Statuses reflect the live PMS at export time.' };
}

// No external runtime dependency. Generates standard PDF 1.4 with built-in fonts.
function pdfEscape(value) {
  return String(value ?? '').replace(/[\u2018\u2019]/g,"'").replace(/[\u201C\u201D]/g,'"').replace(/[\u2013\u2014]/g,'-').replace(/\u2022/g,'-').replace(/\u20A6/g,'NGN ').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7e]/g,'?').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
}
function plainText(value) { return pdfEscape(value).replace(/\\([()\\])/g,'$1'); }
function wrap(value, maxChars) {
  const words = plainText(value).split(/\s+/).filter(Boolean); const lines=[]; let line='';
  for (const word of words) {
    if (word.length > maxChars) {
      if (line) {lines.push(line);line='';}
      for(let i=0;i<word.length;i+=maxChars) lines.push(word.slice(i,i+maxChars));
    } else if (!line) line=word;
    else if ((line+' '+word).length<=maxChars) line+=' '+word;
    else {lines.push(line);line=word;}
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}
class PdfDocument {
  constructor() { this.pages=[]; this.page=null; this.y=0; this.nextPage(); }
  nextPage() { this.page=[];this.pages.push(this.page);this.y=0;this.rect(0,0,595,842,'1 1 1');this.rect(0,0,595,9,'.15 .36 .23'); this.text('OA',44,32,14,true,'0.15 0.36 0.23');this.text('OLUTECH AGRO  /  OPERATIONS REPORT',80,32,8,true,'.35 .40 .38');this.line(44,56,551,56,'.80 .84 .79');this.y=75; }
  rect(x,y,w,h,color) { this.page.push(`${color} rg ${x} ${842-y-h} ${w} ${h} re f`); }
  line(x1,y1,x2,y2,color='.8 .84 .78') { this.page.push(`${color} RG 0.6 w ${x1} ${842-y1} m ${x2} ${842-y2} l S`); }
  text(s,x,y,size=10,bold=false,color='.12 .18 .14') { this.page.push(`BT /${bold?'F2':'F1'} ${size} Tf ${color} rg 1 0 0 1 ${x} ${842-y-size} Tm (${pdfEscape(s)}) Tj ET`); }
  ensure(height=40) { if (this.y+height>780) this.nextPage(); }
  heading(s,size=15) {this.ensure(38);this.text(s,44,this.y,size,true,'.15 .36 .23');this.y+=size+12;}
  paragraph(text,size=9,muted=true) {const max=Math.floor(500/(size*0.59));const ls=wrap(text,max);for(const l of ls){this.ensure(size+5);this.text(l,44,this.y,size,false,muted?'.37 .42 .38':'.15 .20 .16');this.y+=size+5;}this.y+=5;}
  divider(){this.ensure(15);this.line(44,this.y,551,this.y);this.y+=12;}
  finish(){
    const count=this.pages.length;
    this.pages.forEach((p,i)=>{ p.push(`.65 .71 .67 RG 0.6 w 44 45 m 551 45 l S`);p.push(`BT /F1 8 Tf .35 .4 .37 rg 1 0 0 1 44 30 Tm (INTERNAL - Generated ${pdfEscape(new Date().toISOString().slice(0,10))}) Tj ET`);p.push(`BT /F1 8 Tf .35 .4 .37 rg 1 0 0 1 494 30 Tm (Page ${i+1} of ${count}) Tj ET`);});
    const n=this.pages.length;const objects=[];
    function put(id,value){objects[id]=Buffer.isBuffer(value)?value:Buffer.from(value,'latin1');}
    put(1,'<< /Type /Catalog /Pages 2 0 R >>');
    put(2,`<< /Type /Pages /Kids [${this.pages.map((_,i)=>`${5+i*2} 0 R`).join(' ')}] /Count ${n} >>`);
    put(3,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    put(4,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
    this.pages.forEach((commands,i)=>{
      const pid=5+i*2,cid=6+i*2;
      put(pid,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cid} 0 R >>`);
      const zipped=zlib.deflateSync(Buffer.from(commands.join('\n'),'latin1'));
      put(cid,Buffer.concat([Buffer.from(`<< /Length ${zipped.length} /Filter /FlateDecode >>\nstream\n`,'latin1'),zipped,Buffer.from('\nendstream','latin1')]));
    });
    const chunks=[Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n','latin1')], offsets=[0];let offset=chunks[0].length;
    for(let id=1;id<objects.length;id++){
      const b=Buffer.concat([Buffer.from(`${id} 0 obj\n`,'latin1'),objects[id],Buffer.from('\nendobj\n','latin1')]);offsets[id]=offset;chunks.push(b);offset+=b.length;
    }
    const startxref=offset;
    const rows=['xref',`0 ${objects.length}`,'0000000000 65535 f ',...offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ')];
    chunks.push(Buffer.from(rows.join('\n')+`\ntrailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`,'latin1'));
    return Buffer.concat(chunks);
  }
}
function renderWeeklyPdf(report) {
  const p = new PdfDocument();
  p.text('WEEKLY DELIVERABLES REPORT',44,p.y,22,true,'.13 .33 .21');p.y+=38;
  p.text(`${prettyDate(report.monday)} - ${prettyDate(report.sunday)}`,44,p.y,12,true);p.y+=22;
  p.text(`Generated: ${report.generatedAt.slice(0,16).replace('T',' ')} UTC    |    Scope: ${report.employee==='all'?'All employees':'Selected employee'}`,44,p.y,9,false,'.42 .47 .43');p.y+=24;
  const stats=[['DELIVERABLES',report.totals.assigned],['COMPLETED IN WEEK',report.totals.completed],['OPEN NOW',report.totals.open],['OVERDUE NOW',report.totals.overdue]];
  stats.forEach(([label,val],i)=>{let x=44+i*129; p.rect(x,p.y,120,65,'.94 .97 .93');p.text(String(val),x+12,p.y+9,23,true,'.16 .39 .25');p.text(label,x+12,p.y+42,8,true,'.34 .42 .35');});p.y+=88;
  p.text(`Blocked now: ${report.totals.blocked}     Due this week: ${report.totals.due}     Time logged: ${formatHours(report.totals.hoursMs)} h     With evidence: ${report.totals.evidence}`,44,p.y,9,true);p.y+=26;
  p.heading('Employee scorecard',14);
  const widths=[160,45,44,47,47,49,58,57], heads=['EMPLOYEE','TASKS','DUE','DONE WK','OPEN','LATE','HOURS','DONE %'];
  function scoreHeader(){p.ensure(31);p.rect(44,p.y,507,26,'.16 .36 .23');let x=48;heads.forEach((v,i)=>{p.text(v,x,p.y+8,7,true,'1 1 1');x+=widths[i];});p.y+=27;}
  scoreHeader();
  for (const [index,person] of report.people.entries()) {
    if(p.y+31>765){p.nextPage();p.heading('Employee scorecard (continued)',14);scoreHeader();}
    if(index%2===0)p.rect(44,p.y,507,29,'.96 .97 .95');
    const values=[person.name,person.assigned,person.due,person.completed,person.open,person.overdue,formatHours(person.hoursMs),person.completionRate+'%'];
    let x=48;values.forEach((v,i)=>{const arr=wrap(String(v),i===0?25:11);p.text((i===0?arr[0].slice(0,24):v),x,p.y+9,8,i===0);x+=widths[i];});p.y+=29;
  }
  if(!report.people.length){p.text('No employees found for this selection.',52,p.y+8,9);p.y+=29;}
  p.y+=23;p.heading('Report definition',12);p.paragraph(report.scopeNote,8);p.paragraph('DONE WK requires an actual completion date in the selected week. Current status is shown as of report generation. Past weeks are not frozen historical snapshots.',8);
  p.nextPage();p.heading('Deliverables by employee',18);
  for(const person of report.people){
    p.ensure(115);
    p.rect(44,p.y,507,38,'.91 .95 .90');p.text(person.name,54,p.y+7,12,true,'.14 .34 .21');p.text(`${person.role || 'Team Member'}    |    ${person.assigned} deliverables    |    ${person.completed} completed in week    |    ${formatHours(person.hoursMs)} h`,54,p.y+24,8);p.y+=50;
    if(!person.tasks.length){p.text('No deliverables recorded for the selected week.',54,p.y,9,false,'.45 .48 .45');p.y+=28;continue;}
    for (const task of person.tasks){
      const title=wrap(`${task.id}  ${task.title}`,77);
      const action=task.nextAction ? wrap(`Next action: ${task.nextAction}`,89) : [];
      const note=task.comments ? wrap(`Work notes: ${task.comments}`,89) : [];
      const evidence=task.evidenceLink ? wrap(`Evidence: ${task.evidenceLink}`,89) : [];
      const need=title.length*13+19+(action.length+note.length+evidence.length)*11+18;
      if(p.y+Math.min(need,90)>774){p.nextPage();p.heading('Deliverables by employee (continued)',15);p.text(person.name,44,p.y,10,true);p.y+=24;}
      title.forEach((l,i)=>{p.ensure(20);p.text(l,50,p.y,10,i===0,'.15 .25 .18');p.y+=13;});
      p.ensure(22);p.text(`${task.project.slice(0,52)}    |    Due: ${prettyDate(task.dueDate)}    |    ${task.status}    |    ${formatHours(task.timeMs)} h`,50,p.y+2,8,false,'.40 .44 .40');p.y+=18;
      for (const chunk of [action,note,evidence]) for (const line of chunk) {p.ensure(16);p.text(line,50,p.y,8,false,'.37 .43 .38');p.y+=11;}
      p.y+=10;p.divider();
    }
    p.y+=8;
  }
  return p.finish();
}
module.exports={buildWeeklyReport,renderWeeklyPdf,weekMonday,formatHours,prettyDate,isExcludedFromDeliverables};
