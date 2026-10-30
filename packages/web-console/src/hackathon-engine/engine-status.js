// SPDX-License-Identifier: Apache-2.0
import { engineReader } from './engine-client.js';

// Mount behind the host application's operator authorization middleware.
// Never serialize the configured endpoint, token, or upstream error details.
export async function engineStatus(env = process.env, options = {}) {
  if (!env.HEDGELING_ENGINE_URL || !env.HEDGELING_ENGINE_TOKEN) {
    return { configured: false, reachable: false, sourceConfigured: false, status: 'configuration_required' };
  }
  const client = engineReader({ url: env.HEDGELING_ENGINE_URL, token: env.HEDGELING_ENGINE_TOKEN, ...options });
  const capabilities = await client.capabilities();
  const page = await client.connections({ limit: 1 });
  if (typeof capabilities.sourceConfigured !== 'boolean' || !Array.isArray(capabilities.operations)
      || !Number.isSafeInteger(page.total) || page.total < 0) throw new Error('Engine capability response was invalid.');
  return { configured: true, reachable: true, sourceConfigured: capabilities.sourceConfigured,
    snapshotConfigured: capabilities.snapshotConfigured === true,
    status: capabilities.sourceConfigured || capabilities.snapshotConfigured === true ? 'ready' : 'github_setup_required',
    operations: capabilities.operations.filter(value => ['extract', 'transform-preview', 'tune', 'tune-llm'].includes(value)), connectionCount: page.total };
}
