import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const requested = process.env.REQUESTED_REF || 'main';
if (requested !== 'main' && !/^[a-f0-9]{40}$/.test(requested)) throw new Error('Select main or a full commit SHA from main');
const sha = run('git', ['rev-parse', `${requested === 'main' ? 'origin/main' : requested}^{commit}`]);
run('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
const repository = process.env.GITHUB_REPOSITORY;
if (!repository || !process.env.GITHUB_OUTPUT) throw new Error('GitHub repository and output are required');
const automatic = process.env.AUTOMATIC_RELEASE === 'true';
if (automatic && sha !== run('git', ['rev-parse', 'origin/main'])) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'deploy=false\n');
  console.log('A newer main commit exists; skip this superseded automatic release.');
  process.exit(0);
}
const checks = JSON.parse(run('gh', ['api', `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=100`]));
const check = checks.workflow_runs.find(item => item.head_sha === sha && item.head_branch === 'main'
  && item.head_repository?.full_name === repository && item.event === 'push' && item.conclusion === 'success'
  && (!automatic || String(item.id) === process.env.TRIGGER_RUN_ID));
if (!check) throw new Error('This main commit has no successful container CI run. Wait for CI, then deploy.');
run('git', ['checkout', '--detach', sha]);
appendFileSync(process.env.GITHUB_OUTPUT, `deploy=true\nsha=${sha}\nrun_id=${check.id}\n`);
console.log(`Selected verified release ${sha}`);
