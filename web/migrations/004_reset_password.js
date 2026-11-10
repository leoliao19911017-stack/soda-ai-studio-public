/**
 * 004_reset_password.js — 重设某个账号的密码
 *
 * 场景：从仓库拉下来 data.json（凭证已剥离）后，首次登录前必须设密码。
 *
 * 用法：
 *   node web/migrations/004_reset_password.js <账号名> <新密码>
 *   例：node web/migrations/004_reset_password.js Sam Lee 'my-new-pass'
 *
 * 与现有账号的哈希方式一致（scrypt + salt），不改变生成逻辑。
 */
const crypto = require('crypto');
const path = require('path');
const db = require(path.join(__dirname, '..', 'lib', 'db.js'));

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');

const login = String(process.argv[2] || '').trim();
const pass = String(process.argv[3] || '');

if (!login || !pass) {
  console.error('用法：node web/migrations/004_reset_password.js <账号名> <新密码>');
  process.exit(1);
}
if (pass.length < 6) {
  console.error('密码至少 6 位');
  process.exit(1);
}

const data = db.loadAll();
const user = (data.users || []).find(u => u.name === login || u.login === login);
if (!user) {
  console.error(`找不到账号：${login}`);
  console.error('现有账号：' + (data.users || []).map(u => u.name).join(', '));
  process.exit(1);
}

const salt = crypto.randomBytes(8).toString('hex');
const next = { ...user, salt, passHash: hash(pass, salt) };

// 顺带换掉 apiToken，避免旧 token 继续可用
const hadToken = !!user.apiToken;
if (hadToken) next.apiToken = crypto.randomBytes(24).toString('hex');

db.updateRow('users', user.userId, next, undefined);

console.log(`[004] 已重设密码：${user.name}（${user.role}）`);
if (hadToken) console.log('      apiToken 已同步轮换');
