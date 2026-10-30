// Development-only process adapter. The separately checked-out private engine
// stays outside this repository and is never bundled into the console.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import pg from 'pg';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function startLocalEngine({config,folder,databaseUrl}) {
  if(!config.LOCAL_ENGINE_ROOT)return null;
  const root=config.LOCAL_ENGINE_ROOT,port=Number(config.LOCAL_ENGINE_PORT);
  if(!path.isAbsolute(root)||!Number.isInteger(port)||port<1024||port>65535||[Number(config.LOCAL_PORT),Number(config.LOCAL_DATABASE_PORT)].includes(port))throw new Error('Set an absolute LOCAL_ENGINE_ROOT and a distinct LOCAL_ENGINE_PORT.');
  if(JSON.parse(fs.readFileSync(path.join(root,'packages/engine-api/package.json'))).name!=='@hedgeling/engine-api')throw new Error('LOCAL_ENGINE_ROOT must be the separately authorized private engine checkout.');
  const engineFolder=path.join(folder,'engine');fs.mkdirSync(engineFolder,{recursive:true,mode:0o700});
  const tokenFile=path.join(engineFolder,'token'),accessFile=path.join(engineFolder,'access.json');
  const token=fs.existsSync(tokenFile)?fs.readFileSync(tokenFile,'utf8'):randomBytes(32).toString('base64url');
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new Error('Invalid local engine credential file.');
  fs.writeFileSync(tokenFile,token,{mode:0o600});fs.chmodSync(tokenFile,0o600);
  fs.writeFileSync(accessFile,JSON.stringify({principals:[{id:'local-console',tenantId:'local-workbench',tokenSha256:createHash('sha256').update(token).digest('hex'),scopes:['engine:read','engine:run','engine:cancel','engine:snapshot'],connectionIds:[]}],connections:[]}),{mode:0o600});fs.chmodSync(accessFile,0o600);
  const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve);});await new Promise(resolve=>probe.close(resolve));
  const admin=new pg.Client({connectionString:databaseUrl('postgres')});await admin.connect();
  try{if(!(await admin.query("select 1 from pg_database where datname='hedgeling_engine_local'")).rowCount)await admin.query('create database hedgeling_engine_local');}finally{await admin.end();}
  const env={PATH:process.env.PATH,PORT:String(port),HEDGELING_ENGINE_HOST:'127.0.0.1',HEDGELING_ENGINE_GITHUB_ENABLED:'false',HEDGELING_ENGINE_DATABASE_URL:databaseUrl('hedgeling_engine_local'),HEDGELING_ENGINE_ACCESS_FILE:accessFile};
  try{execFileSync(process.execPath,[path.join(root,'packages/engine-api/scripts/migrate.mjs')],{cwd:root,env,stdio:'pipe'});}catch{throw new Error('Local engine migration failed. Build and install dependencies in the private checkout first.');}
  const fd=fs.openSync(path.join(engineFolder,'server.log'),'a',0o600);
  const child=spawn(process.execPath,[path.join(root,'packages/engine-api/src/main.mjs')],{cwd:root,env,stdio:['ignore',fd,fd]});fs.closeSync(fd);
  const stopped=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
  const stop=async()=>{if(child.exitCode==null)child.kill('SIGTERM');await stopped;};
  const url=`http://127.0.0.1:${port}`;
  for(let i=0;i<60;i++){
    try{const response=await fetch(`${url}/v1/capabilities`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(500)});if(response.ok&&(await response.json()).snapshotConfigured)return{url,token,stop,stopped};}catch{/* startup */}
    if(child.exitCode!=null)break;await sleep(250);
  }
  await stop();throw new Error('Local engine did not become ready. Inspect the private engine/server.log.');
}
