'use strict';
/**
 * SQLite 数据层（无 ORM）。
 *
 * 驱动优先级：better-sqlite3（任务书指定）→ Node 内置 node:sqlite（仅在
 * better-sqlite3 未安装时兜底，Node >= 22.5）。两者通过本文件统一成同一套
 * 同步 API，上层不感知差异。
 *
 * 表结构是「宽表 + JSON 列」：业务字段原样放在 json 里，只有需要索引/权限
 * 判断的字段（goals.parentId / goals.owner / reports.owner|kind|cycle）
 * 冗余成列。这样迁移不改变任何业务数据形状。
 */
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.GOALOS_DB
  ? path.resolve(process.env.GOALOS_DB)
  : path.join(__dirname, '..', 'data.db');

const COLLECTIONS = ['people', 'agents', 'goals', 'reports', 'users'];

class VersionConflictError extends Error {
  constructor(message) {
    super(message || '数据已被他人修改，请刷新后重试');
    this.name = 'VersionConflictError';
    this.code = 'VERSION_CONFLICT';
    this.status = 409;
  }
}

let handle = null;
let driver = null;

function openDriver() {
  try {
    const Database = require('better-sqlite3');
    return { kind: 'better-sqlite3', db: new Database(DB_PATH) };
  } catch (e1) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      return { kind: 'node:sqlite', db: new DatabaseSync(DB_PATH) };
    } catch (e2) {
      const err = new Error(
        '无法加载 SQLite 驱动。请先 `npm install` 安装 better-sqlite3；' +
        '或使用 Node >= 22.5 的内置 node:sqlite。原始错误：' + e1.message
      );
      err.cause = e1;
      throw err;
    }
  }
}

