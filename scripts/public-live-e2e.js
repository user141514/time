#!/usr/bin/env node
/**
 * 公网端到端验收脚本（五步主流程 + 历史 + 每日跟踪）。
 *
 * 用法：
 *   node scripts/public-live-e2e.js [--base-url http://8.163.81.189:8011]
 *                                    [--scenario repro|acceptance]
 *                                    [--username xxx] [--verbose] [--show-report]
 *
 * 记录但不输出敏感正文：每个节点状态码、耗时、重试推断（5xx）、最终任务数、
 * 历史是否保存成功、每日跟踪是否出现重复任务。
 * 模型调用次数无法从客户端观测，留待部署后从服务器日志核验。
 */
const { randomUUID } = require('node:crypto');

const DEFAULT_BASE_URL = 'http://8.163.81.189:8011';

const SCENARIOS = {
  // 复现基线：明确期限 + 空栏 + 四栏真实业务数据
  repro: {
    昨天: '客户投诉复盘尚未完成，需要补充原因和改进措施，预计1小时。',
    今天: '王芳今天18:00前提交新版排期表，预计1小时。\n研发组今天完成支付回调日志采集，预计2小时。',
    明天: '',
    后天: '',
  },
  // 最终公网验收数据
  acceptance: {
    昨天: '客户投诉复盘尚未完成，需要补充原因和改进措施，预计1小时。',
    今天: '王芳今天18:00前提交新版排期表，预计1小时。\n研发组今天完成支付回调日志采集，预计2小时。',
    明天: '李明明天下午完成接口回归方案，预计1.5小时。',
    后天: '本月底形成支付系统稳定性改进路线图，预计4小时。',
  },
};

const REPRO_MARKERS = {
  deadlineLost: { label: '明确期限变成待确认', hit: false },
  emptyDimensionReferenced: { label: '空栏(明天/后天)被报告引用', hit: false },
  reportSlow: { label: '报告生成耗时接近30秒', hit: false },
  dailyDuplicate: { label: '每日跟踪出现重复任务', hit: false },
  historyFailed: { label: '历史保存失败', hit: false },
};

