// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from 'node:crypto';
import { fail } from './errors.js';
const hash = value => createHash('sha256').update(value).digest('hex');
export function githubIdentity({database,encrypt,decrypt,configuration,github,fetchImpl=fetch}) {
  function config(){const c=configuration();if(!c.clientId||!c.clientSecret||!c.redirectUri)throw fail(503,'GitHub sign-in is not configured. Ask the workspace operator to configure the GitHub App client and callback URL.','github_oauth_unconfigured');const u=new URL(c.redirectUri);if(u.username||u.password||u.search||u.hash||u.pathname!=='/api/github/callback'||u.protocol!=='https:'&&!(c.local&&u.protocol==='http:'&&u.hostname==='127.0.0.1'))throw fail(503,'Invalid GitHub callback configuration.','github_oauth_unconfigured');return c;}
  async function status(auth){const r=(await database.query('select login,expires_at from github_user_connections where user_id=$1',[auth.user.id])).rows[0];let configured=true;try{config();}catch{configured=false;}return{configured,connected:Boolean(r&&new Date(r.expires_at)>new Date()),login:r?.login||null,expiresAt:r?.expires_at||null};}
  async function start(auth){const c=config(),state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');await database.query('delete from github_oauth_states where user_id=$1 or expires_at<=now()',[auth.user.id]);await database.query('insert into github_oauth_states(state_hash,user_id,verifier,redirect_uri) values($1,$2,$3,$4)',[hash(state),auth.user.id,encrypt(verifier,auth.user.id),c.redirectUri]);const u=new URL('https://github.com/login/oauth/authorize');u.search=new URLSearchParams({client_id:c.clientId,redirect_uri:c.redirectUri,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',allow_signup:'false'}).toString();return{url:u.href};}
  async function complete(auth,{state,code}){
    if(!/^[A-Za-z0-9_-]{43}$/.test(state||'')||typeof code!=='string'||!code||code.length>512)throw fail(400,'Invalid GitHub authorization response.','github_oauth_invalid');
    const c=config(),saved=(await database.query('delete from github_oauth_states where state_hash=$1 and user_id=$2 and expires_at>now() returning *',[hash(state),auth.user.id])).rows[0];
    if(!saved||saved.redirect_uri!==c.redirectUri)throw fail(400,'GitHub sign-in expired or belongs to another session. Connect again.','github_oauth_invalid');
    let response;try{response=await fetchImpl('https://github.com/login/oauth/access_token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:c.clientId,client_secret:c.clientSecret,redirect_uri:c.redirectUri,code,code_verifier:decrypt(saved.verifier,auth.user.id)})});}catch{throw fail(502,'GitHub authorization could not finish. Connect again.','github_oauth_failed');}
    let size=0;const parts=[];for await(const chunk of response.body){size+=chunk.length;if(size>16384)throw fail(502,'Invalid GitHub authorization response.','github_oauth_failed');parts.push(chunk);}
    let data;try{data=JSON.parse(Buffer.concat(parts));}catch{throw fail(502,'Invalid GitHub authorization response.','github_oauth_failed');}
    if(!response.ok||data.error||typeof data.access_token!=='string'||!data.access_token||data.access_token.length>1024)throw fail(403,'GitHub authorization was declined or expired. Connect again.','github_oauth_failed');
    const user=await github.request('/user',data.access_token);
    if(!Number.isSafeInteger(user.id)||typeof user.login!=='string')throw fail(502,'Invalid GitHub account response.','github_oauth_failed');
    const expires=new Date(Date.now()+Math.min(Number(data.expires_in)||28800,28800)*1000);
    await database.query(`insert into github_user_connections(user_id,github_user_id,login,credential,expires_at) values($1,$2,$3,$4,$5)
      on conflict(user_id) do update set github_user_id=excluded.github_user_id,login=excluded.login,credential=excluded.credential,expires_at=excluded.expires_at,updated_at=now()`,[auth.user.id,user.id,user.login,encrypt(data.access_token,auth.user.id),expires]);
    return{connected:true,login:user.login,expiresAt:expires};
  }
  async function token(auth){const r=(await database.query('select credential from github_user_connections where user_id=$1 and expires_at>now()',[auth.user.id])).rows[0];return r?decrypt(r.credential,auth.user.id):null;}
  async function disconnect(auth){await database.query('delete from github_user_connections where user_id=$1',[auth.user.id]);await database.query('delete from github_oauth_states where user_id=$1',[auth.user.id]);return{connected:false};}
  return{status,start,complete,token,disconnect};
}
