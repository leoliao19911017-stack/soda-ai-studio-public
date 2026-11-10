'use strict';
/**
 * setup.js — 按 schema.json 在飞书里建出整套多维表格。
 *
 * 设计成可重复执行：公司推广给同事时，改一下 base 名再跑一遍就是一个新实例；
 * 排障时也能单独跑某一步。产出 config.json 供服务层读取。
 *
 * 用法: node setup.js            # 全量建
 *       node setup.js --base-only
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROFILE = process.env.GOALOS_PROFILE || 'soda';
const IDENTITY = process.env.GOALOS_AS || 'bot';
const ROOT = __dirname;
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'schema.json'), 'utf8'));
const CONFIG_PATH = path.join(ROOT, '..', 'config.json');

// Windows 上 lark-cli 是 .ps1/.cmd 壳，execFileSync 直接调会失败；
// 直连它的 Node 入口既能跨平台，也避免 JSON 参数被 shell 二次解释。
const LARK_RUN = process.env.LARK_CLI_ENTRY ||
  path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');

function cli(args) {
  const full = [LARK_RUN, '--profile', PROFILE, ...args];
  let out;
  try {
    out = execFileSync(process.execPath, full, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const msg = (e.stdout || '') + (e.stderr || '');
    throw new Error(`lark-cli ${args.slice(0, 3).join(' ')} 失败:\n${msg.slice(0, 1500)}`);
  }
  const s = out.trim();
  const i = s.indexOf('{');
  const body = i >= 0 ? s.slice(i) : s;
  let json;
  try {
    json = JSON.parse(body);
  } catch (_) {
    throw new Error('无法解析输出: ' + s.slice(0, 500));
  }
  if (json.ok === false) throw new Error('API 失败: ' + JSON.stringify(json.error).slice(0, 800));
  return json;
}

const j = (o) => JSON.stringify(o);

function fieldPayload(f) {
  const out = { name: f.name, type: f.type };
  if (f.description) out.description = f.description;
  if (f.multiple !== undefined) out.multiple = f.multiple;
  if (f.options) out.options = f.options;
  if (f.default_value !== undefined) out.default_value = f.default_value;
  if (f.style) out.style = f.style;
  if (f.expression) out.expression = f.expression;
  if (f.link_table) out.link_table = f.link_table;
  return out;
}

function createTable(baseToken, table) {
  const inline = table.fields.filter((f) => f.type !== 'link' && f.type !== 'formula');
  const r = cli([
    'base', '+table-create',
    '--base-token', baseToken,
    '--name', table.name,
    '--fields', j(inline.map(fieldPayload)),
    '--format', 'json'
  ]);
  const tableId = r.table_id || r.data?.table_id || r.table?.table_id;
  if (!tableId) throw new Error('建表没拿到 table_id: ' + j(r).slice(0, 400));
  return { tableId, created: r };
}

function addFields(baseToken, tableId, fields, extraArgs = []) {
  if (!fields.length) return;
  cli([
    'base', '+field-create',
    '--base-token', baseToken,
    '--table-id', tableId,
    '--json', j(fields.map(fieldPayload)),
    ...extraArgs,
    '--format', 'json'
  ]);
}

(async () => {
  const cfg = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
  let baseToken = cfg.base_token;

  // 1) 建 Base（用第一张表的非关联字段作为初始 schema）
  if (!baseToken) {
    const first = SCHEMA.tables[0];
    const inline = first.fields.filter((f) => f.type !== 'link' && f.type !== 'formula');
    console.log(`→ 创建 Base: ${SCHEMA.base_name}`);
    const r = cli([
      'base', '+base-create',
      '--name', SCHEMA.base_name,
      '--time-zone', SCHEMA.time_zone || 'Asia/Shanghai',
      '--table-name', first.name,
      '--fields', j(inline.map(fieldPayload)),
      '--as', IDENTITY,
      '--format', 'json'
    ]);
    baseToken = r.app_token || r.data?.app?.app_token || r.base_token;
    if (!baseToken) throw new Error('建 Base 没拿到 app_token: ' + j(r).slice(0, 600));

    const firstTableId = r.table_id || r.data?.table_id || r.default_table_id;
    cfg.base_token = baseToken;
    cfg.base_url = `https://feishu.cn/base/${baseToken}`;
    cfg.tables = {};
    if (firstTableId) cfg.tables[first.name] = firstTableId;
    if (r.permission_grant) cfg.permission_grant = r.permission_grant;

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    console.log(`  base_token = ${baseToken}`);
  } else {
    console.log(`→ 复用已有 Base: ${baseToken}`);
  }

  cfg.tables = cfg.tables || {};

  // 2) 补齐其余表
  for (const table of SCHEMA.tables) {
    if (cfg.tables[table.name]) {
      console.log(`· 跳过已存在表: ${table.name}`);
      continue;
    }
    console.log(`→ 建表: ${table.name}`);
    const { tableId } = createTable(baseToken, table);
    cfg.tables[table.name] = tableId;
    cfg.table_ids = cfg.table_ids || {};
    cfg.table_ids[tableId] = table.name;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  }

  // 3) 关联字段（必须等所有表都在）
  for (const table of SCHEMA.tables) {
    const links = table.fields.filter((f) => f.type === 'link');
    if (!links.length) continue;
    console.log(`→ ${table.name}: 关联字段 ${links.map((f) => f.name).join('、')}`);
    for (const f of links) {
      try {
        addFields(baseToken, cfg.tables[table.name], [f]);
      } catch (e) {
        if (/already exists|已存在|duplicate/i.test(e.message)) {
          console.log('  (已存在，跳过)');
        } else throw e;
      }
    }
  }

  // 4) 公式字段（依赖前面所有列）
  for (const d of SCHEMA.derived_fields || []) {
    const tableId = cfg.tables[d.table];
    if (!tableId) continue;
    console.log(`→ ${d.table}: 公式字段 ${d.name}`);
    try {
      cli([
        'base', '+field-create',
        '--base-token', baseToken,
        '--table-id', tableId,
        '--json', j({ name: d.name, type: 'formula', expression: d.expression }),
        '--i-have-read-guide',
        '--format', 'json'
      ]);
    } catch (e) {
      if (/already exists|已存在|duplicate/i.test(e.message)) console.log('  (已存在，跳过)');
      else console.log('  ! 跳过（公式可能需要手工调整）: ' + e.message.slice(0, 300));
    }
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log('\n✅ 完成');
  console.log('Base:', cfg.base_url || baseToken);
  console.log('表 ID:', j(cfg.tables, null, 2));
  if (cfg.permission_grant) console.log('permission_grant:', j(cfg.permission_grant));
})().catch((e) => {
  console.error('\n❌ ' + e.message);
  process.exit(1);
});
