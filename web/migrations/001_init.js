#!/usr/bin/env node
'use strict';
/**
 * 001_init — data.json → SQLite
 *
 * 设计原则：
 *  - 数据形状不变：每条记录原样进 json 列，只把需要索引的字段冗余成列。
 *  - 迁移前自动备份 data.json（data.json.bak-<时间戳>）。
 *  - 幂等：INSERT OR IGNORE，重复执行不会产生重复记录、不会覆盖已改数据。
 *  - 迁移前做体检：重复 ID、孤立 parentId、日期/周期格式异常，逐条打印。
 *
 * 用法：
 *   node web/migrations/001_init.js
 *   GOALOS_DATA=web/data.example.json GOALOS_DB=web/data.demo.db node web/migrations/001_init.js
 */
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

const VERSION = '001_init';
const DATA_PATH = process.env.GOALOS_DATA
  ? path.resolve(process.env.GOALOS_DATA)
  : path.join(__dirname, '..', 'data.json');
const COLLECTIONS = ['people', 'agents', 'goals', 'reports', 'users'];

function log(...args) { console.log('[001_init]', ...args); }

function backupDataFile() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').replace('Z', '');
  const dest = `${DATA_PATH}.bak-${stamp}`;
  fs.copyFileSync(DATA_PATH, dest);
  return dest;
}

function isBadDate(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value !== 'string') return true;
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) return true;
  return Number.isNaN(Date.parse(value));
}

function isBadCycle(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value !== 'string') return true;
  return !/^\d{4}-(Q[1-4]|W\d{2}|\d{2})(\s*\/\s*\d{4}-(Q[1-4]|W\d{2}|\d{2}))?$/.test(value.trim());
}

/**
 * 只报告、不修改数据。返回 { duplicates, orphans, anomalies, reportDuplicates }。
 */
function inspect(data) {
  const duplicates = [];
  const orphans = [];
  const anomalies = [];
  const reportDuplicates = [];
  const ids = {};

  for (const collection of COLLECTIONS) {
    const list = data[collection];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      anomalies.push({ code: 'COLLECTION_NOT_ARRAY', detail: `${collection} 不是数组` });
      continue;
    }
    const seen = new Set();
    for (const item of list) {
      if (!item || typeof item !== 'object') {
        anomalies.push({ code: 'RECORD_NOT_OBJECT', detail: `${collection} 中存在非对象记录` });
        continue;
      }
      const id = collection === 'users' ? item.userId : item.id;
      if (!id) {
        anomalies.push({ code: 'MISSING_ID', detail: `${collection} 中有记录缺 id` });
        continue;
      }
      if (seen.has(id)) duplicates.push(`${collection}:${id}`);
      seen.add(id);
    }
    ids[collection] = seen;
  }

  const goalIds = ids.goals || new Set();
  for (const g of (Array.isArray(data.goals) ? data.goals : [])) {
    if (g && g.parentId && !goalIds.has(g.parentId)) {
      orphans.push({ id: g.id, parentId: g.parentId, title: g.title });
    }
  }

  if (isBadDate(data.updatedAt)) {
    anomalies.push({ code: 'BAD_DATE', detail: `meta.updatedAt = ${JSON.stringify(data.updatedAt)}` });
  }
  if (isBadCycle(data.cycle)) {
    anomalies.push({ code: 'BAD_CYCLE', detail: `meta.cycle = ${JSON.stringify(data.cycle)}` });
  }
  for (const r of (Array.isArray(data.reports) ? data.reports : [])) {
    if (!r) continue;
    if (isBadDate(r.updatedAt)) anomalies.push({ code: 'BAD_DATE', detail: `report ${r.id}.updatedAt = ${JSON.stringify(r.updatedAt)}` });
    if (isBadCycle(r.cycle)) anomalies.push({ code: 'BAD_CYCLE', detail: `report ${r.id}.cycle = ${JSON.stringify(r.cycle)}` });
  }
  for (const u of (Array.isArray(data.users) ? data.users : [])) {
    if (!u) continue;
    if (isBadDate(u.createdAt)) anomalies.push({ code: 'BAD_DATE', detail: `user ${u.userId}.createdAt = ${JSON.stringify(u.createdAt)}` });
  }

  const reportKeys = new Set();
  for (const r of (Array.isArray(data.reports) ? data.reports : [])) {
    if (!r) continue;
    const key = `${r.owner}|${r.kind}|${r.cycle}`;
    if (reportKeys.has(key)) reportDuplicates.push(key);
    reportKeys.add(key);
  }

  return { duplicates, orphans, anomalies, reportDuplicates };
}

