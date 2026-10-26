import { pool } from "../src/db.js";
import { migrateDatabase } from "../src/migrations.js";

const result = await migrateDatabase();
await pool.end();
console.log(`Database migrated; ${result.applied.length} ordered migration(s) applied.`);
