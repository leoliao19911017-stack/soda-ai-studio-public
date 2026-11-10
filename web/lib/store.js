'use strict';
/**
 * 业务写操作。每个写操作 = 一个 SQLite 事务 + 同事务 events 记录。
 *
 * 权限判断放在事务内（基于数据库里的 owner），而不是基于请求体里
 * 自报的身份，防止并发窗口内越权。
 */
const crypto = require('crypto');
const db = require('./db');

const rid = (p) => p + '_' + crypto.randomBytes(5).toString('hex');
const nowIso = () => new Date().toISOString();

function httpError(message, status) {
  const err = new Error(message);
  err.status = status || 400;
  return err;
}

const tx = db.transaction;

/* ── 目标 ─────────────────────────────────────────── */

function cleanGoal(me, input, existing) {
  const isAdmin = me.role === 'admin';
  const clean = {
    id: input.id ? String(input.id) : (existing ? existing.id : rid('g')),
    title: String(input.title || '').slice(0, 300),
    owner: isAdmin ? (input.owner || me.personId) : me.personId,
    level: ['公司大目标', '季度目标', '月度计划', '周目标'].includes(input.level) ? input.level : '周目标',
    parentId: input.parentId || null,
    status: input.status || '进行中',
    progress: Math.max(0, Math.min(100, Number(input.progress) || 0)),
    note: String(input.note || '').slice(0, 1000)
  };
  if (!clean.title) throw httpError('目标不能为空', 400);
  if (clean.parentId === clean.id) clean.parentId = null;
  return clean;
}

function upsertGoal(me, input, baseVersion) {
  return tx(() => {
    const id = input.id ? String(input.id) : null;
    const row = id ? db.getRow('goals', id) : null;
    const existing = row ? { ...row.obj, version: row.version } : null;
    const isAdmin = me.role === 'admin';

    if (existing && !isAdmin && existing.owner !== me.personId) {
      throw httpError('只能修改自己的目标', 400);
    }
    if (!existing && !isAdmin && input.owner && input.owner !== me.personId) {
      throw httpError('只能给自己建目标', 400);
    }

    const expected = input.version !== undefined ? Number(input.version)
      : (baseVersion !== undefined ? Number(baseVersion) : (existing ? existing.version : undefined));
    if (existing && expected !== undefined && Number(expected) !== existing.version) {
      throw new db.VersionConflictError('目标已被他人修改，请刷新后重试');
    }

    const clean = cleanGoal(me, input, existing);
    let saved;
    let version;
    if (existing) {
      // 与旧实现 Object.assign(rec, clean) 一致：保留 clean 之外的字段
      // （例如 placeholder、未来新增字段），只覆盖本次提交的字段。
      saved = { ...existing, ...clean };
      version = db.updateRow('goals', clean.id, saved, existing.version, {
        parentId: clean.parentId, owner: clean.owner
      });
    } else {
      saved = clean;
      try {
        version = db.insertRow('goals', clean.id, saved, {
          parentId: clean.parentId, owner: clean.owner
        });
      } catch (e) {
        if (/UNIQUE|constraint/i.test(String(e.message))) {
          throw new db.VersionConflictError('目标已被他人创建，请刷新后重试');
        }
        throw e;
      }
    }

    db.addEvent(clean.id, 'goal.upsert', {
      actor: me.personId,
      action: existing ? 'update' : 'create',
      owner: clean.owner,
      progress: clean.progress,
      version
    });
    return { ...saved, version };
  })();
}

function deleteGoal(me, id) {
  return tx(() => {
    const row = db.getRow('goals', String(id));
    if (!row) throw httpError('目标不存在', 404);
    if (me.role !== 'admin' && row.obj.owner !== me.personId) {
      throw httpError('只能删自己的目标', 403);
    }

    db.deleteRow('goals', String(id));
    db.addEvent(String(id), 'goal.delete', { actor: me.personId, title: row.obj.title });

    // 与旧实现一致：删父目标时，子目标的 parentId 置空（不连带删除）。
    const children = db.all('SELECT id, json, version FROM goals WHERE parentId = ?', String(id));
    for (const child of children) {
      const obj = JSON.parse(child.json);
      obj.parentId = null;
      db.updateRow('goals', child.id, obj, child.version, { parentId: null });
      db.addEvent(child.id, 'goal.detach', { actor: me.personId, formerParentId: String(id) });
    }
    return true;
  })();
}