function init() {
  if (handle) return handle;
  if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const opened = openDriver();
  handle = opened.db;
  driver = opened.kind;

  // 任务书要求的三条 pragma。WAL 让读写不互相阻塞，busy_timeout 让并发
  // 进程等锁而不是立刻 SQLITE_BUSY，foreign_keys 为后续加外键留好开关。
  handle.exec('PRAGMA journal_mode = WAL;');
  handle.exec('PRAGMA busy_timeout = 5000;');
  handle.exec('PRAGMA foreign_keys = ON;');

  handle.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS people (
      id      TEXT PRIMARY KEY,
      json    TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS agents (
      id      TEXT PRIMARY KEY,
      json    TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS goals (
      id       TEXT PRIMARY KEY,
      json     TEXT NOT NULL,
      version  INTEGER NOT NULL DEFAULT 1,
      parentId TEXT,
      owner    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_goals_parentId ON goals(parentId);
    CREATE INDEX IF NOT EXISTS idx_goals_owner    ON goals(owner);

    CREATE TABLE IF NOT EXISTS reports (
      id      TEXT PRIMARY KEY,
      json    TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      owner   TEXT NOT NULL,
      kind    TEXT NOT NULL,
      cycle   TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_reports_owner_kind_cycle
      ON reports(owner, kind, cycle);

    CREATE TABLE IF NOT EXISTS users (
      id      TEXT PRIMARY KEY,
      json    TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id   TEXT,
      type         TEXT NOT NULL,
      payload_json TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_subject ON events(subject_id);
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
  `);

  // 兼容早期手工建的库：缺列时补列，不动已有数据。
  ensureColumn('goals', 'parentId', 'TEXT');
  ensureColumn('goals', 'owner', 'TEXT');
  ensureColumn('reports', 'owner', 'TEXT');
  ensureColumn('reports', 'kind', 'TEXT');
  ensureColumn('reports', 'cycle', 'TEXT');

  return handle;
}

function ensureColumn(table, column, def) {
  const cols = handle.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

function db() { return init(); }

function exec(sql) { return db().exec(sql); }
function run(sql, ...params) { return db().prepare(sql).run(...params); }
function get(sql, ...params) { return db().prepare(sql).get(...params); }
function all(sql, ...params) { return db().prepare(sql).all(...params); }

/** 同步事务；BEGIN IMMEDIATE 让写锁在事务开始时拿到，避免升级锁死。 */
function transaction(fn) {
  return (...args) => {
    const h = db();
    h.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(...args);
      h.exec('COMMIT');
      return result;
    } catch (e) {
      try { h.exec('ROLLBACK'); } catch (_) { /* 已回滚 */ }
      throw e;
    }
  };
}

function encode(obj) {
  const copy = { ...obj };
  delete copy.version;
  return JSON.stringify(copy);
}

function decode(row) {
  const obj = JSON.parse(row.json);
  obj.version = row.version;
  return obj;
}

/** 完整快照，形状与 data.json 一致（每个记录多一个 version 字段）。 */
function loadAll() {
  const d = {};
  for (const row of all('SELECT key, value FROM meta ORDER BY rowid')) {
    try { d[row.key] = JSON.parse(row.value); }
    catch (_) { d[row.key] = row.value; }
  }
  for (const table of COLLECTIONS) {
    d[table] = all(`SELECT json, version FROM ${table} ORDER BY rowid`).map(decode);
  }
  return d;
}

function getRow(table, id) {
  const row = get(`SELECT json, version FROM ${table} WHERE id = ?`, id);
  return row ? { obj: JSON.parse(row.json), version: row.version } : null;
}

function insertRow(table, id, obj, extra = {}) {
  const cols = ['id', 'json', 'version', ...Object.keys(extra)];
  const marks = cols.map(() => '?').join(', ');
  const values = [id, encode(obj), 1, ...Object.values(extra)];
  run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${marks})`, ...values);
  return 1;
}

/** 只在 id 不存在时插入；返回是否真的写入。迁移幂等靠它。 */
function insertRowIfAbsent(table, id, obj, extra = {}) {
  const cols = ['id', 'json', 'version', ...Object.keys(extra)];
  const marks = cols.map(() => '?').join(', ');
  const values = [id, encode(obj), 1, ...Object.values(extra)];
  const res = run(
    `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${marks})`,
    ...values
  );
  return Number(res.changes) === 1;
}

/**
 * 乐观锁更新：WHERE id = ? AND version = ?。
 * 0 行受影响 → VERSION_CONFLICT（不是静默覆盖）。
 */
function updateRow(table, id, obj, expectedVersion, extra = {}) {
  const sets = ['json = ?', 'version = version + 1'];
  for (const key of Object.keys(extra)) sets.push(`${key} = ?`);
  const values = [encode(obj), ...Object.values(extra), id, expectedVersion];
  const res = run(
    `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ? AND version = ?`,
    ...values
  );
  if (Number(res.changes) !== 1) throw new VersionConflictError();
  return Number(expectedVersion) + 1;
}

function deleteRow(table, id) {
  return run(`DELETE FROM ${table} WHERE id = ?`, id);
}

function addEvent(subjectId, type, payload) {
  run(
    'INSERT INTO events (subject_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)',
    subjectId == null ? null : String(subjectId),
    String(type),
    JSON.stringify(payload || {}),
    new Date().toISOString()
  );
}

function setMeta(key, value) {
  run(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    String(key),
    JSON.stringify(value)
  );
}

function insertMetaIfAbsent(key, value) {
  const res = run('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', String(key), JSON.stringify(value));
  return Number(res.changes) === 1;
}

function getMigration(version) {
  return get('SELECT version, applied_at FROM schema_migrations WHERE version = ?', version) || null;
}

function recordMigration(version) {
  run(
    'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    version,
    new Date().toISOString()
  );
}

function counts() {
  const out = {};
  for (const table of [...COLLECTIONS, 'events']) {
    out[table] = Number(get(`SELECT COUNT(*) AS n FROM ${table}`).n);
  }
  return out;
}

function eventCount(subjectId, type) {
  const row = type
    ? get('SELECT COUNT(*) AS n FROM events WHERE subject_id = ? AND type = ?', subjectId, type)
    : get('SELECT COUNT(*) AS n FROM events WHERE subject_id = ?', subjectId);
  return Number(row.n);
}

function close() {
  if (handle) {
    try { handle.close(); } catch (_) { /* ignore */ }
    handle = null;
  }
}

module.exports = {
  DB_PATH,
  COLLECTIONS,
  VersionConflictError,
  get driver() { return driver; },
  init,
  close,
  exec, run, get, all,
  transaction,
  loadAll,
  getRow,
  insertRow,
  insertRowIfAbsent,
  updateRow,
  deleteRow,
  addEvent,
  setMeta,
  insertMetaIfAbsent,
  getMigration,
  recordMigration,
  counts,
  eventCount
};
