'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function ephemeralPort() {return new Promise((res,rej)=>{const s=net.createServer();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>res(p));});});}

(async function(){
  const root=path.resolve(__dirname,'..');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'olutech-cloud-reset-'));
  const port=await ephemeralPort(), kvPort=await ephemeralPort();
  const store=new Map(); let blockBackups=false;
  const kv=http.createServer(async(req,res)=>{
    const [kind,...rest]=(req.url||'').split('/').filter(Boolean);
    const key=decodeURIComponent(rest.join('/'));
    res.setHeader('Content-Type','application/json');
    if(kind==='get'){res.end(JSON.stringify({result:store.has(key)?store.get(key):null}));return;}
    if(kind==='set' && req.method==='POST'){
      if(blockBackups && key.includes(':pre-reset:')){res.writeHead(503);res.end(JSON.stringify({error:'Simulated backup failure'}));return;}
      let value='';for await(const chunk of req)value+=chunk.toString();
      store.set(key,value);res.end(JSON.stringify({result:'OK'}));return;
    }
    res.writeHead(404);res.end(JSON.stringify({error:'Unknown command'}));
  });
  await new Promise(resolve=>kv.listen(kvPort,'127.0.0.1',resolve));
  const env={...process.env,PORT:String(port),VERCEL:'1',OLUTECH_DATA_DIR:temp,OLUTECH_DB_FILE:path.join(temp,'db.json'),KV_REST_API_URL:`http://127.0.0.1:${kvPort}`,KV_REST_API_TOKEN:'fake-token-for-test',UPSTASH_REDIS_REST_URL:'',UPSTASH_REDIS_REST_TOKEN:'',OLUTECH_PERSISTENCE_KEY:'olutech_pm_system_db'};
  const child=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let logs='';child.stderr.on('data',d=>logs+=d);child.stdout.on('data',d=>logs+=d);
  const base=`http://127.0.0.1:${port}`;
  const request=(route,options={})=>fetch(base+route,{redirect:'manual',...options});
  const body=(x)=>new URLSearchParams(x).toString();
  try{
    for(let i=0;i<100;i++){try{const r=await request('/login');if(r.status===200)break;}catch(_){}await new Promise(r=>setTimeout(r,70));}
    let r=await request('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body({email:'admin@olutechagro.com',password:'admin123'})});
    assert.equal(r.status,302,await r.text());const cookie=r.headers.get('set-cookie').split(';')[0];
    // Start with the initialized local DB and inject test operations into the test Upstash key.
    const current=JSON.parse(fs.readFileSync(path.join(temp,'db.json'),'utf8'));
    current.projects=[{id:'P-1',name:'Cloud Project',owner:'DIPO'}];
    current.tasks=[{id:'T-1',projectId:'P-1',title:'Cloud Task',assignedTo:'DIPO',status:'Not Started'}];
    current.approvals=[{id:'AP-1',projectId:'P-1',item:'Approval',status:'Pending'}];
    current.delays=[{id:'D-1',projectId:'P-1',description:'Delayed',status:'Open'}];
    store.set('olutech_pm_system_db',JSON.stringify(current));
    blockBackups=true;
    r=await request('/admin/operations-reset',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded',Origin:base},body:body({confirmation:'RESET OPERATIONS',password:'admin123',acknowledged:'yes'})});
    assert.equal(r.status,500,'backup failure must block reset');
    assert.equal(JSON.parse(store.get('olutech_pm_system_db')).projects.length,1,'failed backup did not clear cloud');
    blockBackups=false;
    r=await request('/admin/operations-reset',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded',Origin:base},body:body({confirmation:'RESET OPERATIONS',password:'admin123',acknowledged:'yes'})});
    assert.equal(r.status,200,await r.text());
    const saved=JSON.parse(store.get('olutech_pm_system_db'));
    for(const key of ['projects','tasks','approvals','delays','nxpChecklist']) assert.equal(saved[key].length,0,key);
    assert.equal(saved.users.length,current.users.length);
    const backupKeys=[...store.keys()].filter(key=>key.includes(':pre-reset:'));
    assert.equal(backupKeys.length,1,'one verified cloud backup');
    const backup=JSON.parse(store.get(backupKeys[0]));
    assert.equal(backup.projects[0].id,'P-1');
    r=await request('/dashboard',{headers:{Cookie:cookie}});assert.equal(r.status,200);
    assert.equal(JSON.parse(store.get('olutech_pm_system_db')).tasks.length,0,'no task regeneration');
    console.log('PASS: Upstash-compatible mocked cloud backup failure, verified reset, and persistent clean state');
  }catch(e){console.error('CLOUD RESET TEST FAILED',e,'\napp logs:',logs.slice(-2300));process.exitCode=1;}
  finally{child.kill('SIGTERM');await new Promise(resolve=>child.once('close',resolve));await new Promise(resolve=>kv.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
})();
