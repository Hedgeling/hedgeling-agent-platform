import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { startLocalEngine } from './dev-engine.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const script = fileURLToPath(import.meta.url);
const folder = path.join(root, '.hedgeling/local');
const configuration = path.join(root, '.env.development.local');
if (!fs.existsSync(configuration)) throw new Error('Create the ignored .env.development.local file; see docs/LOCAL-DEVELOPMENT.md.');
const config = parseEnv(fs.readFileSync(configuration, 'utf8'));
const port = Number(config.LOCAL_PORT), databasePort = Number(config.LOCAL_DATABASE_PORT);
if (![port, databasePort].every(n => Number.isInteger(n) && n >= 1024 && n <= 65535) || port === databasePort) throw new Error('Set distinct LOCAL_PORT and LOCAL_DATABASE_PORT values between 1024 and 65535.');
if (!config.LOCAL_PG_BIN || !config.LOCAL_DATABASE_PASSWORD) throw new Error('LOCAL_PG_BIN and LOCAL_DATABASE_PASSWORD are required.');
const origin = `http://127.0.0.1:${port}`;
const data = path.join(folder, 'postgres'), stateFile = path.join(folder, 'process.json'), sessionFile = path.join(folder, 'session.json');
fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); fs.chmodSync(folder, 0o700);
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const pgctl = (...args) => execFileSync(path.join(config.LOCAL_PG_BIN, 'pg_ctl'), ['-D', data, ...args], { stdio: 'pipe' });
const databaseUrl = name => `postgresql://hedgeling_local:${encodeURIComponent(config.LOCAL_DATABASE_PASSWORD)}@127.0.0.1:${databasePort}/${name}`;
function running() {
  const state = read(stateFile);
  if (!state?.pid) return false;
  try { return execFileSync('ps', ['-p', String(state.pid), '-o', 'command='], { encoding: 'utf8' }).includes(`${script} serve`); } catch { return false; }
}
async function stop(serverOnly = false) {
  if (running()) {
    process.kill(read(stateFile).pid, 'SIGTERM');
    for (let n = 0; n < 100 && running(); n++) await new Promise(resolve => setTimeout(resolve, 100));
    if (running()) throw new Error('The local server is still stopping. Try again shortly.');
  }
  fs.rmSync(stateFile, { force: true }); fs.rmSync(sessionFile, { force: true });
  if (!serverOnly && fs.existsSync(path.join(data, 'postmaster.pid'))) pgctl('stop', '-m', 'fast');
}
async function startDatabase() {
  if (!fs.existsSync(path.join(data, 'PG_VERSION'))) {
    const password = path.join(folder, 'init-password');
    fs.writeFileSync(password, config.LOCAL_DATABASE_PASSWORD, { mode: 0o600 });
    try { execFileSync(path.join(config.LOCAL_PG_BIN, 'initdb'), ['-D', data, '-U', 'hedgeling_local', '-A', 'scram-sha-256', '--pwfile', password, '--encoding=UTF8', '--locale=C'], { stdio: 'pipe' }); }
    finally { fs.rmSync(password, { force: true }); }
  }
  try { pgctl('status'); } catch { pgctl('start', '-w', '-l', path.join(folder, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${databasePort} -k /private/tmp`); }
  const client = new pg.Client({ connectionString: databaseUrl('postgres') });
  await client.connect();
  try { if (!(await client.query("select 1 from pg_database where datname='hedgeling_workbench'")).rowCount) await client.query('create database hedgeling_workbench'); }
  finally { await client.end(); }
}
async function serve() {
  const allowed = /^(HEDGELING_(?:GITHUB_(?:CLIENT_ID|CLIENT_SECRET|CALLBACK_URL)|ENGINE_(?:URL|TOKEN|ALLOW_LOOPBACK_HTTP)|AGENT_(?:PROVIDER|META_MODEL|GEMINI_MODEL)|META_(?:API_KEY|RESPONSES_URL|TRANSLATION_MODEL)|AI_KEY(?:_ID|RING)|GEMINI_(?:API_KEY|MODEL))|GEMINI_API_KEY|GOOGLE_AI_API_KEY)$/;
  const env = Object.fromEntries(Object.entries(config).filter(([name]) => allowed.test(name)));
  const engine = await startLocalEngine({config,folder,databaseUrl});
  if(engine)Object.assign(env,{HEDGELING_ENGINE_URL:engine.url,HEDGELING_ENGINE_TOKEN:engine.token,HEDGELING_ENGINE_ALLOW_LOOPBACK_HTTP:'true'});
  Object.assign(env, { PATH: process.env.PATH, NODE_ENV: 'development', DATABASE_URL: databaseUrl('hedgeling_workbench'), DATABASE_SSL: 'false', PORT: String(port),
    HEDGELING_GITHUB_CALLBACK_URL: `${origin}/api/github/callback`, HEDGELING_LOCAL_SITE_SEED: 'true', HEDGELING_LOCAL_WATCH: 'true', HEDGELING_LOCAL_SESSION_FILE: sessionFile });
  const child = spawn(process.execPath, [path.join(root, 'packages/web-console/scripts/dev-agent.js')], { cwd: root, env, stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => { process.exitCode = code || 0; void engine?.stop(); });
  child.on('error', () => { console.error('Local server failed to start; inspect the private server log.'); process.exitCode = 1; void engine?.stop(); });
}
const command = process.argv[2] || 'start';
try {
  if (command === 'serve') await serve();
  else if (command === 'start') {
    const session = read(sessionFile);
    if (running() && Date.parse(session?.expiresAt) > Date.now()) console.log(`Local console already running: ${origin}\nRun npm run local:open to sign in.`);
    else {
      if (running()) await stop(true);
      const probe = net.createServer();
      await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
      await new Promise(resolve => probe.close(resolve));
      await startDatabase();
      const log = path.join(folder, 'server.log');
      const fd = fs.openSync(log, 'a', 0o600); fs.chmodSync(log, 0o600);
      const child = spawn(process.execPath, [script, 'serve'], { cwd: root, detached: true, stdio: ['ignore', fd, fd] });
      child.unref(); fs.closeSync(fd);
      fs.writeFileSync(stateFile, JSON.stringify({ pid: child.pid, origin }), { mode: 0o600 });
      let ready = false;
      for (let n = 0; n < 90; n++) {
        try { if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok && read(sessionFile)) { ready = true; break; } } catch { /* startup */ }
        if (!running()) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!ready) throw new Error('Local startup did not complete. Inspect .hedgeling/local/server.log.');
      console.log(`Local console ready: ${origin}\nPersistent local database; server code reloads automatically.\nRun npm run local:open to sign in. UI changes appear after browser refresh.`);
    }
  } else if (command === 'stop') { await stop(); console.log('Local console and its database stopped. Test data is preserved.'); }
  else if (command === 'status') console.log(JSON.stringify({ running: running(), origin, sessionExpiresAt: read(sessionFile)?.expiresAt || null, dataDirectory: data }, null, 2));
  else if (command === 'open') {
    const session = read(sessionFile);
    if (!running() || !(Date.parse(session?.expiresAt) > Date.now())) throw new Error('Run npm run local:start to start or renew the local session.');
    if (process.platform === 'darwin') {
      execFileSync('pbcopy', [], { input: session.token });
      execFileSync('open', [`${origin}/local-login`]);
      console.log('Opened localhost. Paste the local token from your clipboard into the sign-in field.');
    } else console.log(`Open ${origin}/local-login and use the token in the private .hedgeling/local/session.json file.`);
  } else throw new Error('Use start, stop, status, or open.');
} catch (error) { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is occupied; choose another LOCAL_PORT.` : error.message); process.exitCode = 1; }
