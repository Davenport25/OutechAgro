'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

(async function () {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'olutech-pms-reset-'));
  const dbFile = path.join(temp, 'db.json');
  const port = await new Promise((resolve, reject) => {
    const socket = net.createServer(); socket.on('error', reject);
    socket.listen(0,'127.0.0.1',() => {const p=socket.address().port; socket.close(()=>resolve(p));});
  });
  const env = {...process.env, PORT:String(port), OLUTECH_DATA_DIR:temp, OLUTECH_DB_FILE:dbFile, VERCEL:'', KV_REST_API_URL:'',KV_REST_API_TOKEN:'',UPSTASH_REDIS_REST_URL:'',UPSTASH_REDIS_REST_TOKEN:''};
  const child = spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let logs = ''; child.stderr.on('data',d => logs += d); child.stdout.on('data',d => logs += d);
  const base=`http://127.0.0.1:${port}`;
  const request=(url,opt={})=>fetch(base+url,{redirect:'manual',...opt});
  const data=()=>JSON.parse(fs.readFileSync(dbFile,'utf8'));
  const form=(obj)=>new URLSearchParams(obj).toString();
  const post=(route,cookie,obj)=>request(route,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded',Origin:base},body:form(obj)});
  const get=(route,cookie)=>request(route,{headers:{Cookie:cookie}});
  try {
    for(let i=0;i<100;i++){try{const r=await request('/login');if(r.status===200)break;}catch(_){}await new Promise(r=>setTimeout(r,75));}
    assert.deepEqual(data().projects,[],'clean seed: projects');
    assert.deepEqual(data().tasks,[],'clean seed: tasks');
    assert.deepEqual(data().approvals,[],'clean seed: approvals');
    assert.deepEqual(data().delays,[],'clean seed: delays');
    assert.deepEqual(data().nxpChecklist,[],'clean seed: NXP checklist');
    const signIn=async(email,password)=>{
      const r=await request('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form({email,password})});
      assert.equal(r.status,302,await r.text());
      return r.headers.get('set-cookie').split(';')[0];
    };
    const admin=await signIn('admin@olutechagro.com','admin123');
    const worker=await signIn('dipo@olutechagro.com','olutech123');
    const original=data();
    original.projects=[{id:'P-1',name:'Original Project',owner:'DIPO',status:'Active'}];
    original.tasks=[{id:'T-1',projectId:'P-1',title:'Original Task',status:'Not Started',assignedTo:'DIPO'}];
    original.approvals=[{id:'AP-1',projectId:'P-1',item:'Payment',status:'Pending'}];
    original.delays=[{id:'D-1',projectId:'P-1',description:'Waiting',status:'Open'}];
    original.nxpChecklist=[{id:'N-1',projectId:'P-1',item:'NXP item',migratedToTaskId:'T-1'}];
    original.projectHandoffs=[{id:'H-1',projectId:'P-1'}];
    original.taskTimeEntries=[{id:'TM-1',taskId:'T-1',userId:'worker-id',startedAt:'2026-11-01T09:00:00.000Z',stoppedAt:'2026-11-01T10:00:00.000Z'}];
    original.chatMessages=[{id:'CH-1',targetType:'project',targetId:'P-1',message:'Old message',author:'DIPO'}];
    original.risks=[{id:'R-1',projectId:'P-1',description:'Risk for old project'},{id:'R-2',description:'Unrelated historical risk'}];
    const unchangedFiles=JSON.stringify(original.files);
    const unchangedUsers=JSON.stringify(original.users);
    const unchangedActions=JSON.stringify(original.actions);
    fs.writeFileSync(dbFile,JSON.stringify(original));
    let r=await get('/storage-status',admin);
    assert.equal(r.status,200);
    assert.match(await r.text(),/Start Fresh — Operational Records/);
    r=await get('/admin/operations-backup',worker);assert.equal(r.status,403,'backup requires Level 5');
    r=await get('/admin/operations-backup',admin);assert.equal(r.status,200,'backup accessible to Level 5');
    assert.match(r.headers.get('content-disposition')||'',/attachment/);
    const downloaded=await r.json();assert.equal(downloaded.projects[0].id,'P-1');
    r=await post('/admin/operations-reset',worker,{confirmation:'RESET OPERATIONS',password:'olutech123',acknowledged:'yes'});
    assert.equal(r.status,403,'ordinary users cannot reset');
    r=await post('/admin/operations-reset',admin,{confirmation:'wrong',password:'admin123',acknowledged:'yes'});
    assert.equal(r.status,400,'wrong phrase refused'); assert.equal(data().projects.length,1);
    r=await post('/admin/operations-reset',admin,{confirmation:'RESET OPERATIONS',password:'not-correct',acknowledged:'yes'});
    assert.equal(r.status,400,'wrong password refused'); assert.equal(data().projects.length,1);
    r=await post('/admin/operations-reset',admin,{confirmation:'RESET OPERATIONS',password:'admin123',acknowledged:'yes'});
    const finishHtml=await r.text();
    assert.equal(r.status,200,finishHtml);
    assert.match(finishHtml,/Fresh start completed/);
    const cleared=data();
    for(const k of ['projects','tasks','approvals','delays','nxpChecklist','projectHandoffs','taskTimeEntries','chatMessages']) assert.deepEqual(cleared[k],[],`${k} cleared`);
    assert.deepEqual(cleared.risks,[{id:'R-2',description:'Unrelated historical risk'}]);
    assert.equal(JSON.stringify(cleared.users),unchangedUsers,'users preserved');
    assert.equal(JSON.stringify(cleared.files),unchangedFiles,'files preserved');
    assert.equal(JSON.stringify(cleared.actions),unchangedActions,'retired action records preserved');
    const backupDir=path.join(temp,'backups');
    const backups=fs.readdirSync(backupDir).filter(name=>name.endsWith('.json'));
    assert.equal(backups.length,1,'one verified backup');
    const restored=JSON.parse(fs.readFileSync(path.join(backupDir,backups[0])));
    assert.equal(restored.projects.length,1,'backup contains project');
    assert.equal(restored.tasks.length,1,'backup contains task');
    r=await get('/dashboard',admin);assert.equal(r.status,200);
    assert.deepEqual(data().tasks,[],'tasks do not regenerate');
    console.log('PASS: local reset, permission, backup, data retention, and no-regeneration checks');
  } catch(e){ console.error('RESET TEST FAILED',e,'\nServer logs:',logs.slice(-2500)); process.exitCode=1; }
  finally {child.kill('SIGTERM'); await new Promise(resolve=>child.once('close',resolve));fs.rmSync(temp,{recursive:true,force:true});}
})();
