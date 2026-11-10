'use strict';
/**
 * Soda AI Studio — 目标与汇报系统
 * 单文件 Node 服务：登录鉴权 / 人员与 Agent 配置 / 目标 / 周月报 / Agent 接口
 *
 * Phase 1：存储由 web/data.json 迁到 SQLite（web/lib/db.js），对外 URL 与
 * 响应形状保持不变；新增 POST /api/v1/context/assemble。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./lib/store');
const contextApi = require('./lib/context');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
const DEFAULT_PASS = process.env.GOALOS_DEFAULT_PASS || 'CHANGE_ME_BEFORE_USE';

/* ── 账号 ───────────────────────────────────────────── */
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const rid = (p) => p + '_' + crypto.randomBytes(5).toString('hex');
const token = () => crypto.randomBytes(24).toString('hex');

/** 首次启动：给每个人建账号，涛哥是管理员（哈希/Token 生成逻辑未改） */
function ensureUsers() {
  const d = store.loadData();
  const created = store.ensureUsers(d.people, d.users, (p) => {
    const salt = crypto.randomBytes(8).toString('hex');
    return {
      userId: rid('u'), personId: p.id, name: p.name,
      role: p.isTop ? 'admin' : 'member',
      salt, passHash: hash(DEFAULT_PASS, salt),
      apiToken: token(), createdAt: new Date().toISOString()
    };
  });
  if (created) console.log(`created ${created} account(s)`);
}

/* ── 会话 ───────────────────────────────────────────── */
const sessions = new Map(); // token -> {userId, exp}
const DAY = 86400e3;

function userByCookie(req) {
  const raw = req.headers.cookie || '';
  const m = /(?:^|;\s*)gos=([a-f0-9]{48})/.exec(raw);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || s.exp < Date.now()) { sessions.delete(m[1]); return null; }
  const d = store.loadData();
  return d.users.find(u => u.userId === s.userId) || null;
}
function userByBearer(req) {
  const m = /^Bearer\s+([a-f0-9]{48})$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const d = store.loadData();
  return d.users.find(u => u.apiToken === m[1]) || null;
}
const auth = (req) => userByCookie(req) || userByBearer(req);

/* ── HTTP 工具 ──────────────────────────────────────── */
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const body = (req) => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 2e6) req.destroy(); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.gif': 'image/gif', '.ttf': 'font/ttf', '.css': 'text/css', '.js': 'text/javascript'
};

/* ── 业务 ───────────────────────────────────────────── */
const LEVELS = ['公司大目标', '季度目标', '月度计划', '周目标'];
const aligned = (d, g) => {
  const by = new Map(d.goals.map(x => [x.id, x]));
  let cur = g, n = 0, root = null;
  while (cur && n++ < 20) { root = cur; cur = cur.parentId ? by.get(cur.parentId) : null; }
  return g.level === '公司大目标' || (!!root && root.level === '公司大目标');
};
function publicData(d, me) {
  const isAdmin = me.role === 'admin';
  return {
    people: d.people, agents: d.agents,
    goals: d.goals.map(g => ({ ...g, aligned: aligned(d, g) })),
    reports: d.reports,
    me: { personId: me.personId, name: me.name, role: me.role, isAdmin },
    levels: LEVELS
  };
}

