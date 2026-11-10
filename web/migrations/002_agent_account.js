/**
 * 创建 Agent 专用账号（role = 'agent'）
 *
 * 用途：Agent-01 / Agent-02 等 Agent 代员工写入周报时使用。
 * 特点：
 *   - 不是人，没有 personId 对应的人员记录
 *   - 可代写任意员工的周报（server.js 里 role === 'agent' 放行）
 *   - 每次代写都记录 createdBy，可追溯是谁提交的
 *
 * 用法：
 *   node web/migrations/002_agent_account.js "<账号名>" ["<显示名>"]
 *   例：node web/migrations/002_agent_account.js agent2 "Agent-02"
 *
 * 密码从环境变量 GOALOS_AGENT_PASS 读取；未设置则随机生成并打印一次。
 * ⚠️ 不修改 users[].passHash / salt / apiToken 的生成逻辑，与现有账号一致。
 */
const crypto = require('crypto');
const path = require('path');
const db = require(path.join(__dirname, '..', 'lib', 'db.js'));
const store = require(path.join(__dirname, '..', 'lib', 'store.js'));

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const rid = (p) => p + '_' + crypto.randomBytes(5).toString('hex');

const login = String(process.argv[2] || '').trim();
const display = String(process.argv[3] || login).trim();

if (!login) {
  console.error('用法：node web/migrations/002_agent_account.js "<账号名>" ["<显示名>"]');
  process.exit(1);
}

const data = db.loadAll();
const exists = (data.users || []).find(u => u.name === login && u.role === 'agent');
if (exists) {
  console.log(`[002] 已存在 agent 账号：${login}（userId=${exists.userId}）`);
  process.exit(0);
}

const pass = process.env.GOALOS_AGENT_PASS || crypto.randomBytes(12).toString('base64url');
const salt = crypto.randomBytes(8).toString('hex');

const user = {
  userId: rid('u'),
  personId: null,            // Agent 不是人
  name: display,
  login,                     // 明确登录名，避免与人员姓名冲突
  role: 'agent',
  salt,
  passHash: hash(pass, salt),
  apiToken: crypto.randomBytes(24).toString('hex'),
  createdAt: new Date().toISOString(),
};

store.createUser(user);

console.log('[002] 已创建 agent 账号');
console.log('  userId   :', user.userId);
console.log('  登录名   :', login);
console.log('  apiToken :', user.apiToken);
if (!process.env.GOALOS_AGENT_PASS) {
  console.log('  密码     :', pass, '  ← 只显示这一次，请立刻保存');
} else {
  console.log('  密码     : (来自 GOALOS_AGENT_PASS 环境变量)');
}
console.log('\n⚠️ 该 token 可代写任意员工周报，请只配给受信任的 Agent。');
