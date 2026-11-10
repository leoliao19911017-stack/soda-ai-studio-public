'use strict';
/** smoke.js — 离线跑一段真实对话，不接飞书。用于调提示词和缺口逻辑。 */
const brain = require('./brain');

const turns = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      '这周把知识库问答在客户现场本地部署跑通了，客户是华东区的宁波银行，周三上线；另外拍了 3 条产品演示视频，剪好 2 条',
      '上周定的目标是部署跑通和视频拍摄，算是都完成了。风险是客户网络受限，部署多花了 1 天。下周准备做验收测试，10 道问数题要全过，潜在风险是数据权限还没开，需要找产品组张伟讲解一次',
      '无',
      '预期结果是客户验收通过出验收报告，之后走正式采购流程',
      '确认'
    ];

(async () => {
  let session = brain.newSession();
  for (const [i, t] of turns.entries()) {
    console.log(`\n${'═'.repeat(70)}\n👤 用户 ${i + 1}: ${t}\n${'─'.repeat(70)}`);
    const r = await brain.handle({ text: t, session });
    session = r.session;
    console.log('🤖 助手:\n' + r.reply);
    if (r.action) console.log('\n>>> ACTION:', JSON.stringify(r.action, null, 2));
  }
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
