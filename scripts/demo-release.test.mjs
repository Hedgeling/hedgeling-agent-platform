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
