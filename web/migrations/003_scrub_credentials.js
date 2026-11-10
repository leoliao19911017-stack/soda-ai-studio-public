/**
 * 003_scrub_credentials.js — 生成可入库的 data.json（剥离凭证）
 *
 * 用途：把 web/data.json 里的人员/目标/周报等业务数据推进私有仓库，
 *       但剥离两类凭证，避免长期有效 token 泄露：
 *         1. users[].passHash / salt   —— 密码哈希
 *         2. users[].apiToken          —— 长期有效的 Bearer token（最危险）
 *
 * 产出：web/data.repo.json
 *       - 保留：公司、人员名单、目标、周报、Agent 名册、user 的 name/role/personId
 *       - 置空：passHash / salt / apiToken
 *
 * 注意：这不是「脱敏展示版」，它是「可直接喂给 server 启动的真实结构」，
 *       只是凭证字段为空。首次登录前需要跑 reset 脚本重设密码。
 *
 * 用法：node web/migrations/003_scrub_credentials.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data.json');
const OUT = path.join(ROOT, 'data.repo.json');

if (!fs.existsSync(SRC)) {
  console.error('找不到 web/data.json');
  process.exit(1);
}

const d = JSON.parse(fs.readFileSync(SRC, 'utf8'));

let scrubbed = 0;
const users = (d.users || []).map((u) => {
  const next = { ...u };
  delete next.passHash;
  delete next.salt;
  delete next.apiToken;
  scrubbed++;
  return next;
});

const out = { ...d, users };
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');

console.log('[003] 已生成', path.relative(process.cwd(), OUT));
console.log('  人员 :', (out.people || []).length);
console.log('  目标 :', (out.goals || []).length);
console.log('  周报 :', (out.reports || []).length);
console.log('  Agent:', (out.agents || []).length);
console.log('  账号 :', users.length, '（已剥离 passHash / salt / apiToken）');
console.log('\n⚠️ 该文件不含任何可用凭证，可安全提交到私有仓库。');
console.log('⚠️ 其他人 clone 后需先设密码，见 web/migrations/004_reset_password.js');
