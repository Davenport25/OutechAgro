'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
(async()=>{
 const root=path.resolve(__dirname,'..');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'olutech-notify-'));
 const dbFile=path.join(dir,'db.json');
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const child=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env:{...process.env,PORT:String(port),OLUTECH_DATA_DIR:dir,OLUTECH_DB_FILE:dbFile,VERCEL:'',KV_REST_API_URL:'',KV_REST_API_TOKEN:'',UPSTASH_REDIS_REST_URL:'',UPSTASH_REDIS_REST_TOKEN:''},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 const base=`http://127.0.0.1:${port}`;
 const go=(url,opt={})=>fetch(base+url,{redirect:'manual',...opt});
 const form=x=>new URLSearchParams(x).toString();
 const post=(url,cookie,x)=>go(url,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:form(x)});
 const get=(url,cookie)=>go(url,{headers:{Cookie:cookie}});
 const login=async (email,pwd)=>{const r=await post('/login','',{email,password:pwd});assert.equal(r.status,302,await r.text());return (r.headers.get('set-cookie')||'').split(';')[0];};
 const db=()=>JSON.parse(fs.readFileSync(dbFile,'utf8'));
 let checks=0;
 const check=(msg,val)=>{assert(val,msg);checks++;};
 const feed=async cookie=>{const r=await get('/notifications',cookie);check('notification endpoint response',r.status===200);return r.json();};
 try{
  for(let i=0;i<100;i++){try{const r=await go('/login');if(r.status===200)break;}catch(_){}await new Promise(r=>setTimeout(r,50));}
  const admin=await login('admin@olutechagro.com','admin123');
  const onaope=await login('onaope@olutechagro.com','olutech123');
  const dipo=await login('dipo@olutechagro.com','olutech123');
  const chika=await login('chika@olutechagro.com','olutech123');
  let r=await get('/dashboard',onaope);let html=await r.text();
  check('bell in header',r.status===200&&html.includes('id="notificationTrigger"')&&html.includes('/public/notifications.js'));
  r=await go('/public/notifications.js');let js=await r.text();check('notification JS served as JavaScript',r.status===200&&(r.headers.get('content-type')||'').includes('javascript')&&js.includes('notification-toasts'));
  check('new empty account has empty notifications',(await feed(onaope)).unread===0);
  r=await post('/projects/new',admin,{name:'Notification Test Project',projectMode:'standard',owner:'ONAOPE',priority:'High'});check('project created',r.status===302);
  const project=db().projects.find(p=>p.name==='Notification Test Project');assert(project);
  r=await post('/tasks/new',onaope,{projectId:project.id,assignedTo:'DIPO',title:'Collect quality samples',status:'Not Started'});check('task created',r.status===302);
  const task=db().tasks.find(t=>t.title==='Collect quality samples');assert(task);
  let notice=await feed(dipo);check('assignee notified upon assignment',notice.unread===1&&notice.notifications[0].type==='task_assigned'&&notice.notifications[0].taskId===undefined);
  check('assigner not notified of own assignment',(await feed(onaope)).unread===0);
  r=await get('/tasks/view?id='+task.id+'&tab=comments',dipo);check('assignee opens task',r.status===200);
  notice=await feed(onaope);check('assigner receives first opened notification',notice.unread===1&&notice.notifications[0].type==='task_opened');
  r=await get('/tasks/view?id='+task.id+'&tab=files',dipo);check('switching tab works',r.status===200);
  check('first open is not duplicated',(await feed(onaope)).unread===1);
  r=await get('/tasks/view?id='+task.id+'&tab=comments',chika);check('outsider denied task',r.status===403);
  check('outsider sees no private notification',(await feed(chika)).unread===0);
  const openedId=(await feed(onaope)).notifications[0].id;
  r=await post('/notifications/read',chika,{id:openedId});check('unauthorized read does not mark other users notification',r.status===200&&!db().notifications.find(n=>n.id===openedId).readAt);
  r=await post('/notifications/read',onaope,{id:openedId});check('assigner can read notification',r.status===200&&!!db().notifications.find(n=>n.id===openedId).readAt);
  r=await post('/tasks/update',dipo,{id:task.id,status:'Completed',progress:'100'});check('assignee can complete task',r.status===302);
  notice=await feed(onaope);check('assigner receives closed notification',notice.unread===1&&notice.notifications[0].type==='task_closed');
  r=await post('/tasks/update',dipo,{id:task.id,status:'Completed',progress:'100'});check('repeated completion accepted',r.status===302);
  check('no duplicate closed alerts',(await feed(onaope)).unread===1);
  r=await post('/notifications/read',onaope,{all:'yes'});check('mark all read works',r.status===200&&(await feed(onaope)).unread===0);
  // reassignment opens a new first-open cycle and notifies new assignee.
  r=await post('/tasks/update',onaope,{id:task.id,assignedTo:'CHIKA',status:'In Progress',progress:'50'});check('reassign task',r.status===302);
  notice=await feed(chika);check('new assignee notified of reassignment',notice.unread===1&&notice.notifications[0].type==='task_assigned');
  r=await get('/tasks/view?id='+task.id,chika);check('new assignee opens reassigned task',r.status===200);
  check('assigner receives second opened event after reassignment',(await feed(onaope)).unread===1);
  // workflow tasks also generate notifications.
  r=await post('/workflow/add-step',admin,{projectId:project.id,title:'Workflow review check',assignedTo:'DIPO'});check('workflow step created',r.status===302);
  const dipoFeed=await feed(dipo);check('workflow assignment notifies assignee',dipoFeed.notifications.some(n=>n.type==='task_assigned'&&n.message.includes('Workflow review check')));
  // Vercel rewrite path should serve same JSON data.
  r=await get('/api/index.js?__path=/notifications',onaope);check('Vercel notification route works',r.status===200&&(r.headers.get('content-type')||'').includes('application/json'));
  r=await get('/notifications','');check('unauthenticated notifications restricted',r.status!==200);
  console.log('PASS '+checks+' notification checks (isolated local database)');
 }catch(err){console.error(err);console.error('SERVER LOGS:',logs.slice(-3000));process.exitCode=1;}
 finally{child.kill();await new Promise(resolve=>child.once('close',resolve));fs.rmSync(dir,{recursive:true,force:true});}
})();
