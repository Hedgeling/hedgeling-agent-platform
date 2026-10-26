# Public platform repository

This is the public hackathon workspace. Preserve the commercial LICENSE.

- Work only in the five packages listed in the root manifest unless a reviewed boundary change is required.
- Never add the private extractor, framework adapters, runtime generation, VS Code extension, local extraction MCP tools, benchmarks, bundles, or private repository history.
- Keep API contracts and permission checks shared by console, chat, and MCP. Models may propose writes; human confirmation remains an authenticated server decision.
- Provider keys, private upstream URLs, and cloud credentials belong only in server configuration. No live deployment endpoints, secrets, or customer data in source, examples, fixtures, or docs. Frontend configuration is public.
- Required configuration must fail explicitly. Do not fall back to a production service.
- Use synthetic catalogs to exercise imports. The import API is the boundary with separately operated extractors.
- Run `npm run check:public`, build, lint, and relevant tests before committing. Use disposable loopback PostgreSQL for integration tests.
- Do not copy deployment workflows or connect this repository to production. Do not merge private history here. Transfer reviewed platform changes back as scoped patches.
- Keep `docs/baseline.json` and the `hackathon-start` tag as the pre-existing-code record. Update the hackathon plan honestly as features land.
