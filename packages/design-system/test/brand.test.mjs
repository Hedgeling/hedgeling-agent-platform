import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildBrand } from "../build.mjs";

test("two interchangeable brands compile with the same semantic contract", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hedgeling-brands-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const results = [];
  for (const name of ["hedgeling", "aurora"]) {
    const output = path.join(root, name);
    const brand = await buildBrand(name, output);
    const tokens = JSON.parse(await fs.readFile(path.join(output, "tokens.json")));
    results.push(tokens);
    assert.equal(brand.id, name);
    await fs.access(path.join(output, "assets", path.basename(brand.mascot)));
  }
  assert.deepEqual(Object.keys(results[0].light).sort(), Object.keys(results[1].light).sort());
  assert.notEqual(results[0].light["accent-green"], results[1].light["accent-green"]);
  await assert.rejects(buildBrand("../outside", root), /Invalid brand/);
});
