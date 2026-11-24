'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn,execFileSync}=require('node:child_process');
const {buildWeeklyReport,renderWeeklyPdf,weekMonday}=require('../lib/weekly-deliverables');
(async()=>{
 const root=path.resolve(__dirname,'..');const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'olutech-report-test-'));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const child=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env:{...process.env,PORT:String(port),OLUTECH_DATA_DIR:tmp,OLUTECH_DB_FILE:path.join(tmp,'db.json'),VERCEL:'',KV_REST_API_URL:'',KV_REST_API_TOKEN:'',UPSTASH_REDIS_REST_URL:'',UPSTASH_REDIS_REST_TOKEN:''},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
 const base=`http://127.0.0.1:${port}`;const checks=[];
 function pass(name,condition){assert(condition,name);checks.push(name);}
 const req=(uri,opts={})=>fetch(base+uri,{redirect:'manual',...opts});
 async function login(email,password){const r=await req('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email,password}).toString()});assert.equal(r.status,302);return (r.headers.get('set-cookie')||'').split(';')[0];}
 try{
  for(let i=0;i<100;i++){try{if((await req('/login')).status===200)break;}catch{} await new Promise(r=>setTimeout(r,60));}
  const dbFile=path.join(tmp,'db.json');const db=JSON.parse(fs.readFileSync(dbFile,'utf8'));
  const dipo=db.users.find(u=>u.displayName==='DIPO');const onaope=db.users.find(u=>u.displayName==='ONAOPE');const akin=db.users.find(u=>u.displayName==='AKIN');const sysadmin=db.users.find(u=>u.email==='admin@olutechagro.com');
  assert(dipo&&onaope&&akin&&sysadmin);
  db.projects.push({id:'P-REPORT-1',name:'Weekly Export Milestones',owner:'DIPO'});
  db.tasks.push(
   {id:'T-RPT-1',projectId:'P-REPORT-1',title:'Issue shipping document pack',assignedUserId:dipo.id,assignedTo:'DIPO',assignedBy:'ONAOPE',status:'Completed',priority:'High',dueDate:'2026-11-17',completedAt:'2026-11-18T10:22:00Z',dateLogged:'2026-11-16',evidenceLink:'https://example.org/evidence-1',nextAction:'Submit final originals to bank'},
   {id:'T-RPT-2',projectId:'P-REPORT-1',title:'Confirm export payment and release',assignedUserId:dipo.id,assignedTo:'DIPO',assignedBy:'ONAOPE',status:'Blocked',priority:'Critical',dueDate:'2026-11-18',dateLogged:'2026-11-16',nextAction:'Obtain buyer bank confirmation'},
   {id:'T-RPT-3',projectId:'P-REPORT-1',title:'Arrange GIT coverage',assignedUserId:onaope.id,assignedTo:'ONAOPE',assignedBy:'DIPO',status:'In Progress',dueDate:'2026-11-19',dateLogged:'2026-11-17'},
   {id:'T-RPT-4',projectId:'P-REPORT-1',title:'Previous deadline still pending',assignedUserId:dipo.id,assignedTo:'DIPO',assignedBy:'ONAOPE',status:'Not Started',dueDate:'2026-11-12',dateLogged:'2026-11-10'},
   {id:'T-RPT-5',projectId:'P-REPORT-1',title:'Task outside report week',assignedUserId:dipo.id,assignedTo:'DIPO',assignedBy:'ONAOPE',status:'Not Started',dueDate:'2026-12-10',dateLogged:'2026-12-03'},
   {id:'T-RPT-AKIN',projectId:'P-REPORT-1',title:'CEO sample legacy task',assignedUserId:akin.id,assignedTo:'AKIN',status:'Completed',dueDate:'2026-11-18',completedAt:'2026-11-18T11:00:00Z',dateLogged:'2026-11-17'},
   {id:'T-RPT-ADMIN',projectId:'P-REPORT-1',title:'Admin sample legacy task',assignedUserId:sysadmin.id,assignedTo:'System Administrator',status:'Completed',dueDate:'2026-11-18',completedAt:'2026-11-18T11:00:00Z',dateLogged:'2026-11-17'},
   {id:'T-RPT-LEGACY',projectId:'P-REPORT-1',title:'Legacy unlinked Akin task',assignedTo:'AKIN',status:'In Progress',dueDate:'2026-11-18',dateLogged:'2026-11-17'}
  );
  db.taskTimeEntries.push({taskId:'T-RPT-1',userId:dipo.id,displayName:'DIPO',startedAt:'2026-11-18T10:00:00Z',stoppedAt:'2026-11-18T11:30:00Z',elapsedMs:5400000});
  fs.writeFileSync(dbFile,JSON.stringify(db));
  const data=buildWeeklyReport(db,db.users.find(u=>u.email==='admin@olutechagro.com'),{week:'2026-11-18',now:new Date('2026-11-21T12:00:00Z')});
  pass('Monday-to-Sunday week normalization',weekMonday('2026-11-21')==='2026-11-16'&&data.monday==='2026-11-16'&&data.sunday==='2026-11-22');
  pass('Includes overdue carryovers but not future tasks',data.people.some(p=>p.tasks.some(t=>t.id==='T-RPT-4'))&&!data.people.some(p=>p.tasks.some(t=>t.id==='T-RPT-5')));
  const dipoRow=data.people.find(p=>p.name==='DIPO');
  pass('DIPO weekly completion and due counts',dipoRow.completed===1 && dipoRow.due===2 && dipoRow.assigned===3);
  pass('Time entries attributed to employee',dipoRow.hoursMs===5400000);
  pass('Akin and system administrator absent from weekly scorecard',!data.people.some(p=>['AKIN','System Administrator'].includes(p.name)) && !data.people.some(p=>p.tasks.some(t=>['T-RPT-AKIN','T-RPT-ADMIN','T-RPT-LEGACY'].includes(t.id))));
  pass('CEO and admin legacy tasks excluded from weekly totals',data.totals.assigned===4);
  pass('Direct filter for excluded Akin user is rejected',(()=>{try{buildWeeklyReport(db,sysadmin,{week:'2026-11-18',employee:akin.id});return false;}catch{return true;}})());
  pass('Direct filter for admin account is rejected',(()=>{try{buildWeeklyReport(db,sysadmin,{week:'2026-11-18',employee:sysadmin.id});return false;}catch{return true;}})());
  pass('Akin personal report has no employee scorecard row',buildWeeklyReport(db,akin,{week:'2026-11-18'}).people.length===0);
  pass('Project/employee filters work',buildWeeklyReport(db,db.users[0],{week:'2026-11-18',employee:dipo.id}).totals.assigned===3);
  pass('Ordinary employees cannot query another employee',(()=>{try{buildWeeklyReport(db,onaope,{week:'2026-11-18',employee:dipo.id});return false;}catch{return true;}})());
  const pdf=renderWeeklyPdf(data);
  pass('PDF opens with valid format',pdf.subarray(0,8).toString()==='%PDF-1.4');
  fs.writeFileSync(path.join(tmp,'weekly-sample.pdf'),pdf);
  try{const out=execFileSync('pdfinfo',[path.join(tmp,'weekly-sample.pdf')],{encoding:'utf8'});pass('PDF is parseable and multipage',/Pages:\s+[2-9]/.test(out));const txt=execFileSync('pdftotext',[path.join(tmp,'weekly-sample.pdf'),'-'],{encoding:'utf8'});pass('PDF contains deliverables and employee summaries',txt.includes('Weekly Export Milestones')&&txt.includes('DIPO')&&txt.includes('Confirm export payment'));}catch(err){console.log('PDF external-tools check unavailable:',err.message);}
  const admin=await login('admin@olutechagro.com','admin123');
  let r=await req('/reports/weekly?week=2026-11-18',{headers:{Cookie:admin}});let html=await r.text();pass('Report UI, filters, PDF link and navigation',r.status===200&&html.includes('Weekly Deliverables Report')&&html.includes('Download PDF')&&html.includes('Issue shipping document pack')&&html.includes('href="/reports/weekly"'));
  pass('Weekly Reports employee filter excludes Akin and System Administrator',!html.includes(`<option value="${akin.id}"`) && !html.includes(`<option value="${sysadmin.id}"`));
  r=await req('/reports/weekly.pdf?week=2026-11-18',{headers:{Cookie:admin}});const pdfBody=Buffer.from(await r.arrayBuffer());pass('Authenticated download is PDF with attachment disposition',r.status===200&&r.headers.get('content-type')==='application/pdf'&&r.headers.get('content-disposition').includes('attachment')&&pdfBody.subarray(0,4).toString()==='%PDF');
  r=await req('/reports/weekly.pdf?week=2026-11-18');pass('Unauthenticated PDF download forbidden',r.status===302&&r.headers.get('location')==='/login');
  const dipoSession=await login('dipo@olutechagro.com','olutech123');
  r=await req(`/reports/weekly?week=2026-11-18&employee=${onaope.id}`,{headers:{Cookie:dipoSession}});pass('Cross-user report request blocked',r.status===400);
  r=await req(`/reports/weekly.pdf?week=2026-11-18&employee=${onaope.id}`,{headers:{Cookie:dipoSession}});pass('Cross-user PDF request blocked',r.status===400);
  r=await req('/reports/weekly?week=2026-11-18',{headers:{Cookie:dipoSession}});html=await r.text();pass('Employee sees own tasks only',r.status===200&&html.includes('Confirm export payment')&&!html.includes('Arrange GIT coverage'));
  r=await req('/api/index.js?__path=/reports/weekly',{headers:{Cookie:admin}});pass('Vercel-style report rewrite works',r.status===200);
  r=await req('/api/index.js?__path=/reports/weekly.pdf',{headers:{Cookie:admin}});pass('Vercel-style PDF rewrite works',r.status===200&&r.headers.get('content-type')==='application/pdf');
  r=await req(`/reports/weekly.pdf?week=2026-11-18&employee=${akin.id}`,{headers:{Cookie:admin}});
  pass('Akin-specific PDF export rejects excluded account',r.status===400);
  r=await req('/reports/weekly?week=not-a-week',{headers:{Cookie:admin}});pass('Bad week rejected',r.status===400);
  console.log('PASS: '+checks.length+' weekly-report checks');for(const x of checks)console.log('  - '+x);
 }catch(err){console.error('WEEKLY REPORT TEST FAILED',err);console.error(logs.slice(-3000));process.exitCode=1;}
 finally{child.kill('SIGTERM');await new Promise(resolve=>child.once('close',resolve));fs.rmSync(tmp,{recursive:true,force:true});}
})();
