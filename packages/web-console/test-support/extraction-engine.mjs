import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Synthetic HTTPS service; private engine/model/customer data are never loaded.
export async function extractionEngine() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-tls-'));
  const cert = path.join(directory, 'cert.pem'), key = path.join(directory, 'key.pem');
  const config = path.join(directory, 'openssl.cnf');
  fs.writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=extraction-fixture\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', config], { stdio: 'ignore' });
  const jobs = new Map(), keys = new Map(), calls = [];
  const control = { complete: false, failNextCreate: false, corruptArtifact: false, holdModels: false, loseModelAck: false, invalidModel: false, modelCount: 1 };
  const modelRequests = new Map(), modelResults = new Map();
  const entries = [{ key: 'hello', source: 'Hello from the source', contexts: [{ purpose: 'heading', locations: [{ file: 'src/App.tsx', line: 2 }] }] },
    { key: 'button', source: 'Save your draft', contexts: [] }];
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const route = new URL(req.url, 'https://localhost').pathname;
    calls.push({ method: req.method, route, key: req.headers['idempotency-key'] });
    if (req.headers.authorization !== 'Bearer synthetic-engine-token') return send(401, {});
    if (route === '/v1/capabilities') return send(200, { sourceConfigured: true, operations: ['extract', 'tune', 'tune-llm'], modelLimits: {items:80,calls:4,promptBytes:65536,outputTokens:8192,responseBytes:131072} });
    if (route === '/v1/connections/test-source/config') return send(200, {repositoryId:123,commitSha:'a'.repeat(40),path:new URL(req.url,'https://localhost').searchParams.get('path'),found:true,settings:{excludeFields:['telemetryLabel']},ignoredFields:['translation']});
    if (route === '/v1/jobs' && req.method === 'POST') {
      let raw = ''; for await (const part of req) raw += part;
      const body = JSON.parse(raw); const requestKey = req.headers['idempotency-key'];
      let id = keys.get(requestKey);
      if (!id) { id = crypto.randomUUID(); keys.set(requestKey, id); jobs.set(id, { id, ...body, phase: 'queued', status: 'queued', commitSha: null, expiresAt: new Date(Date.now() + 86400000).toISOString() }); }
      if (control.failNextCreate) { control.failNextCreate = false; return send(503, { error: 'synthetic lost acknowledgement' }); }
      if (body.operation === 'tune-llm' && !modelRequests.has(id)) modelRequests.set(id, Array.from({length:control.modelCount}, () => ({id:crypto.randomUUID(),system:'Classify synthetic text.',user:'Synthetic candidate string.',maxOutputTokens:8192})));
      return send(202, { job: jobs.get(id) });
    }
    const modelMatch = /^\/v1\/jobs\/([a-f0-9-]+)\/(model-requests|cancel)(?:\/([a-f0-9-]+))?$/.exec(route);
    if (modelMatch) {
      const [,id,operation,requestId] = modelMatch, job=jobs.get(id); if (!job) return send(404,{});
      if (operation==='cancel') { job.status='cancelled'; return send(200,{job}); }
      if (req.method==='GET') return send(200,{requests:control.holdModels ? [] : (modelRequests.get(id)||[]).filter(r=>!modelResults.has(r.id)).map(r=>({...r,...(control.invalidModel?{maxOutputTokens:999999}:{})}))});
      let raw=''; for await(const part of req) raw+=part; const result=JSON.parse(raw);
      if (control.loseModelAck) { control.loseModelAck=false; return send(503,{}); }
      modelResults.set(requestId,result); if(result.failed) job.status='failed';
      else if((modelRequests.get(id)||[]).every(r=>modelResults.has(r.id))) {job.status='succeeded';job.phase='complete';job.commitSha='a'.repeat(40);}
      return send(200,{accepted:true});
    }
    const match = /^\/v1\/jobs\/([a-f0-9-]+)(\/artifact)?$/.exec(route);
    const job = match && jobs.get(match[1]);
    if (!job) return send(404, {});
    if (job.operation === 'tune-llm' && job.status === 'queued') { job.status='running';job.phase='awaiting_model'; }
    if (control.complete && job.operation !== 'tune-llm') { job.status = 'succeeded'; job.phase = 'complete'; job.commitSha = 'a'.repeat(40); }
    if (!match[2]) return send(200, { job });
    if (job.status !== 'succeeded') return send(409, {});
    return send(200, { version: 1, catalog: { schemaVersion: 2, sourceLocale: job.sourceLocale, entries },
      provenance: { repositoryId: control.corruptArtifact ? 999 : 123, commitSha: job.commitSha, operation: job.operation }, ...(['tune','tune-llm'].includes(job.operation) ? {tuning:{mode:job.operation==='tune-llm'?'llm':'deterministic',wrote:false,llmCalls:job.operation==='tune-llm'?(modelRequests.get(job.id)||[]).length:0,...(job.operation==='tune-llm'?{classifiedCount:1,maximumItems:80,coverage:'bounded'}:{}),before:{strings:2,diagnostics:{total:10}},after:{strings:2,diagnostics:{total:5}},acceptedEdits:[{field:'excludeCallees',value:'trackDebug'}],settings:{...job.settings,excludeCallees:[...(job.settings?.excludeCallees || []),'trackDebug']}}}: {}) });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { env: { HEDGELING_ENGINE_URL: `https://127.0.0.1:${server.address().port}`, HEDGELING_ENGINE_TOKEN: 'synthetic-engine-token', NODE_EXTRA_CA_CERTS: cert }, jobs, calls, control, modelRequests, modelResults,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); } };
}

export async function seedExtractionProject(database) {
  const p = (await database.query(`select p.id,p.slug,b.organization_id as org from projects p join business_units b on b.id=p.business_unit_id where p.slug='hedgeling-local'`)).rows[0];
  await database.query("update projects set source_locale='en-US' where id=$1", [p.id]);
  const account = (await database.query('insert into billing_accounts(organization_id) values($1) returning id', [p.org])).rows[0];
  await database.query("insert into subscriptions(billing_account_id,plan_id,state) select $1,id,'active' from product_plans where key='business-v1'", [account.id]);
  await database.query(`insert into extraction_connections(project_id,connection_id,repository_id,repository_owner,repository_name,allowed_roots)
    values($1,'test-source',123,'Synthetic','source',array['src'])`, [p.id]);
  return p;
}