/* ── 汇报 ─────────────────────────────────────────── */

function upsertReport(me, input, baseVersion) {
  return tx(() => {
    // 周报全员可见、透明化：admin 与 agent 可代员工写入，member 只能写自己。
    const canWriteOthers = me.role === 'admin' || me.role === 'agent';
    const owner = canWriteOthers ? (input.owner || me.personId) : me.personId;
    // owner 允许传姓名/昵称，统一解析成 personId，避免存进 "Sam Lee" 这种脏数据。
    const people = db.loadAll().people || [];
    if (owner && !people.some(p => p.id === owner)) {
      const hit = people.find(p => p.name === owner || p.nickname === owner);
      if (hit) input = { ...input, owner: hit.id };
      else throw httpError(`找不到人员：${owner}`, 400);
    }
    const kind = input.kind === 'monthly' ? 'monthly' : 'weekly';
    const cycle = String(input.cycle || '').slice(0, 20);
    if (!cycle) throw httpError('周期不能为空', 400);

    const row = db.get('SELECT id, json, version FROM reports WHERE owner = ? AND kind = ? AND cycle = ?',
      owner, kind, cycle);
    const expected = input.version !== undefined ? Number(input.version)
      : (baseVersion !== undefined ? Number(baseVersion) : (row ? Number(row.version) : undefined));
    if (row && expected !== undefined && Number(expected) !== Number(row.version)) {
      throw new db.VersionConflictError('周报已被他人修改，请刷新后重试');
    }

    const rec = {
      id: row ? row.id : rid('r'),
      owner,
      kind,
      cycle,
      fields: input.fields && typeof input.fields === 'object' ? input.fields : {},
      status: input.status === '已提交' ? '已提交' : '草稿',
      updatedAt: nowIso()
    };

    let version;
    if (row) {
      version = db.updateRow('reports', rec.id, rec, Number(row.version), { owner, kind, cycle });
    } else {
      try {
        version = db.insertRow('reports', rec.id, rec, { owner, kind, cycle });
      } catch (e) {
        if (/UNIQUE|constraint/i.test(String(e.message))) {
          throw new db.VersionConflictError('周报已被他人提交，请刷新后重试');
        }
        throw e;
      }
    }

    db.addEvent(rec.id, 'report.upsert', {
      actor: me.personId, owner, kind, cycle, status: rec.status, version
    });
    return { ...rec, version };
  })();
}

/* ── 人员 / Agent / 账号 ─────────────────────────── */

function applyPerson(clean, newUser) {
  return tx(() => {
    const row = db.getRow('people', clean.id);
    let version;
    let saved = clean;
    if (row) {
      saved = { ...row.obj, ...clean };
      version = db.updateRow('people', clean.id, saved, row.version);
    } else {
      version = db.insertRow('people', clean.id, saved);
    }

    let createdUser = false;
    if (newUser && !db.getRow('users', newUser.userId)) {
      db.insertRow('users', newUser.userId, newUser);
      createdUser = true;
      db.addEvent(newUser.userId, 'user.create', {
        actor: 'system', personId: clean.id, role: newUser.role
      });
    }

    db.addEvent(clean.id, 'person.upsert', {
      actor: 'admin', action: row ? 'update' : 'create', name: clean.name, userCreated: createdUser
    });
    return { ...saved, version };
  })();
}

