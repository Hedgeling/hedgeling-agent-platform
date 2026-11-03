import test from 'node:test';
import assert from 'node:assert/strict';
import { connectAgentTools } from '../src/agent-mcp.js';

test('chat exposes counts and narrow inspection but cannot invoke bulk context browsers', async t => {
  const session=await connectAgentTools({user:{id:'synthetic'}},{organizationId:'synthetic'},async()=>{});
  t.after(()=>session.close());
  const names=(await session.client.listTools()).tools.map(t=>t.name);
  assert(names.includes('console_get_context_summary')); assert(names.includes('console_inspect_string_context'));
  assert(names.includes('console_check_repository_delivery'));
  for(const name of ['console_list_string_context','console_browse_context_results']){
    assert(!names.includes(name));
    const result=await session.client.callTool({name,arguments:{}});
    assert.equal(result.isError,true); assert.equal(JSON.parse(result.content[0].text).code,'tool_unavailable');
  }
  const invalid=await session.client.callTool({name:'console_inspect_string_context',arguments:{projectSlug:'synthetic'}});
  assert.equal(invalid.isError,true); assert.equal(JSON.parse(invalid.content[0].text).code,'action_input_invalid');
});
