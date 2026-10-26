import assert from "node:assert/strict";
import test from "node:test";
import { pruneMissingProjectSources } from "../src/import-pruning.js";

test("prune rejects an empty imported catalog before querying", async () => {
  const client = {
    query() {
      throw new Error("query should not run");
    },
  };
  await assert.rejects(
    pruneMissingProjectSources(client, {
      projectId: "11111111-1111-4111-8111-111111111111",
      importedSourceHashes: new Set(),
    }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "import_prune_empty");
      return true;
    },
  );
});

test("prune names work orders that retain deletion candidates", async () => {
  const responses = [
    {
      rowCount: 1,
      rows: [{
        id: "22222222-2222-4222-8222-222222222222",
        source_hash: "removed-source",
      }],
    },
    {
      rowCount: 1,
      rows: [{
        work_order_id: "33333333-3333-4333-8333-333333333333",
        work_order_number: 7,
        title: "French UI",
        status: "in_progress",
        source_string_id: "22222222-2222-4222-8222-222222222222",
        source_hash: "removed-source",
      }],
    },
  ];
  const client = {
    async query() {
      return responses.shift();
    },
  };
  await assert.rejects(
    pruneMissingProjectSources(client, {
      projectId: "11111111-1111-4111-8111-111111111111",
      importedSourceHashes: new Set(["kept-source"]),
    }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "import_prune_work_order_conflict");
      assert.match(error.message, /#7 French UI/);
      assert.deepEqual(error.details.blockingWorkOrders[0], {
        id: "33333333-3333-4333-8333-333333333333",
        workOrderNumber: 7,
        title: "French UI",
        status: "in_progress",
        sourceStrings: [{
          id: "22222222-2222-4222-8222-222222222222",
          sourceHash: "removed-source",
        }],
      });
      return true;
    },
  );
  assert.equal(responses.length, 0);
});

test("prune deletes locked unreferenced candidates", async () => {
  const statements = [];
  const responses = [
    {
      rowCount: 1,
      rows: [{
        id: "22222222-2222-4222-8222-222222222222",
        source_hash: "removed-source",
      }],
    },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [] },
  ];
  const client = {
    async query(sql) {
      statements.push(sql);
      return responses.shift();
    },
  };
  const pruned = await pruneMissingProjectSources(client, {
    projectId: "11111111-1111-4111-8111-111111111111",
    importedSourceHashes: new Set(["kept-source"]),
  });
  assert.equal(pruned, 1);
  assert.match(statements[0], /for update/);
  assert.match(statements[2], /delete from source_strings/);
});
