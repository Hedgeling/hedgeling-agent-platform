import express from 'express';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {query} from './db.js';
import {encryptSecret,decryptSecret} from './secret-vault.js';
import {projectPermissions} from './authorization.js';
import {isHumanDecisionActor} from './principal-policy.js';
import {authRateLimit} from './auth-rate-limit.js';
import {fail} from './action-errors.js';
import {githubSource} from './hackathon-engine/github-source.js';
import {githubIdentity} from './hackathon-engine/github-identity.js';
import {createRepositories} from './hackathon-engine/repositories.js';
import {engineOperations} from './hackathon-engine/engine-operations.js';
const canonical=v=>v instanceof Date?v.toISOString():Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const localEngineAllowed=()=>process.env.NODE_ENV==='development'&&process.env.HEDGELING_AUTH_MODE==='local'&&process.env.HEDGELING_ENGINE_ALLOW_LOOPBACK_HTTP==='true';
export const sourceEngine=()=>engineOperations({url:process.env.HEDGELING_ENGINE_URL,token:process.env.HEDGELING_ENGINE_TOKEN,allowLoopbackHttp:localEngineAllowed()});
const github=githubSource();
export const githubConnection=githubIdentity({database:{query},github,
  encrypt:(value,user)=>encryptSecret(value,user,'github-user'),decrypt:(value,user)=>decryptSecret(value,user,'github-user'),
  configuration:()=>({clientId:process.env.HEDGELING_GITHUB_CLIENT_ID,clientSecret:process.env.HEDGELING_GITHUB_CLIENT_SECRET,
    redirectUri:process.env.HEDGELING_GITHUB_CALLBACK_URL,local:process.env.NODE_ENV==='development'&&process.env.HEDGELING_AUTH_MODE==='local'})});
export const repositories=createRepositories({database:{query},github,identity:githubConnection,engine:sourceEngine,
  fingerprint:value=>crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'),
  authorize:async(auth,project,write)=>{const perms=await projectPermissions(auth,project);if(!['strings.view','imports.run',...(write?['projects.manage']:[])].every(p=>perms.includes(p)))throw fail(403,'You need project source/import access; connecting repositories also requires project management.','repository_access_denied');}});
export const githubRouter=express.Router();
const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
githubRouter.use(authRateLimit({key:'github-connect',limit:30,identity:req=>req.auth?.user?.id}));
githubRouter.use((req,res,next)=>{if(!isHumanDecisionActor(req.auth)||!req.auth?.user?.id)return next(fail(403,'Connect GitHub from your signed-in console.'));next();});
githubRouter.get('/status',route(async(req,res)=>res.json(await githubConnection.status(req.auth))));
githubRouter.post('/start',route(async(req,res)=>res.json(await githubConnection.start(req.auth))));
githubRouter.post('/complete',route(async(req,res)=>res.json(await githubConnection.complete(req.auth,req.body))));
githubRouter.post('/disconnect',route(async(req,res)=>res.json(await githubConnection.disconnect(req.auth))));
const publicFolder=fileURLToPath(new URL('./public/',import.meta.url));
export function githubCallbackPage(_req,res){res.sendFile(path.join(publicFolder,'github-callback.html'));}
export function githubCallbackScript(_req,res){res.sendFile(path.join(publicFolder,'github-callback.js'));}