function parseArgs(argv) {
  const options = { baseUrl: DEFAULT_BASE_URL, scenario: 'repro', username: '', verbose: false, showReport: false };
  const named = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--verbose') { options.verbose = true; continue; }
    if (argument === '--show-report') { options.showReport = true; continue; }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
    if (!match) {
      // 位置参数：裸单词视为场景名（--scenario repro）
      if (!named.has('scenario') && !argument.startsWith('-')) {
        named.set('scenario', argument);
        continue;
      }
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (match[2] === undefined && match[1] !== 'verbose') {
      // 无 = 的取值参数：取下一个参数为值（--scenario repro）
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for --${match[1]}`);
      }
      index += 1;
      named.set(match[1], value);
    } else {
      named.set(match[1], match[2]);
    }
  }
  for (const [key, value] of named) {
    if (key === 'base-url') options.baseUrl = value;
    else if (key === 'scenario') options.scenario = value;
    else if (key === 'username') options.username = value;
    else throw new Error(`Unknown argument: --${key}`);
  }
  if (!SCENARIOS[options.scenario]) {
    throw new Error(`Unknown scenario: ${options.scenario} (expect repro|acceptance)`);
  }
  return options;
}

class PublicClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = '';
    this.preAuthCsrfToken = '';
    this.sessionCsrfToken = '';
  }

  async request(path, { method = 'GET', body, csrfToken } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== 'GET' && method !== 'HEAD') headers.origin = this.baseUrl;
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const startedAt = Date.now();
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const durationMs = Date.now() - startedAt;
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';', 1)[0];
      this.cookie = /Max-Age=0/i.test(setCookie) ? '' : pair;
    }
    return { response, durationMs };
  }

  async getPreAuthCsrf() {
    const { response } = await this.request('/api/auth/csrf');
    this.preAuthCsrfToken = (await response.json()).csrfToken;
  }

  async register(username, password) {
    if (!this.preAuthCsrfToken) await this.getPreAuthCsrf();
    return this.request('/api/auth/register', {
      method: 'POST',
      csrfToken: this.preAuthCsrfToken,
      body: { username, password },
    });
  }

  async login(username, password) {
    if (!this.preAuthCsrfToken) await this.getPreAuthCsrf();
    return this.request('/api/auth/login', {
      method: 'POST',
      csrfToken: this.preAuthCsrfToken,
      body: { username, password },
    });
  }

  async me() {
    const result = await this.request('/api/auth/me');
    if (result.response.ok) {
      this.sessionCsrfToken = (await result.response.clone().json()).csrfToken;
    }
    return result;
  }

  post(path, body) {
    return this.request(path, { method: 'POST', csrfToken: this.sessionCsrfToken, body });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const entries = SCENARIOS[options.scenario];
  const client = new PublicClient(options.baseUrl);
  const username = options.username || `e2e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const password = 'E2e-pass-123';
  const results = [];
  let historyId = null;

  const record = async (name, run) => {
    const node = { name, status: null, durationMs: 0, errorCode: null, payload: null };
    try {
      const { response, durationMs } = await run();
      node.durationMs = durationMs;
      node.status = response.status;
      const text = await response.clone().text();
      try {
        node.payload = JSON.parse(text);
        node.errorCode = node.payload?.error?.code || null;
      } catch { /* 非 JSON 响应不记录正文 */ }
    } catch (error) {
      node.errorCode = error?.code || 'NETWORK_ERROR';
    }
    node.retried = node.status === null || node.status >= 500;
    results.push(node);
    return node;
  };

  const step = (node) => {
    if (options.verbose) {
      console.log(`  ${node.name}: status=${node.status} duration=${node.durationMs}ms`);
    }
  };

  console.log(`E2E 基线：${options.baseUrl} · scenario=${options.scenario} · 用户=${username}`);

  const register = await record('auth/register', () => client.register(username, password));
  step(register);
  if (register?.status !== 201) throw new Error(`注册失败（${register?.status}），无法继续`);
  const login = await record('auth/login', () => client.login(username, password));
  step(login);
  if (login?.status !== 200) throw new Error(`登录失败（${login?.status}），无法继续`);
  const me = await record('auth/me', () => client.me());
  step(me);

  const intake = await record('intake/check', () => client.post('/api/time-management/intake/check', { entries }));
  if (intake?.status !== 200) throw new Error('intake/check 失败');
  const totalLines = intake?.payload?.totalLines;
  console.log(`四栏输入：${totalLines} 行（昨天/今天/明天/后天 = ${JSON.stringify(intake?.payload?.lineCounts)}）`);

  const decompose = await record('tasks/decompose', () => client.post('/api/time-management/tasks/decompose', { entries }));
  if (decompose?.status !== 200) throw new Error(`tasks/decompose 失败: ${decompose?.errorCode}`);
  const tasks = decompose?.payload?.tasks || [];
  console.log(`拆解任务数：${tasks.length}${options.scenario === 'acceptance' ? '（期望约 5）' : ''}`);
  if (options.verbose) {
    for (const task of tasks) {
      console.log(`  - [${task.source}] ${task.name} · 截止=${task.due} · 责任人=${task.owner}`);
    }
  }

  // 复现标记 1：明确期限是否变成“待确认”
  const deadlineTask = tasks.find(task => /排期表/.test(task.name));
  if (deadlineTask && deadlineTask.due === '待确认') {
    REPRO_MARKERS.deadlineLost.hit = true;
    console.log('  ! 复现：王芳今天18:00前 → due=待确认');
  } else if (deadlineTask) {
    console.log(`  期限保留：${deadlineTask.due}（责任人=${deadlineTask.owner}）`);
  }

  const smart = await record('tasks/smart-check', () => client.post('/api/time-management/tasks/smart-check', { tasks }));
  if (smart?.status !== 200) throw new Error('tasks/smart-check 失败');

  const distribution = await record('distribution/diagnose', () => client.post('/api/time-management/distribution/diagnose', { tasks }));
  if (distribution?.status !== 200) throw new Error('distribution/diagnose 失败');

  const matrix = await record('matrix/classify', () => client.post('/api/time-management/matrix/classify', { tasks }));
  if (matrix?.status !== 200) throw new Error('matrix/classify 失败');

  const reportNode = await record('report/generate', () => client.post('/api/time-management/report/generate', {
    tasks,
    matrix: matrix.payload || matrix,
    goals: entries,
    distribution: distribution.payload || distribution,
  }));
  if (reportNode?.status !== 200) throw new Error(`report/generate 失败: ${reportNode?.errorCode}`);
  const report = reportNode.payload;
  const reportDuration = reportNode.durationMs;
  if (reportDuration > 20_000) {
    REPRO_MARKERS.reportSlow.hit = true;
    console.log(`  ! 复现：报告耗时 ${(reportDuration / 1000).toFixed(1)}s（>20s）`);
  }

  if (options.showReport) {
    console.log('\n报告内容（诊断用）：');
    for (const item of report.order || []) console.log(`  顺序: ${item.taskId} — ${item.reason}`);
    const itemText = item => (typeof item === 'string' ? item : item?.text || '');
    for (const item of report.energyRules || []) console.log(`  精力: ${itemText(item)}`);
    for (const item of report.adjustments || []) console.log(`  举措: ${itemText(item)}`);
    if (report.degraded) console.log(`  降级: ${report.degradedReason || 'MODEL_ERROR'}`);
  }

  // 复现标记 2：空栏被报告引用
  const reportText = JSON.stringify(report);
  if (!entries.明天.trim() || !entries.后天.trim()) {
    const emptyKeys = ['明天', '后天'].filter(key => !entries[key].trim());
    if (emptyKeys.some(key => reportText.includes(key))) {
      REPRO_MARKERS.emptyDimensionReferenced.hit = true;
      console.log(`  ! 复现：空栏 ${emptyKeys.join('/')} 被报告引用`);
    }
  }

  const snapshot = {
    clientRunId: randomUUID(),
    title: `${new Date().toISOString().slice(0, 10)} E2E 基线报告`,
    goals: entries,
    decomposition: decompose.payload.decomposition,
    tasks,
    distribution: distribution.payload,
    matrix: matrix.payload,
    report,
  };
  const history = await record('history/save', () => client.post('/api/time-management/history', snapshot));
  if (history?.status === 201 || history?.status === 200) {
    historyId = history?.payload?.id || history?.payload?.item?.id;
    console.log(`历史保存成功：${historyId || '(未返回 id)'}`);
  } else {
    REPRO_MARKERS.historyFailed.hit = true;
    console.log(`  ! 复现：历史保存失败 status=${history?.status} code=${history?.errorCode}`);
  }

  if (historyId) {
    const detail = await record('history/detail', () => client.request(`/api/time-management/history/${encodeURIComponent(historyId)}`));
    if (detail?.status === 200) {
      const detailTasks = detail.payload.tasks || [];
      const mismatch = detailTasks.length !== tasks.length
        || detailTasks.some((task, index) => {
          const current = tasks[index];
          return !current || task.due !== current.due || task.owner !== current.owner || task.name !== current.name;
        });
      console.log(`历史详情字段一致：${mismatch ? '否(!)' : '是'}（${detailTasks.length} 条任务）`);
      if (mismatch) {
        for (let index = 0; index < Math.max(detailTasks.length, tasks.length); index += 1) {
          const a = tasks[index] || {};
          const b = detailTasks[index] || {};
          console.log(`    - 当前: ${a.name} due=${a.due} owner=${a.owner}`);
          console.log(`    - 历史: ${b.name} due=${b.due} owner=${b.owner}`);
        }
      }
    }
  }

  const daily = await record('daily-tracking/today', () => client.request('/api/time-management/daily-tracking/today'));
  if (daily?.status === 200) {
    const dailyTasks = daily.payload.tasks || [];
    const ids = dailyTasks.map(task => task.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length) {
      REPRO_MARKERS.dailyDuplicate.hit = true;
      console.log(`  ! 复现：每日跟踪出现 ${duplicates.length} 个重复任务`);
    } else {
      const covered = tasks.filter(task => dailyTasks.some(item => item.name === task.name));
      console.log(`每日跟踪：${dailyTasks.length} 条任务，覆盖本次 ${covered.length}/${tasks.length} 条，无重复`);
    }
  }

  console.log('\n节点明细：');
  for (const item of results) {
    const statusText = item.status == null ? 'NETWORK' : item.status;
    console.log(`  ${item.name.padEnd(22)} ${String(statusText).padStart(3)} ${String(item.durationMs).padStart(7)}ms${item.errorCode ? ` ${item.errorCode}` : ''}${item.retried ? ' [重试/降级]' : ''}`);
  }

  const totalMs = results.reduce((sum, item) => sum + (item.durationMs || 0), 0);
  console.log(`\n总耗时：${(totalMs / 1000).toFixed(1)}s（报告节点 ${(reportDuration / 1000).toFixed(1)}s）`);

  const hits = Object.entries(REPRO_MARKERS).filter(([, marker]) => marker.hit);
  if (hits.length) {
    console.log(`\n复现问题 ${hits.length} 项：`);
    for (const [key, marker] of hits) console.log(`  - ${marker.label}`);
    process.exitCode = 2;
  } else {
    console.log('\n未复现已知问题（基线健康）');
  }
}

main().catch(error => {
  console.error(`E2E 脚本异常：${error.message}`);
  process.exitCode = 1;
});
