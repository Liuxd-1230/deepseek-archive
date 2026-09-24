// 回放器回归测试。两部分：
//   1. 内置合成帧（永远可跑）——覆盖两种续传帧陷阱：
//      a) 省略 p 的数组帧是 BATCH 续传（CONTENT_FILTER 覆盖帧的真实形态）
//      b) update_session 等事件帧省略 p 但绝不能沿用上一路径
//   2. 用户真机导出的两份原始帧（文件还在才跑）——正常流 + 被过滤流
// 跑法：node test-rebuild.mjs
import { readFileSync, existsSync } from 'node:fs';
import { replayStream, parseSse } from './src/rebuild.js';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  —— ' + extra : ''}`);
  if (!cond) failures++;
}

// ---- 合成帧：被过滤流的最小完整形态 ----
const SYNTH = [
  'event: ready',
  'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
  '',
  'data: {"v":{"response":{"message_id":2,"status":"WIP","accumulated_token_usage":10,"fragments":[{"id":2,"type":"THINK","content":"","stage_id":1}]}}}',
  '',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"思考"}',
  '',
  'data: {"v":"继续"}',
  '',
  'data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":1.5}',
  '',
  'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"正文","stage_id":1}]}',
  '',
  'data: {"p":"response/fragments/-1/content","v":"更多"}',
  '',
  'data: {"v":"。"}',
  '',
  'data: {"p":"response","o":"BATCH","v":[{"p":"quasi_status","v":"FINISHED"}]}',
  '',
  'data: {"v":[{"p":"status","v":"CONTENT_FILTER"},{"p":"fragments","v":[{"id":4,"type":"TEMPLATE_RESPONSE","content":"模板话术"}]},{"p":"quasi_status","v":"CONTENT_FILTER"}]}',
  '',
  'event: update_session',
  'data: {"updated_at":1}',
  '',
  'event: close',
  'data: {"click_behavior":"none"}',
  '',
].join('\n');

console.log('[合成帧]');
const rs = replayStream(SYNTH);
check('省略 p 的数组帧被当作 BATCH 续传', rs.filtered === true && rs.status === 'CONTENT_FILTER');
check('正文跨三个片段拼完整', rs.response === '正文更多。', JSON.stringify(rs.response));
check('思考拼接且耗时被捕获', rs.think === '思考继续' && rs.thinkSecs === 1.5);
check('模板话术单独提取、不污染正文', rs.template === '模板话术' && !rs.response.includes('模板'));
check('update_session 事件帧不冲掉 status', rs.status === 'CONTENT_FILTER');
check('ready 帧消息 id', rs.responseMessageId === 2);

// ---- 解析器健壮性 ----
const evts = parseSse('event: ready\ndata: {"a":1}\n\ndata: {"b":2}\n\n');
check('parseSse 处理无 event 行的裸 data 帧', evts.length === 2 && evts[1].event === null);

// ---- 真机帧（附件还在才跑）----
const DIR = 'C:/Users/Rosemary/.cline/data/sessions/session_1790176981549_zx1z8/user-attachments';
const FILES = [
  `${DIR}/f579fce3-fc1e-4791-8520-885409551b9a-de29c2a6-1259-46c9-b196-a56725708b42.sse.txt`,
  `${DIR}/c51bb156-8f81-4d06-8d1f-62d11f0c7a4b-5a63910a-645a-445e-a14b-21d89c573469.sse.txt`,
];

// 导出文件头是 "# endpoint / # requestBody / # raw"，回放器只吃 raw 段
function rawOf(path) {
  const text = readFileSync(path, 'utf8');
  const i = text.indexOf('\n# raw\n');
  return i >= 0 ? text.slice(i + 7) : text;
}

if (!FILES.every(existsSync)) {
  console.log('\n[真机帧] 附件已不在，跳过（合成帧已覆盖关键路径）');
} else {

// ---- 文件 1：正常流 ----
const r1 = replayStream(rawOf(FILES[0]));
console.log('\n[文件1] prompt="继续"');
console.log(`  帧数=${r1.frames} 状态=${r1.status}/${r1.quasiStatus} 思考=${r1.think.length}字 正文=${r1.chars}字 filtered=${r1.filtered}`);
check('正常流未被标记过滤', r1.filtered === false);
check('状态正好是 FINISHED（不被后续事件帧冲掉）', r1.status === 'FINISHED');
check('解析出 ready 帧的消息 id', r1.responseMessageId === 38);
check('正文含「方向一」', r1.response.includes('方向一'));
check('正文含「清晨厨房」场景', r1.response.includes('清晨') && r1.response.includes('厨房'));
check('正文含结尾提问', r1.response.includes('你想看哪一个场景'));
check('思考全文在（含安全自查）', r1.think.includes('分析') && r1.think.includes('自查'));
check('思考耗时被 SET 帧捕获', typeof r1.thinkSecs === 'number' && r1.thinkSecs > 5 && r1.thinkSecs < 6, `elapsed=${r1.thinkSecs}`);

// ---- 文件 2：被过滤流（核心场景）----
const r2 = replayStream(rawOf(FILES[1]));
console.log('\n[文件2] prompt="阿黑颜…"');
console.log(`  帧数=${r2.frames} 状态=${r2.status}/${r2.quasiStatus} 思考=${r2.think.length}字 正文=${r2.chars}字 filtered=${r2.filtered}`);
check('被过滤流检出 CONTENT_FILTER', r2.filtered === true);
check('被过滤流状态正好是 CONTENT_FILTER', r2.status === 'CONTENT_FILTER');
check('fragments 确实被整体替换过', r2.fragmentsReplaced === true);
check('模板话术被单独捕获', (r2.template || '').includes('暂时无法回答'), r2.template);
check('擦除前正文完整恢复（方案一）', r2.response.includes('方案一'));
check('擦除前正文完整恢复（方案二）', r2.response.includes('方案二'));
check('正文含术语解释', r2.response.includes('阿') && r2.response.includes('颜'));
check('正文一直到结尾实操建议', r2.response.includes('实操建议'));
check('思维链也完整恢复', r2.think.includes('安全') && r2.think.length > 1000, `think=${r2.think.length}字`);
check('恢复的正文里不含模板话术污染', !r2.response.includes('让我们换个话题'));
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