/* ── 路由 ───────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  // 支持挂在子路径下（如 https://host/staging/），剥掉前缀后按原路由处理。
  // 只有显式设置 BASE_PATH 才启用；主站不设，路径原样处理。
  const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');
  let p = u.pathname;
  if (BASE_PATH && p.startsWith(BASE_PATH + '/')) p = p.slice(BASE_PATH.length);
  else if (BASE_PATH && p === BASE_PATH) p = '/';

  try {
    /* --- 登录 --- */
    if (p === '/api/login' && req.method === 'POST') {
      const b = await body(req);
      const d = store.loadData();
      const name = String(b.name || '').trim();
      const person = d.people.find(x => x.name === name || x.nickname === name || x.id === name);
      const user = (person && d.users.find(u2 => u2.personId === person.id))
        || d.users.find(x => x.name === name || x.login === name);
      if (!user || hash(String(b.password || ''), user.salt) !== user.passHash) {
        return json(res, 401, { ok: false, error: '姓名或密码不对' });
      }
      const t = token();
      sessions.set(t, { userId: user.userId, exp: Date.now() + 7 * DAY });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `gos=${t}; HttpOnly; Path=/; Max-Age=${7 * 86400}; SameSite=Lax`
      });
      return res.end(JSON.stringify({ ok: true, name: user.name, role: user.role }));
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const raw = /(?:^|;\s*)gos=([a-f0-9]{48})/.exec(req.headers.cookie || '');
      if (raw) sessions.delete(raw[1]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'gos=; Path=/; Max-Age=0' });
      return res.end('{"ok":true}');
    }

    if (p === '/api/me' && req.method === 'GET') {
      const me = userByCookie(req) || userByBearer(req);
      if (!me) return json(res, 401, { ok: false });
      const d = store.loadData();
      const person = d.people.find(x => x.id === me.personId) || {};
      return json(res, 200, { ok: true, name: me.name, role: me.role, personId: me.personId, person });
    }

    /* --- 看板公开只读，写入才需要登录 --- */
    const me = auth(req);

    if (p === '/api/data' && req.method === 'GET') {
      const d = store.loadData();
      const viewer = me || { role: 'guest', personId: null, name: '访客', isAdmin: false };
      return json(res, 200, { ...publicData(d, viewer), loggedIn: !!me });
    }

    if (p.startsWith('/api/') && !me) return json(res, 401, { ok: false, error: '请先登录' });

    if (p === '/api/token' && req.method === 'GET') {
      return json(res, 200, { ok: true, token: me.apiToken });
    }

    /* --- Context Assembly API（Phase 1） --- */
    if (p === '/api/v1/context/assemble' && req.method === 'POST') {
      const b = await body(req);
      const d = store.loadData();
      const payload = contextApi.assemble(d, me, b);
      return json(res, 200, payload);
    }

    if (p === '/api/goals' && req.method === 'POST') {
      const g = await body(req);
      // 先取快照版本再写：两个并发请求会拿到同一个 version，后到的必冲突。
      const d = store.loadData();
      const current = g.id ? d.goals.find(x => x.id === g.id) : null;
      const saved = store.upsertGoal(me, g, current ? current.version : undefined);
      const fresh = store.loadData();
      return json(res, 200, { ok: true, goal: saved, aligned: aligned(fresh, saved) });
    }

    if (p === '/api/goals/delete' && req.method === 'POST') {
      const { id } = await body(req);
      store.deleteGoal(me, id);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/reports' && req.method === 'POST') {
      const r = await body(req);
      const d = store.loadData();
      // 周报全员可见、透明化：admin 与 agent 可代员工写入，member 只能写自己。
      const canWriteOthers = me.role === 'admin' || me.role === 'agent';
      if (canWriteOthers && !(r.owner || me.personId)) {
        return json(res, 400, { ok: false, error: '代写周报必须指定 owner' });
      }
      let owner = canWriteOthers ? (r.owner || me.personId) : me.personId;
      // owner 允许传姓名/昵称，统一解析成 personId
      if (owner && !d.people.some(x => x.id === owner)) {
        const hit = d.people.find(x => x.name === owner || x.nickname === owner);
        if (!hit) return json(res, 400, { ok: false, error: `找不到人员：${owner}` });
        owner = hit.id;
      }
      r.owner = owner;
      const kind = r.kind === 'monthly' ? 'monthly' : 'weekly';
      const cycle = String(r.cycle || '').slice(0, 20);
      const current = d.reports.find(x => x.owner === owner && x.kind === kind && x.cycle === cycle);
      const rec = store.upsertReport(me, r, current ? current.version : undefined);
      return json(res, 200, { ok: true, report: rec });
    }

    if (p === '/api/profile' && req.method === 'POST') {
      const b = await body(req);
      const d = store.loadData();
      const person = d.people.find(x => x.id === me.personId);
      if (!person) return json(res, 404, { ok: false, error: '找不到档案' });
      const patch = {};
      if (typeof b.role === 'string') patch.role = b.role.slice(0, 60);
      if (typeof b.avatar === 'string') patch.avatar = b.avatar.slice(0, 300);
      if (typeof b.bio === 'string') patch.bio = b.bio.slice(0, 300);
      const saved = store.updatePersonRecord(me.personId, patch, 'person.profile');
      return json(res, 200, { ok: true, person: saved });
    }

    if (p === '/api/password' && req.method === 'POST') {
      const b = await body(req);
      const d = store.loadData();
      const user = d.users.find(x => x.userId === me.userId);
      if (!user) return json(res, 404, { ok: false, error: '账号不存在' });
      if (hash(String(b.old || ''), user.salt) !== user.passHash) return json(res, 400, { ok: false, error: '旧密码不对' });
      if (String(b.next || '').length < 6) return json(res, 400, { ok: false, error: '新密码至少 6 位' });
      const salt = crypto.randomBytes(8).toString('hex');
      const passHash = hash(String(b.next), salt);
      store.mutateUser(user.userId, (u2) => { u2.salt = salt; u2.passHash = passHash; }, 'user.password', {});
      return json(res, 200, { ok: true });
    }

    /* --- 管理员 --- */
    if (p.startsWith('/api/admin/')) {
      if (me.role !== 'admin') return json(res, 403, { ok: false, error: '需要管理员权限' });
      const b = await body(req);
      const d = store.loadData();

      if (p === '/api/admin/people') {
        if (b.action === 'delete') {
          store.deletePerson(b.id);
        } else {
          const rec = d.people.find(x => x.id === b.id);
          const clean = {
            id: b.id || rid('p'),
            name: String(b.name || '').trim().slice(0, 40),
            nickname: String(b.nickname || '').slice(0, 40),
            role: String(b.role || '').slice(0, 60),
            team: String(b.team || '').slice(0, 40),
            avatar: String(b.avatar || '').slice(0, 300),
            agent: String(b.agent || '').slice(0, 60),
            reportsTo: b.reportsTo || null,
            isTop: !!b.isTop,
            placeholder: false
          };
          if (!clean.name) return json(res, 400, { ok: false, error: '姓名必填' });
          let newUser = null;
          if (!d.users.find(u2 => u2.personId === clean.id)) {
            const salt = crypto.randomBytes(8).toString('hex');
            newUser = {
              userId: rid('u'), personId: clean.id, name: clean.name, role: clean.isTop ? 'admin' : 'member',
              salt, passHash: hash(DEFAULT_PASS, salt), apiToken: token(), createdAt: new Date().toISOString()
            };
          }
          store.applyPerson(clean, newUser);
        }
        const fresh = store.loadData();
        return json(res, 200, { ok: true, people: fresh.people });
      }

      if (p === '/api/admin/agents') {
        if (b.action === 'delete') {
          store.deleteAgent(b.id);
        } else {
          const clean = {
            id: b.id || rid('a'),
            name: String(b.name || '').trim().slice(0, 40),
            role: String(b.role || '').slice(0, 60),
            note: String(b.note || '').slice(0, 200),
            avatar: String(b.avatar || '').slice(0, 300)
          };
          if (!clean.name) return json(res, 400, { ok: false, error: '名称必填' });
          store.applyAgent(clean);
        }
        const fresh = store.loadData();
        return json(res, 200, { ok: true, agents: fresh.agents });
      }

      if (p === '/api/admin/users') {
        const user = d.users.find(x => x.userId === b.userId || x.personId === b.personId);
        if (!user) return json(res, 404, { ok: false, error: '账号不存在' });
        const updated = store.mutateUser(user.userId, (u2) => {
          if (b.action === 'reset') {
            u2.salt = crypto.randomBytes(8).toString('hex');
            u2.passHash = hash(DEFAULT_PASS, u2.salt);
          }
          if (b.action === 'rotate') u2.apiToken = token();
          if (b.action === 'role') u2.role = b.role === 'admin' ? 'admin' : 'member';
        }, 'user.admin', { action: b.action });
        return json(res, 200, { ok: true, user: updated });
      }

      if (p === '/api/admin/users/list') {
        return json(res, 200, {
          ok: true,
          users: d.users.map(x => ({ ...x, passHash: undefined, salt: undefined }))
        });
      }

      if (p === '/api/admin/settings') {
        if (b.dataStatus) store.setMeta('dataStatus', b.dataStatus);
        const fresh = store.loadData();
        return json(res, 200, { ok: true, dataStatus: fresh.dataStatus });
      }
    }

    /* --- 静态 --- */
    if (req.method === 'GET') {
      const rel = decodeURIComponent(p === '/' ? '/index.html' : p).replace(/^\/+/, '');
      const abs = path.resolve(ROOT, rel);
      const base = path.basename(abs).toLowerCase();
      // 数据文件/备份/数据库含密码哈希，禁止被静态路由直接下载。
      if (/^(data\.json|data\.db(-wal|-shm)?|data\.test\.db.*|data\.json\.bak-.+)$/.test(base)) {
        return json(res, 404, { ok: false, error: 'not found' });
      }
      if (abs.startsWith(ROOT + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const ext = path.extname(abs).toLowerCase();
        res.writeHead(200, {
          'Content-Type': (ext === '.html' ? 'text/html; charset=utf-8' : MIME[ext] || 'application/octet-stream'),
          'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
        });
        return res.end(fs.readFileSync(abs));
      }
    }

    json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    const status = e.status || (e.code === 'VERSION_CONFLICT' ? 409 : 400);
    const out = { ok: false, error: e.message };
    if (e.code) out.code = e.code;
    json(res, status, out);
  }
});

ensureUsers();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Soda AI Studio running on :${PORT} (db: ${require('./lib/db').DB_PATH})`);
});