function insertCollection(data, collection) {
  const list = Array.isArray(data[collection]) ? data[collection] : [];
  let inserted = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (collection === 'goals') {
      if (!item.id) continue;
      if (db.insertRowIfAbsent('goals', item.id, item, {
        parentId: item.parentId || null,
        owner: item.owner || null
      })) inserted++;
    } else if (collection === 'reports') {
      if (!item.id) continue;
      if (db.insertRowIfAbsent('reports', item.id, item, {
        owner: item.owner || '',
        kind: item.kind || '',
        cycle: item.cycle || ''
      })) inserted++;
    } else if (collection === 'users') {
      if (!item.userId) continue;
      if (db.insertRowIfAbsent('users', item.userId, item)) inserted++;
    } else {
      if (!item.id) continue;
      if (db.insertRowIfAbsent(collection, item.id, item)) inserted++;
    }
  }
  return inserted;
}

function main() {
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`[001_init] 找不到数据文件：${DATA_PATH}`);
    console.error('[001_init] 本地开发请先复制 web/data.example.json 为 web/data.json');
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (e) {
    console.error(`[001_init] data.json 不是合法 JSON：${e.message}`);
    process.exit(1);
  }

  db.init();
  log(`驱动：${db.driver}`);
  log(`数据源：${DATA_PATH}`);
  log(`目标库：${db.DB_PATH}`);

  const already = db.getMigration(VERSION);
  let backup = null;
  if (!already) {
    backup = backupDataFile();
    log(`已备份：${backup}`);
  } else {
    log(`迁移 ${VERSION} 已于 ${already.applied_at} 执行过；本次只补缺失记录（幂等）`);
  }

  const before = {};
  for (const c of COLLECTIONS) before[c] = Array.isArray(data[c]) ? data[c].length : 0;
  const inspection = inspect(data);

  log('数据体检：');
  log(`  重复 ID：${inspection.duplicates.length}${inspection.duplicates.length ? ' → ' + inspection.duplicates.join(', ') : ''}`);
  log(`  孤立 parentId：${inspection.orphans.length}`);
  for (const o of inspection.orphans) {
    log(`    - ${o.id} → parentId ${o.parentId} 不存在（${o.title || '无标题'}）`);
  }
  log(`  重复 (owner,kind,cycle)：${inspection.reportDuplicates.length}${inspection.reportDuplicates.length ? ' → ' + inspection.reportDuplicates.join(', ') : ''}`);
  log(`  日期/周期格式异常：${inspection.anomalies.length}`);
  for (const a of inspection.anomalies) log(`    - [${a.code}] ${a.detail}`);

  const inserted = {};
  const runMigration = db.transaction(() => {
    for (const [key, value] of Object.entries(data)) {
      if (COLLECTIONS.includes(key)) continue;
      // 已知 meta + 未知顶层字段都保留，避免丢字段。
      db.insertMetaIfAbsent(key, value);
    }
    for (const c of COLLECTIONS) inserted[c] = insertCollection(data, c);
    db.recordMigration(VERSION);
  });
  runMigration();

  const after = db.counts();
  log('迁移前后条数对比（data.json → SQLite）：');
  for (const c of COLLECTIONS) {
    log(`  ${c.padEnd(8)} ${String(before[c]).padStart(4)} → ${String(after[c]).padStart(4)}（本次新增 ${inserted[c]}）`);
  }
  log(`  events   ${'0'.padStart(4)} → ${String(after.events).padStart(4)}（迁移本身不写业务事件）`);
  log(`  meta keys：${db.all('SELECT key FROM meta').map(r => r.key).join(', ')}`);

  const mismatched = COLLECTIONS.filter(c => after[c] !== before[c]);
  if (mismatched.length) {
    log(`注意：${mismatched.join(', ')} 的条数与 data.json 不一致（可能是重复 ID 被跳过，或库中已有额外记录）`);
  } else {
    log('OK：五张表条数与 data.json 完全一致');
  }

  db.close();
}

main();
