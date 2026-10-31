// @vitest-environment node
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: an upgrade loses or changes a wait; an old wait gets a source other than 'routine', a
// target or a failure count; a partial migration survives a failure; a retry adds a column twice; a newer
// or incomplete history is changed.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** Migration 34 created the wait table. */
const AGENT_WAITS_SINCE = 34;

function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
  return db;
}

/** A routine, and where the table exists, one wait on it and one woken wait on any run. */
function seed(db: DatabaseSync, version: number): void {
  db.prepare(`INSERT INTO projection_agent_routines
    (routine_id, agent_id, name, instruction, active, timezone, created_at, updated_at, last_event_sequence)
    VALUES ('routine-1', 'chief', 'Nightly build', 'Check the build.', 1, 'UTC', '2026-01-01', '2026-01-01', 1)`).run();
  if (version < AGENT_WAITS_SINCE) return;
  const wait = db.prepare(`INSERT INTO agent_waits (wait_id, agent_id, request_delivery_id, request_text, note,
    routine_id, created_at, woken_at, wake_delivery_id) VALUES (?, 'chief', ?, ?, ?, ?, ?, ?, ?)`);
  wait.run("wait-1", "delivery-1", 'Ship it. 界"\\', "Build", "routine-1", "2026-01-02", null, null);
  wait.run("wait-2", "delivery-2", "Deploy it.", "Deploy", null, "2026-01-03", "2026-01-04", "delivery-3");
}

type TableRow = Record<string, SQLOutputValue>;

function waits(db: DatabaseSync): TableRow[] {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_waits'").get();
  return table ? db.prepare("SELECT * FROM agent_waits ORDER BY rowid").all() : [];
}

/** What the upgrade adds to each old wait: the routine source and nothing else. */
function withSource(before: TableRow[]): TableRow[] {
  return before.map((row) => ({
    ...row,
    source: "routine",
    target: null,
    conditions_json: null,
    cursor_json: null,
    failures: 0,
  }));
}

function columnNames(db: DatabaseSync): SQLOutputValue[] {
  return db
    .prepare("PRAGMA table_info(agent_waits)")
    .all()
    .flatMap((column) => (column.name === undefined ? [] : [column.name]));
}

function sourceIndex(db: DatabaseSync) {
  return db.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_waits_source_target'").all();
}

describe("agent wait source migration", () => {
  it.each(Array.from({ length: 40 }, (_, index) => index + 8))(
    "keeps every wait from released schema %i",
    (version) => {
      const db = databaseAt(version);
      seed(db, version);
      const before = waits(db);
      migrateOpenBotDatabase(db);
      expect(waits(db)).toEqual(withSource(before));
      expect(columnNames(db).slice(-5)).toEqual(["source", "target", "conditions_json", "cursor_json", "failures"]);
      expect(sourceIndex(db)).toEqual([{ name: "agent_waits_source_target" }]);
      expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 48 });
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    },
  );

  it("rolls back every column, the index and the marker after a late failure, then retries", () => {
    const db = databaseAt(47);
    seed(db, 47);
    const before = waits(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version = 48
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 48 failed");
    expect(waits(db)).toEqual(before);
    expect(columnNames(db)).not.toContain("source");
    expect(sourceIndex(db)).toEqual([]);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 48").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec("DROP TRIGGER fail_marker");
    migrateOpenBotDatabase(db);
    expect(waits(db)).toEqual(withSource(before));
    expect(sourceIndex(db)).toEqual([{ name: "agent_waits_source_target" }]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("keeps a column that a development build added before the marker", () => {
    const db = databaseAt(47);
    seed(db, 47);
    db.exec("ALTER TABLE agent_waits ADD COLUMN source TEXT NOT NULL DEFAULT 'routine'");
    db.prepare("UPDATE agent_waits SET source = 'mcp-sign-in' WHERE wait_id = 'wait-2'").run();
    migrateOpenBotDatabase(db);
    expect(db.prepare("SELECT wait_id, source, target, failures FROM agent_waits ORDER BY rowid").all()).toEqual([
      { wait_id: "wait-1", source: "routine", target: null, failures: 0 },
      { wait_id: "wait-2", source: "mcp-sign-in", target: null, failures: 0 },
    ]);
    expect(columnNames(db).filter((name) => name === "source")).toHaveLength(1);
  });

  it("rejects newer and incomplete migration histories before it changes a wait", () => {
    const db = databaseAt(47);
    seed(db, 47);
    const before = waits(db);
    db.exec("INSERT INTO schema_migrations VALUES(49, 'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow("newer than this application supports");
    db.exec("DELETE FROM schema_migrations WHERE version = 49; DELETE FROM schema_migrations WHERE version = 34");
    expect(() => migrateOpenBotDatabase(db)).toThrow("missing version 34");
    expect(waits(db)).toEqual(before);
    expect(columnNames(db)).not.toContain("source");
  });
});
