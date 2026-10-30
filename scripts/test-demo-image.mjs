import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createTestTls } from '../packages/web-console/test-support/meta-provider.mjs';
const sha = process.env.RELEASE_SHA;
const database = process.env.TEST_DATABASE_URL;
if (!/^[a-f0-9]{40}$/.test(sha || '') || !database) throw new Error('Release SHA and disposable test database are required');
const image = `hedgeling-demo-tested:${sha}`;
const run = args => execFileSync('docker', args, { stdio: 'inherit' });
run(['build', '--platform', 'linux/amd64', '--label', `org.opencontainers.image.revision=${sha}`, '-f', 'packages/web-console/Dockerfile', '-t', image, '.']);
// Linux host networking keeps the disposable database loopback-only. These
// tests start the real server from the production image with local fixture auth.
const tls = createTestTls();
try {
  run(['run', '--rm', '--network', 'host', '--mount', `type=bind,source=${tls},target=/run/hedgeling-test-tls,readonly`,
    '-e', 'HEDGELING_TEST_TLS_DIRECTORY=/run/hedgeling-test-tls', '-e', `TEST_DATABASE_URL=${database}`, '-e', 'HEDGELING_REQUIRE_AGENT_TEST_DATABASE=true', image,
    'node', '--test', 'packages/web-console/test/agent-console.integration.mjs', 'packages/web-console/test/project-locales.integration.mjs', 'packages/web-console/test/library.integration.mjs',
    'packages/web-console/test/context-enrichment.integration.mjs', 'packages/web-console/test/documents.integration.mjs', 'packages/web-console/test/document-parsers.test.js', 'packages/web-console/test/translation-jobs.integration.mjs']);
} finally { rmSync(tls, { recursive: true, force: true }); }
