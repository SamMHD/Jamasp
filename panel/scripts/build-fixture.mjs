import Database from "better-sqlite3";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../test/fixtures/root");
mkdirSync(path.join(root, "state"), { recursive: true });
const dbPath = path.join(root, "state", "jamasp.db");
rmSync(dbPath, { force: true });
const db = new Database(dbPath);
db.exec(readFileSync(path.resolve(import.meta.dirname, "../test/fixtures/fixture.sql"), "utf8"));
db.close();
console.log(`fixture db written: ${dbPath}`);