function deletePerson(id) {
  return tx(() => {
    const row = db.getRow('people', String(id));
    if (!row) return false;

    db.deleteRow('people', String(id));

    // users 表没有 personId 列，按 JSON 字段删（账号量级很小）。
    for (const u of db.all('SELECT id, json FROM users')) {
      const obj = JSON.parse(u.json);
      if (obj.personId === String(id)) {
        db.deleteRow('users', u.id);
        db.addEvent(u.id, 'user.delete', { actor: 'admin', personId: String(id) });
      }
    }

    // 与旧实现一致：被删人员的目标保留，owner 置空。
    const goals = db.all('SELECT id, json, version FROM goals WHERE owner = ?', String(id));
    for (const g of goals) {
      const obj = JSON.parse(g.json);
      obj.owner = '';
      db.updateRow('goals', g.id, obj, g.version, { owner: '' });
      db.addEvent(g.id, 'goal.owner.clear', { actor: 'admin', formerOwner: String(id) });
    }

    db.addEvent(String(id), 'person.delete', { actor: 'admin', name: row.obj.name });
    return true;
  })();
}

function updatePersonRecord(personId, patch, eventType) {
  return tx(() => {
    const row = db.getRow('people', String(personId));
    if (!row) throw httpError('找不到档案', 404);
    const clean = { ...row.obj };
    for (const [k, v] of Object.entries(patch)) {
      if (k !== 'version' && k !== 'id') clean[k] = v;
    }
    const version = db.updateRow('people', String(personId), clean, row.version);
    db.addEvent(String(personId), eventType || 'person.update', {
      actor: personId, fields: Object.keys(patch).filter(k => k !== 'version')
    });
    return { ...clean, version };
  })();
}

function applyAgent(clean) {
  return tx(() => {
    const row = db.getRow('agents', clean.id);
    let version;
    let saved = clean;
    if (row) {
      saved = { ...row.obj, ...clean };
      version = db.updateRow('agents', clean.id, saved, row.version);
    } else {
      version = db.insertRow('agents', clean.id, saved);
    }
    db.addEvent(clean.id, 'agent.upsert', {
      actor: 'admin', action: row ? 'update' : 'create', name: clean.name
    });
    return { ...saved, version };
  })();
}

function deleteAgent(id) {
  return tx(() => {
    const row = db.getRow('agents', String(id));
    if (!row) return false;
    db.deleteRow('agents', String(id));
    db.addEvent(String(id), 'agent.delete', { actor: 'admin', name: row.obj.name });
    return true;
  })();
}

function createUser(user) {
  return tx(() => {
    if (db.getRow('users', user.userId)) return false;
    db.insertRow('users', user.userId, user);
    db.addEvent(user.userId, 'user.create', {
      actor: 'system', personId: user.personId, role: user.role
    });
    return true;
  })();
}

/** 管理员改账号：fn 直接修改传入的对象。 */
function mutateUser(userId, fn, eventType, payload) {
  return tx(() => {
    const row = db.getRow('users', String(userId));
    if (!row) throw httpError('账号不存在', 404);
    const obj = { ...row.obj };
    fn(obj);
    const version = db.updateRow('users', String(userId), obj, row.version);
    db.addEvent(String(userId), eventType || 'user.update', {
      actor: 'admin', ...(payload || {})
    });
    return { ...obj, version };
  })();
}

function setMeta(key, value) {
  return tx(() => {
    db.setMeta(key, value);
    db.addEvent(null, 'meta.update', { key, value });
    return value;
  })();
}

/**
 * 启动时补账号。与旧 ensureUsers 行为一致：每个没有账号的人建一个，
 * isTop 为 admin，默认密码哈希由调用方传入（不在此处改算法）。
 */
function ensureUsers(people, users, makeUser) {
  const existing = new Set(users.map(u => u.personId));
  let created = 0;
  for (const p of people) {
    if (existing.has(p.id)) continue;
    const user = makeUser(p);
    if (createUser(user)) created++;
  }
  return created;
}

module.exports = {
  loadData: db.loadAll,
  upsertGoal,
  deleteGoal,
  upsertReport,
  applyPerson,
  deletePerson,
  updatePersonRecord,
  applyAgent,
  deleteAgent,
  createUser,
  mutateUser,
  setMeta,
  ensureUsers
};
