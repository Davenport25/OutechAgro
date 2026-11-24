'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

(async function () {
  const appRoot = path.resolve(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olutech-pms-test-'));
  const dbFile = path.join(tmp, 'db.json');
  const port = await new Promise((resolve, reject) => { const socket = net.createServer(); socket.once('error', reject); socket.listen(0, '127.0.0.1', () => { const p=socket.address().port; socket.close(() => resolve(p)); }); });
  const env = { ...process.env, PORT:String(port), OLUTECH_DATA_DIR:tmp, OLUTECH_DB_FILE:dbFile, VERCEL:'', KV_REST_API_URL:'',KV_REST_API_TOKEN:'',UPSTASH_REDIS_REST_URL:'',UPSTASH_REDIS_REST_TOKEN:'' };
  const child = spawn(process.execPath, [path.join(appRoot,'server.js')], { cwd:appRoot, env, stdio:['ignore','pipe','pipe'] });
  let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  const base = `http://127.0.0.1:${port}`;
  const stats = [];
  function ok(label, value) { assert(value, label); stats.push(label); }
  async function request(uri, opts={}) { return fetch(base+uri, {redirect:'manual', ...opts}); }
  function form(obj){return new URLSearchParams(obj).toString();}
  function headers(cookie){return {'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie};}
  async function signIn(email,password) { const r=await request('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form({email,password})}); assert.equal(r.status,302,await r.text()); const c=(r.headers.get('set-cookie')||'').split(';')[0]; assert.match(c,/session=/); return c; }
  async function get(uri,cookie){const r=await request(uri,{headers:{Cookie:cookie}});const text=await r.text();return {status:r.status,text,headers:r.headers};}
  async function post(uri,cookie,obj) {return request(uri,{method:'POST',headers:headers(cookie),body:form(obj)});}
  try {
    for (let i=0;i<100;i++){ try { const r=await request('/login'); if(r.status===200)break; }catch(_){} await new Promise(r=>setTimeout(r,60)); }
    // Test fixture is inserted into an isolated temp database; shipping seed remains EMPTY.
    const fixture=JSON.parse(fs.readFileSync(dbFile,'utf8'));
    assert.equal(fixture.projects.length,0);
    assert.equal(fixture.tasks.length,0);
    fixture.projects.push({id:'SMOKE-PROJECT-01',name:'Temporary Integration Project',owner:'DIPO',priority:'High',status:'Active',workflowEnabled:false});
    fixture.tasks.push({id:'SMOKE-TASK-01',projectId:'SMOKE-PROJECT-01',projectName:'Temporary Integration Project',title:'Temporary smoke-test assignment',assignedTo:'DIPO',assignedBy:'ONAOPE',priority:'Medium',status:'In Progress',progress:0.3,workflowManaged:false});
    fs.writeFileSync(dbFile,JSON.stringify(fixture));
    const admin=await signIn('admin@olutechagro.com','admin123');
    let r=await get('/dashboard',admin); ok('dashboard works',r.status===200 && r.text.includes('Weekly Operations Dashboard'));
    ok('professional navigation and account header rendered',r.text.includes('class="sidebar-section"') && r.text.includes('class="user-avatar"') && r.text.includes('class="page-context"'));
    ok('mobile menu and responsive navigation controls present',r.text.includes('aria-controls="mainSidebar"') && r.text.includes('function toggleOlutechNav(force)'));
    ok('UI stylesheet linked without removing original styles',r.text.includes('/public/styles.css') && r.text.includes('/public/interface.css'));
    const uiCss=await request('/public/interface.css'); const uiCssText=await uiCss.text();
    ok('professional UI stylesheet serves successfully',uiCss.status===200 && uiCssText.includes('Professional Workspace UI') && uiCssText.includes('.sidebar .sidebar-section a.active'));
    ok('new dark mode and responsive overrides available',uiCssText.includes('html[data-theme="dark"]') && uiCssText.includes('@media (max-width:980px)'));
    ok('risk / action / standalone files navigation removed',!r.text.includes('href="/risks"') && !r.text.includes('href="/actions"') && !r.text.includes('href="/files"'));
    r=await get('/projects',admin); ok('projects live with top-level deletion',r.status===200 && r.text.includes('id="bulkProjects"'));
    ok('project sponsor/category/phase inputs removed',!r.text.includes('name="sponsor"') && !r.text.includes('name="category"') && !r.text.includes('name="phase"'));
    r=await get('/tasks',admin); ok('tasks default to open with separate closed tab',r.status===200 && r.text.includes('Open Tasks') && r.text.includes('href="/tasks?view=closed"') && !r.text.includes('<h2>Closed Tasks</h2>'));
    ok('task timers, task workspace links, visible delete action and bulk delete',r.text.includes('Task Timer') && r.text.includes('href="/tasks/view?id=SMOKE-TASK-01&amp;tab=files"') && r.text.includes('Delete Task') && r.text.includes('id="bulkTasks"'));
    ok('open tasks no longer says level 2+',r.text.includes('<summary>Create Task</summary>') && !r.text.includes('Create assigned task - Level 2+'));
    r=await get('/files',admin); ok('old Files link redirects to Tasks',r.status===302 && r.headers.get('location')==='/tasks?view=open');
    r=await get('/tasks?view=closed',admin); ok('closed tasks only on click',r.text.includes('Closed Tasks') && !r.text.includes('<h2>Open Tasks</h2>'));
    r=await get('/actions',admin); ok('legacy actions retired',r.status===410);
    r=await get('/risks',admin); ok('legacy risks retired',r.status===410);
    r=await get('/attendance',admin); ok('attendance has employee selector and 9-to-6 automatic notice',r.text.includes('name="employee"') && r.text.includes('9:00 AM to 6:00 PM') && r.text.includes('30 minutes after clock-in'));
    const db=()=>JSON.parse(fs.readFileSync(dbFile,'utf8'));
    const dipo=db().users.find(u=>u.displayName==='DIPO'); assert(dipo);
    let u=await post('/admin/user-update',admin,{id:dipo.id,displayName:'DIPO EDITED',email:'dipo.edited@olutechagro.com',role:'Export Supervisor',clearance:'2',accountEnabled:'false'}); assert.equal(u.status,200,await u.text());
    let updated=db(); const edited=updated.users.find(u=>u.id===dipo.id);
    ok('user edit persists new identity and disabled status',edited.displayName==='DIPO EDITED' && edited.email==='dipo.edited@olutechagro.com' && edited.accountEnabled===false);
    ok('updated name propagates to tasks/projects',updated.tasks.some(t=>t.assignedTo==='DIPO EDITED') && updated.projects.some(p=>p.owner==='DIPO EDITED'));
    r=await get('/projects',admin); ok('updated project owner visible on reload',r.text.includes('DIPO EDITED'));
    r=await get('/tasks',admin); ok('updated task role visible on reload',r.text.includes('Export Supervisor'));
    updated=db(); ok('edited user not recreated from old seed',!updated.users.some(u=>u.id!==dipo.id && u.displayName==='DIPO'));
    u=await post('/preferences/theme',admin,{theme:'dark',returnTo:'/projects'}); ok('theme updates via page selector',u.status===302 && u.headers.get('location')==='/projects');
    r=await get('/projects',admin);ok('dark preference persists per account',r.text.includes('data-theme="dark"'));
    const newUser=await post('/admin/user-new',admin,{displayName:'TEST STAFF',email:'test.staff@olutechagro.com',role:'Tester',clearance:'1',accountEnabled:'true',password:'TestStrong#87'}); assert.equal(newUser.status,200,await newUser.text());
    const low=await signIn('test.staff@olutechagro.com','TestStrong#87');
    r=await get('/tasks',low);ok('level 1 can create task',r.text.includes('<summary>Create Task</summary>'));
    const projectId=db().projects[0].id;
    u=await post('/tasks/new',low,{projectId,assignedTo:'TEST STAFF',title:'SMOKE TEST TASK',priority:'Medium',status:'Not Started'}); assert.equal(u.status,302,await u.text());
    let created=db().tasks.find(t=>t.title==='SMOKE TEST TASK');ok('level 1 task persisted',!!created && created.assignedByUserId===db().users.find(u=>u.displayName==='TEST STAFF').id);
    r=await get('/tasks',low);ok('new task visible to level 1',r.text.includes('SMOKE TEST TASK'));
    // Task files can be uploaded by task participants; others cannot read them.
    const attachment = new FormData();
    attachment.append('taskId',created.id);
    attachment.append('title','Task evidence document');
    attachment.append('requiredClearance','1');
    attachment.append('file',new Blob(['sample task evidence'],{type:'text/plain'}),'evidence.txt');
    u=await request('/files/upload',{method:'POST',headers:{Cookie:low},body:attachment});
    ok('task file upload returns to task files tab',u.status===302 && u.headers.get('location')===`/tasks/view?id=${created.id}&tab=files`);
    const uploaded=db().files.find(f=>f.taskId===created.id && f.originalName==='evidence.txt');
    ok('task file is linked and persisted',uploaded && uploaded.uploadedByUserId===db().users.find(x=>x.displayName==='TEST STAFF').id && uploaded.contentBase64);
    r=await get(`/tasks/view?id=${created.id}&tab=files`,low);ok('attachment appears inside this task files tab',r.status===200 && r.text.includes('Task evidence document') && r.text.includes('Files &amp; Evidence (1)') && r.text.includes('class="task-workspace-tabs"'));
    r=await get(`/tasks/view?id=${created.id}&tab=comments`,low);ok('task comments are a peer tab to files',r.status===200 && r.text.includes('Task Comments') && r.text.includes('href="/tasks/view?id=') && r.text.includes('Comments'));
    r=await get('/tasks',low);ok('task list has separate task-specific Comments and Files actions',r.text.includes(`/tasks/view?id=${created.id}&amp;tab=comments`) && r.text.includes(`/tasks/view?id=${created.id}&amp;tab=files`) && !r.text.includes('Task evidence document'));
    u=await post('/chat/new',low,{targetType:'task',targetId:created.id,message:'Verified the attached task evidence',returnTo:`/tasks/view?id=${created.id}&tab=comments`});ok('task comment returns to its task workspace',u.status===302 && u.headers.get('location')===`/tasks/view?id=${created.id}&tab=comments`);
    r=await get(`/tasks/view?id=${created.id}&tab=comments`,low);ok('comments persist on the same task workspace',r.text.includes('Verified the attached task evidence'));
    const raw=await request('/files/download/'+uploaded.id,{headers:{Cookie:low}});
    ok('task participant can download attachment',raw.status===200 && (await raw.text())==='sample task evidence');
    const outsider=await signIn('onaope@olutechagro.com','olutech123');
    const denied=await request('/files/download/'+uploaded.id,{headers:{Cookie:outsider}});
    ok('other employee cannot download hidden task file',denied.status===403);
    r=await get(`/tasks/view?id=${created.id}&tab=files`,outsider);ok('unassigned employee cannot open a hidden task workspace',r.status===403);
    // Timer start and stop; user-specific, persisted in DB.
    u=await post('/tasks/timer/start',low,{id:created.id}); assert.equal(u.status,302,await u.text());
    ok('timer start is persisted',db().taskTimeEntries.some(t=>t.taskId===created.id && !t.stoppedAt));
    u=await post('/tasks/timer/stop',low,{id:created.id}); assert.equal(u.status,302,await u.text());
    ok('timer stop creates durable entry',db().taskTimeEntries.some(t=>t.taskId===created.id && t.stoppedAt));
    // Individual delete is visible at top-level and logs the reason; only authorized employees may use it.
    u=await post('/tasks/new',low,{projectId,assignedTo:'TEST STAFF',title:'TASK CREATED BY MISTAKE',priority:'Low',status:'Not Started'});assert.equal(u.status,302);
    const mistaken=db().tasks.find(t=>t.title==='TASK CREATED BY MISTAKE');assert(mistaken);
    r=await get('/tasks',low);ok('individual Delete Task action visible without opening Update Task',r.text.includes('Delete Task') && r.text.includes('Created in error'));
    u=await post('/tasks/delete',outsider,{id:mistaken.id,reason:'Created in error'});ok('unrelated employee cannot delete another task',u.status===403 && db().tasks.some(t=>t.id===mistaken.id));
    u=await post('/tasks/delete',low,{id:mistaken.id,reason:'Created in error',view:'open'});ok('individual delete removes only selected task',u.status===302 && !db().tasks.some(t=>t.id===mistaken.id) && db().tasks.some(t=>t.id===created.id));
    ok('individual deletion has an audit reason',db().auditLog.some(a=>a.action==='task_delete' && a.details.includes('Created in error')));
    // Ordinary employee cannot delete a task belonging to another employee.
    u=await post('/tasks/delete-selected',low,{ids:db().tasks.find(t=>t.assignedTo==='DIPO EDITED').id}); ok('bulk delete obeys permissions',u.status===403);
    u=await post('/tasks/delete-selected',low,{ids:created.id,view:'open'}); assert.equal(u.status,302,await u.text());
    ok('task bulk deletion removes task but preserves time audit',!db().tasks.some(t=>t.id===created.id) && db().taskTimeEntries.some(t=>t.taskId===created.id));
    r=await get('/tasks',low);ok('task deletion preserves file as unassigned',r.text.includes('Existing unassigned files') && db().files.some(f=>f.id===uploaded.id && !f.taskId));
    const orphanDenied=await request('/files/download/'+uploaded.id,{headers:{Cookie:outsider}}); ok('orphaned task file retains confidentiality',orphanDenied.status===403);
    r=await get('/tasks',low);
    ok('unassigned files expose direct delete to authorised uploader',r.text.includes('Existing unassigned files') && r.text.includes(`aria-label="Delete unassigned file Task evidence document"`));
    r=await get('/tasks',outsider);
    ok('unassigned file remains invisible to other employees',!r.text.includes('aria-label="Delete unassigned file Task evidence document"'));
    u=await post('/files/delete',outsider,{id:uploaded.id});
    ok('unrelated employee cannot delete unassigned file',u.status===403 && db().files.some(f=>f.id===uploaded.id));
    u=await post('/files/delete',low,{id:uploaded.id});
    ok('direct delete removes only selected unassigned file',u.status===302 && u.headers.get('location')==='/tasks?view=open' && !db().files.some(f=>f.id===uploaded.id));
    ok('unassigned file deletion is audited',db().auditLog.some(a=>a.action==='file_delete' && a.details.includes(uploaded.id)));
    // Project bulk delete must protect linked projects.
    u=await post('/projects/delete-selected',admin,{ids:projectId});ok('project bulk delete protects dependencies',u.status===400);
    u=await post('/projects/new',admin,{name:'TEST NO WORKFLOW PROJECT',projectMode:'standard',owner:'TEST STAFF',priority:'Low'}); assert.equal(u.status,302,await u.text());
    let np=db().projects.find(p=>p.name==='TEST NO WORKFLOW PROJECT');ok('new project has no sponsor/category/phase',np && !np.sponsor && !np.category && !np.phase);
    u=await post('/projects/delete-selected',admin,{ids:np.id});assert.equal(u.status,302,await u.text());
    ok('top-level project deletion works',!db().projects.some(p=>p.id===np.id));
    // Automatic rules: before 6 PM -> 6 PM; at/after 6 PM -> 30 minutes after clock-in.
    u=await post('/attendance/clock-in',low,{notes:'smoke'});assert.equal(u.status,200,await u.text());
    let attend=db().attendance.find(a=>a.userId===db().users.find(x=>x.displayName==='TEST STAFF').id && !a.clockOutAt);assert(attend);
    let altered=db();let old=altered.attendance.find(a=>a.id===attend.id);old.clockInAt='2026-10-10T08:00:00.000Z';old.workDate='2026-10-10';fs.writeFileSync(dbFile,JSON.stringify(altered));
    r=await get('/attendance',low);
    const after6=db().attendance.find(a=>a.id===attend.id);
    ok('before-6 PM clock-in automatically ends at 18:00 Lagos',after6.clockOutAt==='2026-10-10T17:00:00.000Z' && after6.autoClockOut);
    u=await post('/attendance/clock-in',low,{notes:'late test'});assert.equal(u.status,200,await u.text());
    altered=db();old=altered.attendance.find(a=>a.userId===db().users.find(x=>x.displayName==='TEST STAFF').id && !a.clockOutAt);assert(old);const lateId=old.id;
    old.clockInAt='2026-10-11T18:15:00.000Z';old.workDate='2026-10-11';fs.writeFileSync(dbFile,JSON.stringify(altered));
    r=await get('/attendance',low);
    const late=db().attendance.find(a=>a.id===lateId);
    ok('after-6 PM clock-in automatically ends after 30 minutes',late.clockOutAt==='2026-10-11T18:45:00.000Z' && late.autoClockOut);
    r=await get('/attendance',admin);const testUid=db().users.find(x=>x.displayName==='TEST STAFF').id;
    r=await get('/attendance?employee='+testUid,admin);ok('admin can view separate employee records',r.text.includes('Attendance Records: TEST STAFF'));
    r=await get('/attendance',low);ok('ordinary employee has only personal records',!r.text.includes('name="employee"'));
    u=await post('/attendance/clock-in',low,{notes:'manual test'});assert.equal(u.status,200,await u.text());
    const manualOpen=db().attendance.find(a=>a.userId===testUid && !a.clockOutAt);assert(manualOpen);
    u=await post('/attendance/clock-out',low,{workSummary:'done'});assert.equal(u.status,200,await u.text());
    ok('early manual clock-out still works',!!db().attendance.find(a=>a.id===manualOpen.id).clockOutAt);
    r=await get('/attendance/pulse',low);ok('attendance heartbeat is authenticated JSON',r.status===200 && JSON.parse(r.text).closed===true);
    r=await get('/dashboard',low);ok('user-specific theme defaults light',r.text.includes('data-theme="light"'));
    r=await get('/public/styles.css',low);ok('stylesheet served with dark theme rules',r.status===200&&r.text.includes('html[data-theme="dark"]'));
    r=await get('/api/index.js?__path=/dashboard',admin);ok('Vercel rewrite path remains supported',r.status===200 && r.text.includes('Weekly Operations Dashboard'));
    ok('dashboard excludes Akin and system administrator from staff tables',!r.text.includes('<td><b>AKIN</b>')&&!r.text.includes('<td><b>System Administrator</b>'));
    r=await get('/kpi',admin);ok('KPI excludes Akin and system admin',!r.text.includes('<td><b>AKIN</b>')&&!r.text.includes('<td><b>System Administrator</b>'));
    r=await get('/tasks',admin);ok('task assignee suggestions exclude Akin',!r.text.includes('<option value="AKIN">') && r.text.includes('<summary>Create Task</summary>'));
    const countBefore=db().tasks.length;
    u=await post('/tasks/new',admin,{projectId,assignedTo:'AKIN',title:'Do not assign task to CEO'});
    ok('server rejects task creation assigned to Akin',u.status===400 && db().tasks.length===countBefore);
    u=await post('/tasks/new',admin,{projectId,assignedTo:'System Administrator',title:'Do not assign task to admin'});
    ok('server rejects task creation assigned to administrator',u.status===400 && db().tasks.length===countBefore);
    const akinLogin=await signIn('akin@olutechagro.com','olutech123');
    r=await get('/dashboard',akinLogin);ok('Akin login and dashboard still work',r.status===200);
    const beforeTaskUpdate=JSON.stringify(db().tasks.find(t=>t.id==='SMOKE-TASK-01'));
    u=await post('/tasks/update',admin,{id:'SMOKE-TASK-01',assignedTo:'AKIN',status:'Completed'});
    ok('reassigning an existing task to Akin is blocked without partial changes',u.status===400 && JSON.stringify(db().tasks.find(t=>t.id==='SMOKE-TASK-01'))===beforeTaskUpdate);
    const projectCount=db().projects.length;
    u=await post('/projects/new',admin,{name:'Disallowed Akin workflow',projectMode:'workflow',stepTitle0:'Approval as task',stepAssignee0:'AKIN'});
    ok('new project workflow cannot assign Akin',u.status===400 && db().projects.length===projectCount);
    u=await post('/workflow/add-step',admin,{projectId,assignedTo:'System Administrator',title:'Admin not deliverable worker'});
    ok('adding new workflow step to System Administrator is blocked',u.status===400 && db().tasks.length===countBefore);
    r=await get('/admin/users',admin);ok('admin and Akin remain manageable user records',r.text.includes('akin@olutechagro.com')&&r.text.includes('admin@olutechagro.com'));
    r=await get('/api/index.js?__path=/tasks/view&id=SMOKE-TASK-01&tab=files',admin);ok('Vercel rewrite supports task files workspace',r.status===200 && r.text.includes('Task Files'));
    console.log(`PASS: ${stats.length} integration checks; isolated database: ${tmp}`);
    for(const t of stats) console.log('  ✓ '+t);
  } catch(e){console.error('SMOKE TEST FAILED',e);console.error('server logs:',logs.slice(-2000));process.exitCode=1;}
  finally{child.kill('SIGTERM'); await new Promise(resolve=>child.once('close',resolve)); fs.rmSync(tmp,{recursive:true,force:true});}
})();
