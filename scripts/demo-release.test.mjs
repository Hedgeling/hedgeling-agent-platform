import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const sha = 'a'.repeat(40), newer = 'b'.repeat(40);
function select({ main = sha, checks, automatic = true, runId = '42', requested = sha, ancestor = true }) {
  const folder = mkdtempSync(path.join(tmpdir(), 'release-selection-'));
  try {
    const mock = `#!${process.execPath}\nconst args=process.argv.slice(2); if(process.argv[1].endsWith('/gh')) console.log(process.env.FAKE_CHECKS); else if(args[0]==='rev-parse') console.log(args[1]==='origin/main'?process.env.FAKE_MAIN:process.env.FAKE_SHA); else if(args[0]==='merge-base'&&process.env.FAKE_ANCESTOR==='false')process.exit(1);`;
    for (const name of ['git', 'gh']) writeFileSync(path.join(folder,name), mock, { mode: 0o700 });
    const output = path.join(folder,'output');
    const result = spawnSync(process.execPath, ['scripts/select-demo-release.mjs'], { encoding: 'utf8', env: { PATH: folder, REQUESTED_REF: requested, AUTOMATIC_RELEASE: String(automatic), TRIGGER_RUN_ID: runId, GITHUB_REPOSITORY:'Hedgeling/example', GITHUB_OUTPUT: output, FAKE_MAIN:main, FAKE_SHA:sha, FAKE_ANCESTOR:String(ancestor), FAKE_CHECKS:JSON.stringify({ workflow_runs:checks }) } });
    return { status:result.status, output:existsSync(output)?readFileSync(output,'utf8'):'' };
  } finally { rmSync(folder,{recursive:true,force:true}); }
}
const good = { id:42, head_sha:sha, head_branch:'main', head_repository:{full_name:'Hedgeling/example'},event:'push',conclusion:'success' };
test('automatic releases select only the successful triggering main run and skip superseded commits', () => {
  assert.deepEqual(select({checks:[good]}),{status:0,output:`deploy=true\nsha=${sha}\nrun_id=42\n`});
  assert.deepEqual(select({main:newer,checks:[good]}),{status:0,output:'deploy=false\n'});
  for(const change of [{event:'pull_request'},{head_branch:'feature'},{conclusion:'failure'},{id:43},{head_repository:{full_name:'foreign/repo'}}]) assert.notEqual(select({checks:[{...good,...change}]}).status,0);
  assert.notEqual(select({checks:[good],ancestor:false}).status,0);
  assert.notEqual(select({checks:[good],requested:'feature'}).status,0);
});
test('manual rollback still requires a successful main image build', () => {
  assert.equal(select({main:newer,automatic:false,checks:[good]}).status,0);
  assert.notEqual(select({automatic:false,checks:[]}).status,0);
});

test('release verification rejects an unavailable database even when the process is alive', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'release-readiness-'));
  try {
    const state = path.join(folder, 'updated');
    const requests = path.join(folder, 'requests');
    const mock = `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2), command = args[1];
const next = 'arn:aws:ecs:us-east-1:123456789012:task-definition/hedgeling-demo-console:2';
let result = {};
if (command === 'get-caller-identity') result = { Account: '123456789012' };
else if (command === 'describe-services') result = { services: [{ taskDefinition: fs.existsSync(process.env.FAKE_STATE) ? next : next.replace(':2', ':1'), runningCount: 1, desiredCount: 1 }] };
else if (command === 'describe-task-definition') result = { taskDefinition: { family: 'hedgeling-demo-console', containerDefinitions: [{ name: 'web-console', image: 'previous' }] } };
else if (command === 'register-task-definition') result = { taskDefinition: { taskDefinitionArn: next } };
else if (command === 'update-service') fs.writeFileSync(process.env.FAKE_STATE, 'updated');
else if (command !== 'wait') throw new Error('Unexpected AWS call');
console.log(JSON.stringify(result));`;
    writeFileSync(path.join(folder, 'package.json'), '{"type":"module"}');
    writeFileSync(path.join(folder, 'aws'), mock, { mode: 0o700 });
    const preload = path.join(folder, 'fetch.mjs');
    writeFileSync(preload, `import fs from 'node:fs';
globalThis.fetch = async url => {
  const pathname = new URL(url).pathname;
  fs.appendFileSync(process.env.FAKE_REQUESTS, pathname + '\\n');
  const status = pathname === '/api/ready' ? Number(process.env.FAKE_READINESS) : pathname === '/api/agent/config' ? 401 : 200;
  return { status, ok: status >= 200 && status < 300 };
};`);
    const verify = readiness => {
      writeFileSync(requests, '');
      const result = spawnSync(process.execPath, ['--import', preload, 'scripts/deploy-demo.mjs'], {
        encoding: 'utf8',
        env: { PATH: folder, AWS_REGION: 'us-east-1', ECS_CLUSTER: 'demo-cluster', ECS_SERVICE: 'hedgeling-demo-console', ECS_TASK_FAMILY: 'hedgeling-demo-console', ECS_CONTAINER_NAME: 'web-console',
          RELEASE_IMAGE: `123456789012.dkr.ecr.us-east-1.amazonaws.com/hedgeling-demo@sha256:${'a'.repeat(64)}`, DEMO_PUBLIC_ORIGIN: 'https://demo.example',
          FAKE_STATE: state, FAKE_REQUESTS: requests, FAKE_READINESS: String(readiness) },
      });
      return { ...result, requests: readFileSync(requests, 'utf8').trim().split('\n') };
    };
    const unavailable = verify(503);
    assert.notEqual(unavailable.status, 0);
    assert.match(unavailable.stderr, /database readiness check failed/);
    assert.deepEqual(unavailable.requests, ['/api/ready']);
    const ready = verify(200);
    assert.equal(ready.status, 0, ready.stderr);
    assert.deepEqual(ready.requests, ['/api/ready', '/api/agent/config']);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
