import {
  cancelActiveRequest,
  cancelRequestChannel,
  deleteJson,
  getJson,
  patchJson,
  postJson,
  putJson,
  setCsrfToken,
} from './api.js';
import { downloadDailyTrackingWorkbook } from './excel-export.js';
import {
  CATEGORY_KEYS,
  createUuid,
  invalidateAfterEntries,
  invalidateAfterTasks,
  resetCoaching,
  resetState,
  resetWorkflow,
  state,
} from './state.js';

const CATS = Object.freeze({
  昨天: {
    badge: '昨', color: '#571857', title: '昨天 · 遗留问题', short: '遗留问题',
    description: '应完未完成、拖下来的事；遗留问题、疲于救火', target: '→0%', source: '复盘',
  },
  今天: {
    badge: '今', color: '#6C216D', title: '今天 · 日事日毕', short: '日事日毕',
    description: '今天要完成的事务工作，也是无序、冲突和内耗的所在', target: '70–80%', source: '今天',
  },
  明天: {
    badge: '明', color: '#C9752B', title: '明天 · 能力提升', short: '能力提升',
    description: '机制规范、流程体系、信息化、培养下属与授权管理', target: '10–20%', source: '短期目标',
  },
  后天: {
    badge: '后', color: '#E18C3F', title: '后天 · 未来规划', short: '未来规划',
    description: '思考未来规划、提前布局，并拆分可检查的里程碑', target: '5%', source: '中长期',
  },
});

const PLACEHOLDERS = Object.freeze({
  昨天: '记录尚未完成或被拖延的事项，例如未解决问题、延期任务、临时救火事项；',
  今天: '记录今天计划完成的主要工作事项，请填写具体任务；',
  明天: '记录未来1-4周需要投入时间建设和改善的事项，例如流程优化、机制建设、团队培养、能力提升；',
  后天: '记录未来规划和提前布局事项，例如战略思考、重要项目准备、能力储备。',
});

const SOURCE_TO_CATEGORY = Object.freeze({
  复盘: '昨天', 今天: '今天', 临时: '今天', 短期目标: '明天', 中长期: '后天',
});
const PRIORITIES = Object.freeze({
  IU: { label: '重要且紧急', importance: '高', urgency: '高' },
  I: { label: '重要不紧急', importance: '高', urgency: '低' },
  U: { label: '紧急不重要', importance: '低', urgency: '高' },
  N: { label: '不重要不紧急', importance: '低', urgency: '低' },
});
const STEPS = Object.freeze([
  { title: '事务填写', subtitle: '四栏整段录入' },
  { title: 'AI 拆解确认', subtitle: '结构化 + SMART' },
  { title: '时间分布诊断', subtitle: '实际 vs 目标' },
  { title: '优先级排序', subtitle: '轻重缓急矩阵' },
  { title: '优化报告', subtitle: '改变与举措' },
]);
const QUADRANT_CLASSES = Object.freeze({
  第一象限: 'q1', 第二象限: 'q2', 第三象限: 'q3', 第四象限: 'q4',
});
const QUADRANT_META = Object.freeze({
  第一象限: ['第一象限 · 立即做', '重要且紧急'],
  第二象限: ['第二象限 · 计划做', '重要不紧急'],
  第三象限: ['第三象限 · 授权做', '紧急不重要'],
  第四象限: ['第四象限 · 减少做', '不重要不紧急'],
});
const ICONS = Object.freeze({
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  chevronUp: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
});

let operationId = 0;
let historyReadId = 0;
let dailyLoadId = 0;
let dailyChangeVersion = 0;
let dailySaveTimer = null;
let dailySaveInFlight = false;
let dailySaveQueued = false;
const COACHING_REQUEST_MAX_BYTES = 64 * 1024;
const historyWriteChains = new Map();
const historySavePromises = new Map();
const historyPatchPromises = new Map();
const app = () => document.getElementById('app');
const topbar = () => document.getElementById('topbar');
const modalHost = () => document.getElementById('modalHost');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function localDateIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDateTimeValue(date = new Date()) {
  return `${localDateIso(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const TODAY = localDateIso();

function categoryForTask(task) {
  return SOURCE_TO_CATEGORY[task?.source] || '今天';
}

function priorityForTask(task) {
  if (task.importance === '高' && task.urgency === '高') return 'IU';
  if (task.importance === '高') return 'I';
  if (task.urgency === '高') return 'U';
  if (task.importance && task.urgency) return 'N';
  return '';
}

function parseEstimatedHours(value) {
  const text = String(value || '').trim().replace(/^约\s*/, '').replace(/\s+/g, '');
  const hours = text.match(/^(\d+(?:\.\d+)?)(?:h|小时)$/i);
  if (hours) return Number(hours[1]);
  const minutes = text.match(/^(\d+)分钟$/);
  return minutes ? Number(minutes[1]) / 60 : null;
}

function normalizeEstimate(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return '';
  const minutes = Math.round(hours * 60);
  if (minutes % 30 === 0) return `${minutes / 60}h`;
  return `${minutes}分钟`;
}

function dateOnlyDueValue(value) {
  const text = String(value || '').trim();
  if (!text || text === '待确认') return '';
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2})?$/.exec(text);
  return match ? match[1] : '';
}

function displayDue(value) {
  return dateOnlyDueValue(value) || '待确认';
}

function normalizeTaskForUi(task) {
  return {
    ...task,
    due: displayDue(task.due),
    owner: String(task.owner || '').trim() || '待确认',
  };
}

let homeDailyLoadId = 0;

async function loadHomeDaily() {
  const id = ++homeDailyLoadId;
  state.homeDaily = {
    ...state.homeDaily,
    loading: true,
    error: null,
  };
  if (state.screen === 'home') render();

  try {
    const result = validateDailyPayload(await getJson(
      '/api/time-management/daily-tracking/today',
    ));
    if (id !== homeDailyLoadId || state.screen !== 'home') return;
    state.homeDaily = {
      loaded: true,
      loading: false,
      trackingDate: result.trackingDate,
      tasks: result.tasks.map(normalizeTaskForUi),
      tracking: result.tracking,
      sourceSummary: result.sourceSummary,
      error: null,
    };
    render();
  } catch (error) {
    if (id !== homeDailyLoadId || state.screen !== 'home') return;
    state.homeDaily = {
      ...state.homeDaily,
      loaded: false,
      loading: false,
      error,
    };
    render();
  }
}

function toggleHomeDaily() {
  if (!state.homeDaily.tasks.length) return;
  state.homeDailyExpanded = !state.homeDailyExpanded;
  render();
}

function renderHomeDailyCard() {
  const daily = state.homeDaily;
  if (daily.loading) {
    return '<section class="home-daily-card"><div class="pb-h">今日任务</div><div class="history-loading">正在加载今日任务…</div></section>';
  }
  if (daily.error) {
    return `<section class="home-daily-card"><div class="pb-h">今日任务</div>
      <div class="history-error">今日任务加载失败。</div>
      <button class="btn btn-ghost btn-sm" data-action="reload-home-daily">重试</button></section>`;
  }
  if (!daily.tasks.length) {
    return `<section class="home-daily-card"><div class="pb-h">今日任务</div>
      <div class="history-empty">今天还没有任务，请先完成梳理流程。</div>
      <button class="btn btn-ghost btn-sm" data-nav="daily">进入每日跟踪</button></section>`;
  }

  const expanded = state.homeDailyExpanded;
  const rows = expanded
    ? daily.tasks.map((task) => {
      const done = Boolean(daily.tracking[task.id]?.done);
      return `<article class="home-daily-task ${done ? 'done' : ''}">
        <span class="home-daily-status">${done ? '已完成' : '未完成'}</span>
        <strong>${escapeHtml(task.name)}</strong>
        <span>截止：${escapeHtml(displayDue(task.due))}</span>
        <span>责任人：${escapeHtml(task.owner || '待确认')}</span>
      </article>`;
    }).join('')
    : '';
  const toggleLabel = expanded ? '收起今日任务列表' : '展开今日任务列表';

  return `<section class="home-daily-card">
    <div class="home-daily-head"><div><div class="pb-h">今日任务 · ${escapeHtml(daily.trackingDate)}</div>
      <div class="pb-d">共 ${daily.tasks.length} 项，已完成 ${daily.tasks.filter(task => daily.tracking[task.id]?.done).length} 项。</div></div>
      <div class="home-daily-actions">
        <button class="btn btn-ghost btn-sm" data-nav="daily">进入每日跟踪</button>
        <button type="button" class="btn btn-ghost btn-sm home-daily-toggle"
          data-action="toggle-home-daily"
          aria-expanded="${expanded ? 'true' : 'false'}"
          aria-controls="home-daily-task-list"
          aria-label="${toggleLabel}">
          ${expanded ? ICONS.chevronUp : ICONS.chevronDown}
        </button>
      </div></div>
    <div id="home-daily-task-list" class="home-daily-list" ${expanded ? '' : 'hidden'}>${rows}</div>
  </section>`;
}

function tracked(taskId) {
  return state.tracking[taskId] || { done: false, doneAt: '' };
}

function dailyTracked(taskId) {
  return state.daily.tracking[taskId] || { done: false, doneAt: '' };
}

function toast(message) {
  const element = document.getElementById('toast');
  element.textContent = message;
  element.classList.add('on');
  clearTimeout(element._timer);
  element._timer = setTimeout(() => element.classList.remove('on'), 1900);
}

function rememberCsrfToken(value) {
  state.csrfToken = typeof value === 'string' && value ? value : null;
  setCsrfToken(state.csrfToken);
}

function cancelPending() {
  operationId += 1;
  cancelActiveRequest();
  state.pending = null;
}

function isCurrent(id, screen = 'workspace') {
  return id === operationId && state.screen === screen;
}

function renderTopbar() {
  const brand = `<div class="brand" data-action="home" role="button" tabindex="0">
    <div class="brand-mark">${ICONS.clock}</div>
    <div><div class="brand-name">时间管理助手</div><div class="brand-sub">昨天-今天-明天-后天 · 轻重缓急矩阵</div></div>
  </div>`;
  if (!state.authReady || !state.user) {
    topbar().innerHTML = brand;
    return;
  }
  const active = state.screen === 'history-detail' ? 'history' : state.screen;
  const nav = [
    ['home', '工作台'], ['workspace', '梳理流程'], ['daily', '每日跟踪'], ['history', '历史记录'],
  ];
  const username = state.user.username || '';
  topbar().innerHTML = `${brand}<nav class="topnav" aria-label="主导航">
    ${nav.map(([key, label]) => `<button class="tnav ${active === key ? 'on' : ''}" data-nav="${key}">${label}</button>`).join('')}
    <span class="auth-mini">${escapeHtml(username)}</span>
    <button class="avatar" data-action="logout" title="${escapeHtml(username)} · 点击退出" aria-label="退出登录">${escapeHtml(username.slice(0, 2))}</button>
  </nav>`;
}

function renderBoot() {
  app().innerHTML = `<div class="login-wrap"><section class="login-card">
    <div class="brand-mark" style="width:44px;height:44px;border-radius:12px">${ICONS.clock}</div>
    <div class="login-h">正在检查登录状态</div><div class="login-sub">正在安全恢复当前会话。</div>
    <div class="auth-spinner" aria-label="加载中"></div>
  </section></div>`;
}

function authField(label, name, type, autocomplete, placeholder = '') {
  return `<div class="field"><label class="fl" for="auth-${name}">${label}</label>
    <input id="auth-${name}" name="${name}" type="${type}" autocomplete="${autocomplete}" ${type === 'password' ? 'minlength="6"' : ''} placeholder="${escapeHtml(placeholder)}" required>
  </div>`;
}

function renderLogin() {
  const register = state.authMode === 'register';
  app().innerHTML = `<div class="login-wrap"><section class="login-card">
    <div class="brand-mark" style="width:44px;height:44px;border-radius:12px">${ICONS.clock}</div>
    <div class="login-h">${register ? '注册账号' : '登录'}</div>
    <div class="login-sub">登录后可按账号保存报告历史和当天的每日跟踪清单。</div>
    <div class="tabs"><button class="tab ${register ? '' : 'on'}" data-action="auth-login-tab">登录</button><button class="tab ${register ? 'on' : ''}" data-action="auth-register-tab">注册</button></div>
    <form data-auth-form="${register ? 'register' : 'login'}">
      ${authField('用户名', 'username', 'text', 'username', '请输入用户名')}
      ${authField('密码', 'password', 'password', register ? 'new-password' : 'current-password', '至少 6 位')}
      ${register ? authField('确认密码', 'passwordConfirm', 'password', 'new-password', '再次输入密码') : ''}
      <div class="auth-error" role="alert" aria-live="polite">${escapeHtml(state.authError?.message || '')}</div>
      <button class="btn btn-primary btn-block" type="submit" ${state.pending === 'auth' ? 'disabled' : ''}>${state.pending === 'auth' ? '<span class="mini-spin"></span>处理中…' : register ? '注册' : '登录'}</button>
    </form>
    <div class="auth-links"><span></span><button class="btn btn-ghost btn-sm" data-action="show-recovery">忘记密码</button></div>
    <div class="demo-note">账号、密码和模型密钥不会写入浏览器持久存储。</div>
  </section></div>`;
}

function renderRecovery() {
  app().innerHTML = `<div class="login-wrap"><section class="login-card">
    <div class="brand-mark" style="width:44px;height:44px;border-radius:12px">${ICONS.clock}</div>
    <div class="login-h">使用恢复码重置密码</div><div class="login-sub">成功后会撤销该账号的旧登录会话，并生成新的恢复码。</div>
    <form data-auth-form="recovery">
      ${authField('用户名', 'username', 'text', 'username')}
      ${authField('恢复码', 'recoveryCode', 'text', 'off')}
      ${authField('新密码', 'newPassword', 'password', 'new-password')}
      ${authField('确认新密码', 'newPasswordConfirm', 'password', 'new-password')}
      <div class="auth-error" role="alert" aria-live="polite">${escapeHtml(state.authError?.message || '')}</div>
      <button class="btn btn-primary btn-block" type="submit" ${state.pending === 'auth' ? 'disabled' : ''}>重置密码</button>
    </form>
    <div class="auth-links"><button class="btn btn-ghost btn-sm" data-action="show-login">返回登录</button></div>
  </section></div>`;
}

function renderRecoveryCode() {
  app().innerHTML = `<div class="login-wrap"><section class="login-card">
    <div class="brand-mark" style="width:44px;height:44px;border-radius:12px">${ICONS.clock}</div>
    <div class="login-h">请立即保存恢复码</div><div class="login-sub">这是忘记密码后唯一的自助找回方式。</div>
    <p class="recovery-warning">恢复码只显示这一次。请复制到安全位置，不要分享。</p>
    <code class="recovery-code" id="recovery-code">${escapeHtml(state.recoveryCode)}</code>
    <button class="btn btn-primary btn-block" data-action="confirm-recovery-code">我已保存恢复码</button>
  </section></div>`;
}

function previewDistribution(tasks = state.tasks) {
  const minutes = Object.fromEntries(CATEGORY_KEYS.map(key => [key, 0]));
  let total = 0;
  for (const task of tasks) {
    const hours = parseEstimatedHours(task.est);
    if (!Number.isFinite(hours) || hours <= 0) continue;
    const value = Math.round(hours * 60);
    minutes[categoryForTask(task)] += value;
    total += value;
  }
  const percentages = Object.fromEntries(CATEGORY_KEYS.map(key => [
    key,
    total ? Math.round((minutes[key] / total) * 1000) / 10 : 0,
  ]));
  return { percentages, totalHours: Math.round((total / 60) * 10) / 10 };
}

function distributionStatus(category, percent) {
  if (category === '昨天') return percent <= 2 ? 'ok' : 'over';
  if (category === '今天') return percent < 70 ? 'under' : percent > 80 ? 'over' : 'ok';
  if (category === '明天') return percent < 10 ? 'under' : percent > 20 ? 'over' : 'ok';
  return percent >= 3 ? 'ok' : 'under';
}

function renderHome() {
  const distribution = state.distribution || previewDistribution();
  const percentages = distribution.percentages || {};
  const totalHours = distribution.totalHours ?? previewDistribution().totalHours;
  app().innerHTML = `<div class="phead"><div class="ptitle">工作台</div></div>
    <div class="pdesc">${escapeHtml(state.user.username)}，今天是 ${TODAY}。当前 ${state.tasks.length} 条任务，预估投入 ${totalHours || 0} 小时。</div>
    <div class="hgrid">${CATEGORY_KEYS.map(key => {
      const percent = Number(percentages[key] || 0);
      const status = distributionStatus(key, percent);
      return `<div class="hcard"><div class="cap">${CATS[key].title}</div><div class="big" style="color:${CATS[key].color}">${percent}%</div><div class="tgt ${status === 'ok' ? 'pill-ok' : 'pill-bad'}">目标 ${CATS[key].target} · ${status === 'ok' ? '达标' : status === 'over' ? '偏高' : '不足'}</div></div>`;
    }).join('')}</div>
    <div class="panelbox"><div class="pb-h"><span class="n">→</span>接下来做什么</div><div class="pb-d">${state.tasks.length ? '可继续梳理，或进入每日跟踪登记完成情况。' : '还没有任务，先去梳理流程整段填写四类事务。'}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn btn-primary" data-action="open-workspace">${state.tasks.length ? '继续梳理' : '开始梳理'} ${ICONS.arrow}</button><button class="btn btn-ghost" data-nav="daily">每日跟踪</button><button class="btn btn-ghost" data-nav="history">历史记录</button></div>
    </div>
    ${renderHomeDailyCard()}`;
}

function panelHead(kicker, title, description) {
  return `<div class="panel-head"><div class="panel-kick">${kicker}</div><div class="panel-h">${title}</div><div class="panel-desc">${description}</div></div>`;
}

function panelFoot(content) {
  return `<div class="panel-foot">${content}</div>`;
}

function stepOneBody() {
  return `${panelHead('节点 ① · 输入', '事务填写', '按四类事务分栏整段填写，每行一件事；后端先校验输入，再由 AI 统一拆解成任务。')}
    <div class="panel-body"><div class="aibar"><span class="sp">!</span><div>草稿不会保存。请勿填写客户隐私、密码、密钥或其他敏感信息。</div></div>
      <div class="cols4">${CATEGORY_KEYS.map(key => {
        const category = CATS[key];
        const warning = state.intake?.warnings?.find(item => item.key === key);
        return `<div class="col"><div class="col-h"><span class="col-badge" style="background:${category.color}">${category.badge}</span><span class="col-t">${category.short}</span><span class="col-target" style="color:${category.color}">${category.target}</span></div>
          <div class="col-d">${category.description}</div>
          <textarea id="entry-${key}" data-entry="${key}" placeholder="${escapeHtml(PLACEHOLDERS[key] || '')}">${escapeHtml(state.entries[key])}</textarea>
          ${key === '昨天' ? '<div class="col-note">首次使用手填遗留事项；每日跟踪结束后，未完成任务会滚入该类。</div>' : ''}
          ${warning ? `<div class="field-fb warn">${escapeHtml(warning.message)}</div>` : ''}
        </div>`;
      }).join('')}</div>
    </div>
    ${panelFoot(`<span class="foot-hint">节点 1：服务端校验四栏；节点 2：模型拆解并由你确认</span><button class="btn btn-primary" data-action="decompose" ${state.pending ? 'disabled' : ''}>${state.pending === 'decompose' ? '<span class="mini-spin"></span>拆解中…' : `AI 拆解为任务 ${ICONS.arrow}`}</button>`)}`;
}

function smartFields(taskId) {
  if (!state.smartChecked) return new Set();
  const item = state.smart?.results?.find(result => result.taskId === taskId);
  return new Set((item?.issues || []).map(issue => issue.field));
}

function taskEditRow(task) {
  const fields = smartFields(task.id);
  const category = categoryForTask(task);
  const hours = parseEstimatedHours(task.est);
  const priority = priorityForTask(task);
  const dueValue = dateOnlyDueValue(task.due);
  return `<div class="trow g-edit ${fields.size ? 'miss' : ''}" data-task-row="${escapeHtml(task.id)}">
    <div><span class="mobile-label">任务</span><input data-task-id="${escapeHtml(task.id)}" data-task-field="name" value="${escapeHtml(task.name)}" class="${fields.has('name') ? 'miss' : ''}" aria-label="任务描述"></div>
    <div><span class="mobile-label">类别</span><select data-task-id="${escapeHtml(task.id)}" data-task-field="category" aria-label="所属类别">${CATEGORY_KEYS.map(key => `<option value="${key}" ${category === key ? 'selected' : ''}>${key}</option>`).join('')}</select></div>
    <div><span class="mobile-label">截止日期</span><input type="date" data-task-id="${escapeHtml(task.id)}" data-task-field="due" value="${escapeHtml(dueValue)}" aria-label="截止日期"></div>
    <div><span class="mobile-label">预估时长（小时）</span><input type="number" step="0.25" min="0" data-task-id="${escapeHtml(task.id)}" data-task-field="est" value="${Number.isFinite(hours) ? hours : ''}" placeholder="小时" class="${fields.has('est') ? 'miss' : ''}" aria-label="预估时长（小时）"></div>
    <div><span class="mobile-label">责任人</span><input data-task-id="${escapeHtml(task.id)}" data-task-field="owner" value="${escapeHtml(task.owner === '待确认' ? '' : task.owner)}" placeholder="待确认" aria-label="责任人"></div>
    <div><span class="mobile-label">轻重缓急</span><select data-task-id="${escapeHtml(task.id)}" data-task-field="priority" class="${fields.has('priority') ? 'miss' : ''}" aria-label="轻重缓急"><option value="">未选</option>${Object.entries(PRIORITIES).map(([key, value]) => `<option value="${key}" ${priority === key ? 'selected' : ''}>${value.label}</option>`).join('')}</select></div>
    <button class="del" data-action="delete-task" data-task-id="${escapeHtml(task.id)}" aria-label="删除任务">×</button>
  </div>`;
}

function coachingStatus() {
  const { status, historySyncStatus } = state.coaching;
  if (status === 'idle') return '';
  const messages = {
    running: '教练诊断正在后台生成，不影响任务确认和后续步骤。',
    succeeded: historySyncStatus === 'failed'
      ? '教练诊断已完成，但同步到历史失败。'
      : '教练诊断已完成，并已纳入拆解审计。',
    failed: '教练诊断暂时失败，已生成任务不受影响。',
    timed_out: '教练诊断响应超时，已生成任务不受影响。',
    cancelled: '教练诊断已取消，已生成任务不受影响。',
    unavailable: '教练诊断请求内容过大，本次不可用；请修改输入后重新拆解。',
  };
  const retryable = ['failed', 'timed_out', 'cancelled'].includes(status);
  const retryHistory = status === 'succeeded' && historySyncStatus === 'failed';
  return `<div class="coaching-status ${['failed', 'timed_out', 'cancelled', 'unavailable'].includes(status) || retryHistory ? 'failed' : ''}" data-coaching-status="${status}">
    <span>${escapeHtml(messages[status] || '')}</span>
    ${retryable ? '<button class="btn btn-ghost btn-sm" data-action="coaching-retry">重试教练诊断</button>' : ''}
    ${retryHistory ? '<button class="btn btn-ghost btn-sm" data-action="coaching-history-retry">重试历史同步</button>' : ''}
  </div>`;
}

function stepTwoBody() {
  const needFix = state.smart?.summary?.needFix || 0;
  return `${panelHead('节点 ② · AI动作 + 你确认', 'AI 拆解确认', 'AI 已把四栏文字拆成结构化任务。补齐标红字段，并由后端执行正式 SMART 校验。')}
    <div class="panel-body"><div class="aibar"><span class="sp">AI</span><div style="flex:1">任务需具体、具有可解析工时和明确轻重缓急；后端不替你虚构缺失条件。</div>
      <button class="btn btn-ghost btn-sm" data-action="smart-check" ${state.pending ? 'disabled' : ''}>${state.pending === 'smart' ? '<span class="mini-spin"></span>校验中…' : 'SMART 校验'}</button>
      <button class="btn btn-ghost btn-sm" data-action="open-add-task">+ 手动添加任务</button></div>
      <div id="coaching-status-host">${coachingStatus()}</div>
      <div class="tgrid"><div class="trow hd g-edit"><div>任务</div><div>类别</div><div>截止日期</div><div>预估时长（小时）</div><div>责任人</div><div>轻重缓急</div><div></div></div>
        ${state.tasks.length ? state.tasks.map(taskEditRow).join('') : '<div class="trow"><div style="color:var(--muted);font-size:12px">暂无任务，请返回上一步重新填写。</div></div>'}
      </div>
      ${state.smartChecked ? `<div style="margin-top:12px;font-size:12.5px;color:${needFix ? 'var(--warn)' : 'var(--ok)'};font-weight:700">${needFix ? `还有 ${needFix} 条任务需要补全` : '全部任务通过 SMART 校验'}</div>` : ''}
    </div>
    ${panelFoot(`<span class="foot-hint">共 ${state.tasks.length} 条任务${state.smartChecked ? '' : ' · 请先执行 SMART 校验'}</span><button class="btn btn-ghost" data-action="back-step">上一步</button><button class="btn btn-primary" data-action="diagnose" ${state.pending ? 'disabled' : ''}>时间分布诊断 ${ICONS.arrow}</button>`)}`;
}

function distributionResultMarkup(distribution) {
  return `${distribution.categories.map(item => {
    const category = CATS[item.key];
    const target = item.key === '昨天'
      ? '<div class="tgt-mark" style="left:2%"></div>'
      : item.key === '后天'
        ? '<div class="tgt-mark" style="left:5%"></div>'
        : `<div class="tgt-band" style="left:${item.target.min}%;width:${item.target.max - item.target.min}%"></div>`;
    const label = item.status === 'ok' ? '达标' : item.status === 'over' ? '偏高' : '投入不足';
    return `<div class="distrow"><div class="dist-label">${category.title}<span>目标 ${category.target}</span></div><div class="bar-wrap">${target}<div class="bar" style="width:${Math.max(item.percent, 3)}%;background:${category.color}">${item.percent}%</div></div><div class="dist-num" style="color:${item.status === 'ok' ? 'var(--ok)' : 'var(--warn)'}">${label}<small style="color:var(--muted)">${item.hours}h / 共 ${distribution.totalHours}h</small></div></div>`;
  }).join('')}
    <div class="legend">虚线或绿色区间为模型目标；占比由服务端按分钟计算，显示总和稳定为 100.0%。</div>
    ${distribution.invalidTasks.length ? `<div class="diagnosis" style="background:var(--warn-bg);border-color:var(--warn-line);color:var(--warn)"><b>未参与计算：</b>${distribution.invalidTasks.map(item => escapeHtml(item.name)).join('、')}</div>` : ''}
    <div class="diagnosis"><div><b>诊断结论：</b>${distribution.diagnosis.map(escapeHtml).join(' ')}</div><div style="margin-top:7px"><b>改进方向：</b>${distribution.recommendations.map(escapeHtml).join(' ')}</div></div>`;
}

function stepThreeBody() {
  const distribution = state.distribution;
  if (!distribution) return `${panelHead('节点 ③ · 服务端动作', '时间分布诊断', '诊断结果尚未生成。')}<div class="panel-body"></div>`;
  return `${panelHead('节点 ③ · 服务端动作', '时间分布诊断', '后端按可解析预估工时汇总四类事务占比，并与目标结构比较。')}
    <div class="panel-body">${distributionResultMarkup(distribution)}</div>
    ${panelFoot('<span class="foot-hint">诊断基线：昨天→0% · 今天70–80% · 明天10–20% · 后天5%</span><button class="btn btn-ghost" data-action="back-step">上一步</button><button class="btn btn-primary" data-action="classify">优先级排序 ' + ICONS.arrow + '</button>')}`;
}

function quadrantBox(name) {
  const quadrant = state.matrix?.quadrants?.find(item => (item.name || item.q) === name);
  const [title, meta] = QUADRANT_META[name];
  const taskById = new Map(state.tasks.map(task => [task.id, task]));
  const ids = quadrant?.taskIds || [];
  return `<div class="quad ${QUADRANT_CLASSES[name]}">${quadrant ? `<div class="energy">${quadrant.energyPercent}%</div>` : ''}<div class="quad-h">${title}</div><div class="quad-m">${meta}</div>${ids.length ? ids.map(id => {
    const task = taskById.get(id);
    return `<div class="qt">${escapeHtml(task?.name || '')}<small> · ${escapeHtml(categoryForTask(task))}</small></div>`;
  }).join('') : '<div class="qt" style="opacity:.6">暂无</div>'}</div>`;
}

function stepFourBody() {
  return `${panelHead('节点 ④ · AI排序', '优先级排序', '后端核验每条任务的轻重缓急和任务守恒，再按四象限输出执行顺序。')}
    <div class="panel-body"><div class="mx-wrap"><div class="axis-y"><span>重要</span><span>不重要</span></div><div><div class="mx">${quadrantBox('第一象限')}${quadrantBox('第二象限')}${quadrantBox('第三象限')}${quadrantBox('第四象限')}</div><div class="axis-x"><span>不紧急</span><span>紧急</span></div></div></div>
      <div class="diagnosis" style="background:var(--purple-tint);border-color:var(--purple-tint2);color:var(--purple-700)"><b>排序建议：</b>第一象限立即闭环；第二象限固定时段保护；第三象限优先授权；第四象限合并或减少。${state.matrix?.note ? ` ${escapeHtml(state.matrix.note)}` : ''}</div>
    </div>
    ${panelFoot('<span class="foot-hint">轻重缓急由你确认或由矩阵模型补齐，不为填满象限而篡改任务</span><button class="btn btn-ghost" data-action="back-step">上一步</button><button class="btn btn-primary" data-action="generate-report">生成优化报告 ' + ICONS.arrow + '</button>')}`;
}

function reportStatus() {
  const messages = {
    idle: '报告生成后将自动保存到账号历史。', saving: '正在保存历史…', saved: '历史已保存。', failed: '报告已生成，但历史保存失败。',
  };
  const coachingSyncFailed = state.coaching.status === 'succeeded'
    && state.coaching.historySyncStatus === 'failed';
  const message = coachingSyncFailed
    ? '报告已保存，但教练诊断同步失败。'
    : messages[state.historySave.status] || state.historySave.message;
  const failed = state.historySave.status === 'failed' || coachingSyncFailed;
  return `<div class="history-save-status ${failed ? 'failed' : ''}"><span>${escapeHtml(message)}</span>${state.historySave.status === 'failed' ? '<button class="btn btn-ghost btn-sm" data-action="history-retry">重试保存</button>' : ''}${coachingSyncFailed ? '<button class="btn btn-ghost btn-sm" data-action="coaching-history-retry">重试诊断同步</button>' : ''}</div>`;
}

function stepFiveBody() {
  const taskById = new Map(state.tasks.map(task => [task.id, task]));
  const order = state.report?.order || [];
  const degraded = state.report?.degraded
    ? `<div class="aibar" style="margin:0 0 12px"><span class="sp">!</span><div>当前为基础报告（只引用真实输入）。${state.report.degradedReason === 'CLIENT_REQUESTED_BASE' ? '你选择了立即使用基础报告。' : 'AI 增强未通过证据校验。'}</div>
      <button class="btn btn-ghost btn-sm" data-action="regenerate-report" ${state.pending ? 'disabled' : ''}>重新生成 AI 建议</button></div>`
    : '';
  return `${panelHead('节点 ⑤ · 输出', '时间投入优化报告', '报告综合任务、时间分布和四象限结果，给出执行顺序、结构目标与改变举措。')}
    <div class="panel-body">${degraded}<div class="rcard"><div class="rcard-h"><span class="n">1</span>今日执行顺序</div><ul class="rlist">${order.map(item => `<li><b>${escapeHtml(taskById.get(item.taskId)?.name || '')}</b>：${escapeHtml(item.reason)}</li>`).join('') || '<li>当前没有可排序任务。</li>'}</ul></div>
      <div class="rcard"><div class="rcard-h"><span class="n">2</span>时间投入优化目标</div><ul class="rlist">${state.distribution.categories.map(item => `<li>${item.key}：${item.percent}% → <b>${CATS[item.key].target}</b></li>`).join('')}</ul></div>
      <div class="rcard"><div class="rcard-h"><span class="n">3</span>要做的改变与举措</div><div id="report-markdown" class="markdown-body"></div></div>
      ${reportStatus()}
    </div>
    ${panelFoot('<span class="foot-hint">报告已结合节点 3 的时间结构诊断</span><button class="btn btn-ghost" data-action="back-step">上一步</button><button class="btn btn-ghost" data-action="copy-report">复制报告</button><button class="btn btn-accent" data-nav="daily">进入每日跟踪 ' + ICONS.arrow + '</button>')}`;
}

function workspaceBody() {
  if (state.step === 1) return stepOneBody();
  if (state.step === 2) return stepTwoBody();
  if (state.step === 3) return stepThreeBody();
  if (state.step === 4) return stepFourBody();
  return stepFiveBody();
}

function renderWorkspace() {
  app().innerHTML = `<div class="ws-grid"><div class="stepper">${STEPS.map((step, index) => {
    const number = index + 1;
    const locked = number > state.maxStep;
    return `<div class="step ${state.step === number ? 'active' : ''} ${number < state.step ? 'done' : ''} ${locked ? 'locked' : ''}" data-step="${number}"><div class="step-num">${number < state.step ? '✓' : number}</div><div><div class="step-tt">${step.title}</div><div class="step-sub">${step.subtitle}</div></div></div>`;
  }).join('')}</div><section class="panel" id="panel">${workspaceBody()}</section></div>`;
  if (state.step === 5 && state.report) hydrateReport();
}

function dailyTaskRow(task) {
  const track = dailyTracked(task.id);
  const category = categoryForTask(task);
  const hours = parseEstimatedHours(task.est);
  const priority = priorityForTask(task);
  const dueValue = dateOnlyDueValue(task.due);
  return `<div class="trow g-daily ${track.done ? 'doneRow' : ''}" data-daily-task-id="${escapeHtml(task.id)}">
    <button class="chk ${track.done ? 'on' : ''}" data-action="toggle-daily-done" data-task-id="${escapeHtml(task.id)}" aria-label="${track.done ? '取消完成' : '标记完成'}">${track.done ? '✓' : ''}</button>
    <div><span class="mobile-label">任务</span><input class="tname ${track.done ? 'done' : ''}" data-daily-task-id="${escapeHtml(task.id)}" data-daily-task-field="name" value="${escapeHtml(task.name)}"></div>
    <div><span class="mobile-label">类别</span><select data-daily-task-id="${escapeHtml(task.id)}" data-daily-task-field="category">${CATEGORY_KEYS.map(key => `<option value="${key}" ${category === key ? 'selected' : ''}>${key}</option>`).join('')}</select></div>
    <div><span class="mobile-label">截止日期</span><input type="date" data-daily-task-id="${escapeHtml(task.id)}" data-daily-task-field="due" value="${escapeHtml(dueValue)}" aria-label="截止日期"></div>
    <div><span class="mobile-label">预估时长（小时）</span><input type="number" step="0.25" min="0" data-daily-task-id="${escapeHtml(task.id)}" data-daily-task-field="est" value="${Number.isFinite(hours) ? hours : ''}" aria-label="预估时长（小时）"></div>
    <div><span class="mobile-label">责任人</span><input data-daily-task-id="${escapeHtml(task.id)}" data-daily-task-field="owner" value="${escapeHtml(task.owner === '待确认' ? '' : task.owner)}" placeholder="待确认" aria-label="责任人"></div>
    <div><span class="mobile-label">轻重缓急</span><select data-daily-task-id="${escapeHtml(task.id)}" data-daily-task-field="priority"><option value="">未选</option>${Object.entries(PRIORITIES).map(([key, item]) => `<option value="${key}" ${priority === key ? 'selected' : ''}>${item.label}</option>`).join('')}</select></div>
    <div><span class="mobile-label">完成时间</span><input type="datetime-local" data-daily-track-time="${escapeHtml(task.id)}" value="${escapeHtml(track.doneAt)}" ${track.done ? '' : 'disabled'}></div>
    <button class="del" data-action="delete-daily-task" data-task-id="${escapeHtml(task.id)}" aria-label="删除任务">×</button>
  </div>`;
}

function dailySaveText() {
  if (state.daily.saveStatus === 'saving') return '正在保存…';
  if (state.daily.saveStatus === 'saved') return '已自动保存';
  if (state.daily.saveStatus === 'dirty') return '有未保存更改';
  if (state.daily.saveStatus === 'failed') {
    return state.daily.error?.message || '保存失败，请重试';
  }
  return state.daily.loaded ? '已加载今日清单' : '';
}

function dailyFailureRequiresReload() {
  return ['DAILY_TRACKING_CONFLICT', 'DAILY_TRACKING_DATE_CHANGED']
    .includes(state.daily.error?.code);
}

function renderDaily() {
  if (state.daily.loading && !state.daily.loaded) {
    app().innerHTML = `<div class="phead"><div class="ptitle">每日跟踪</div></div>
      <div class="history-loading">正在加载今天的每日清单…</div>`;
    return;
  }
  if (state.daily.error && !state.daily.loaded) {
    app().innerHTML = `<div class="phead"><div class="ptitle">每日跟踪</div></div>
      <div class="history-error">${escapeHtml(state.daily.error.message || '每日跟踪加载失败')}</div>
      <button class="btn btn-ghost btn-sm" data-action="reload-daily">重新加载</button>`;
    return;
  }
  const list = state.daily.tasks;
  const doneCount = list.filter(task => dailyTracked(task.id).done).length;
  const summary = state.daily.sourceSummary;
  const statusClass = state.daily.saveStatus === 'failed' ? 'failed' : state.daily.saveStatus;
  const failureAction = dailyFailureRequiresReload()
    ? '<button class="btn btn-ghost btn-sm" data-action="reload-daily">重新加载今天</button>'
    : '<button class="btn btn-ghost btn-sm" data-action="retry-daily-save">重试</button>';
  app().innerHTML = `<div class="phead"><div class="ptitle">每日跟踪</div><div class="daily-head-actions"><button class="btn btn-ghost btn-sm" data-action="export-daily-excel" ${list.length ? '' : 'disabled'}>导出 Excel</button><div id="daily-save-status" class="daily-save-status ${escapeHtml(statusClass)}" role="status" aria-live="polite">${escapeHtml(dailySaveText())}${state.daily.saveStatus === 'failed' ? ` ${failureAction}` : ''}</div></div></div>
    <div class="pdesc">已汇总今天生成的 ${summary.historyCount} 条记录，共 ${summary.taskCount} 项任务。无论从哪条历史进入，这里始终是 ${escapeHtml(state.daily.trackingDate || TODAY)} 的账号清单。</div>
    <div class="panelbox"><div class="pb-h"><span class="n">✓</span>今日登记 · ${escapeHtml(state.daily.trackingDate || TODAY)}</div><div class="pb-d">已完成 ${doneCount} / ${list.length} 项。修改、完成或删除后将自动保存。</div>
      <div class="tgrid"><div class="trow hd g-daily"><div></div><div>任务</div><div>类别</div><div>截止日期</div><div>预估时长（小时）</div><div>责任人</div><div>轻重缓急</div><div>完成时间</div><div></div></div>${list.length ? list.map(dailyTaskRow).join('') : '<div class="history-empty">今天还没有生成任何历史任务，请先完成五步梳理流程。</div>'}</div>
    </div>`;
}

function exportDailyToExcel() {
  if (!state.daily.loaded || !state.daily.tasks.length) {
    toast('当前没有可导出的每日跟踪任务');
    return;
  }
  const rows = state.daily.tasks.map((task) => {
    const track = dailyTracked(task.id);
    const priority = PRIORITIES[priorityForTask(task)]?.label || '未选';
    return {
      status: track.done ? '已完成' : '未完成',
      task: task.name,
      category: categoryForTask(task),
      due: displayDue(task.due),
      estimatedHours: parseEstimatedHours(task.est),
      owner: task.owner || '待确认',
      priority,
      completedAt: track.doneAt ? track.doneAt.replace('T', ' ') : '',
    };
  });
  const filename = downloadDailyTrackingWorkbook({
    trackingDate: state.daily.trackingDate || TODAY,
    rows,
  });
  toast(`已导出 ${filename}`);
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间待确认';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function sessionHistoryRows() {
  if (!state.sessionHistory.length) return '<div class="history-empty">本次会话还没有每日完成记录。</div>';
  return state.sessionHistory.slice().reverse().map(item => `<div class="hrow"><div class="hdate">${escapeHtml(item.date)}<br><span style="font-size:10px;color:var(--muted)">刷新后清空</span></div><div class="hbar">${CATEGORY_KEYS.map(key => `<div class="hseg" style="width:${item.distribution[key] || 0}%;background:${CATS[key].color}"></div>`).join('')}</div><div class="hpct">${CATEGORY_KEYS.map(key => `${CATS[key].badge} ${item.distribution[key] || 0}%`).join(' · ')}</div><div class="hdone">${item.done.length ? `<b>完成 ${item.done.length} 项：</b>${item.done.map(done => `${escapeHtml(done.name)}（${escapeHtml(done.at.replace('T', ' '))}）`).join(' · ')}` : '当日无完成记录'}</div></div>`).join('');
}

function accountHistoryRows() {
  if (state.error) return `<div class="history-error">${escapeHtml(state.error.message || '历史加载失败')}</div>`;
  if (state.pending === 'history-list' && !state.historyItems.length) return '<div class="history-loading">正在加载账号报告…</div>';
  if (!state.historyItems.length) return '<div class="history-empty">账号下还没有已完成的报告。</div>';
  return `${state.historyItems.map(item => `<article class="history-item"><div class="history-item-main"><div class="history-item-title">${escapeHtml(item.title)}</div><div class="history-item-meta">生成时间：${escapeHtml(formatTimestamp(item.createdAt))} · 按账号保存</div></div><div class="history-actions"><button class="btn btn-primary btn-sm" data-action="history-detail" data-history-id="${escapeHtml(item.id)}">查看详情</button><button class="btn btn-ghost btn-sm" data-action="history-delete" data-history-id="${escapeHtml(item.id)}">删除</button></div></article>`).join('')}${state.historyCursor ? '<button class="btn btn-ghost btn-sm" data-action="history-more">加载更多</button>' : ''}`;
}

function renderHistory() {
  app().innerHTML = `<div class="phead"><div class="ptitle">历史记录</div></div><div class="pdesc">“本次会话”来自每日跟踪，刷新后清空；“账号报告”保存在 SQLite 并按账号隔离。</div>
    <div class="history-split"><section class="panelbox"><div class="pb-h"><span class="n">◷</span>本次会话 · 每日完成记录</div><div class="pb-d">用于观察四类事务占比和实际完成时间，不写入账号数据库。</div>${sessionHistoryRows()}</section>
      <section class="panelbox"><div class="pb-h"><span class="n">云</span>账号报告</div><div class="pb-d">只保存成功生成的五步优化报告，支持查看、复制和删除。</div>${accountHistoryRows()}</section>
    </div>`;
}

function historyDistributionSection(distribution) {
  if (!distribution) {
    return '<section class="history-section"><h2>时间分布诊断</h2><div class="history-empty">该历史版本未保存时间分布诊断</div></section>';
  }
  return `<section class="history-section"><h2>时间分布诊断</h2>${distributionResultMarkup(distribution)}</section>`;
}

function renderHistoryDetail() {
  const item = state.historyDetail;
  if (!item) return renderHistory();
  const taskById = new Map(item.tasks.map(task => [task.id, task]));
  app().innerHTML = `<div class="phead"><button class="btn btn-ghost btn-sm" data-action="history-back">返回</button><div class="ptitle">${escapeHtml(item.title)}</div></div><div class="pdesc">生成时间：${escapeHtml(formatTimestamp(item.createdAt))} · 只读账号历史</div>
    <div class="history-detail-content"><section class="history-section"><h2>事务填写</h2><div class="history-goals">${Object.entries(item.goals).map(([key, value]) => `<div><strong>${escapeHtml(key)}</strong><p>${escapeHtml(value || '未填写')}</p></div>`).join('')}</div></section>
      <section class="history-section"><h2>任务清单</h2><div class="history-tasks">${item.tasks.map(task => `<article><h3>${escapeHtml(task.name)}</h3><p>${escapeHtml(categoryForTask(task))} · ${escapeHtml(task.importance || '待确认')}/${escapeHtml(task.urgency || '待确认')} · ${escapeHtml(task.est || '')} · 截止：${escapeHtml(displayDue(task.due))} · 责任人：${escapeHtml(task.owner || '待确认')}</p></article>`).join('')}</div></section>
      ${historyDistributionSection(item.distribution)}
      <section class="history-section"><h2>轻重缓急矩阵</h2><div class="history-quadrants">${item.matrix.quadrants.map(quadrant => `<div><strong>${escapeHtml(quadrant.name)} · ${quadrant.energyPercent}%</strong><p>${quadrant.taskIds.map(id => escapeHtml(taskById.get(id)?.name || '')).filter(Boolean).join('、') || '暂无任务'}</p></div>`).join('')}</div></section>
      <section class="history-section"><h2>优化报告</h2><div id="history-report-markdown" class="markdown-body"></div></section>
    </div><div class="history-actions" style="justify-content:flex-end;margin-top:14px"><button class="btn btn-primary btn-sm" data-action="open-daily">进入每日跟踪</button><button class="btn btn-ghost btn-sm" data-action="history-copy">复制历史报告</button><button class="btn btn-danger btn-sm" data-action="history-delete" data-history-id="${escapeHtml(item.id)}">删除历史</button></div>`;
  hydrateHistoryReport();
}

function renderModal() {
  if (!state.modal) {
    modalHost().innerHTML = '';
    return;
  }
  if (state.modal.type === 'add-task') {
    modalHost().innerHTML = `<div class="mask" data-modal-mask><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h3 id="modal-title">手动添加任务</h3><div class="sub">补充 AI 未拆解到的事项，保存后需要重新执行后续节点。</div>
      <div class="field"><label class="fl" for="m-name">任务描述 <span class="req">*</span></label><input id="m-name" placeholder="动词 + 对象 + 结果"></div>
      <div class="grid2"><div class="field"><label class="fl" for="m-est">预估时长（小时） <span class="req">*</span></label><input id="m-est" type="number" step="0.25" min="0.25"></div><div class="field"><label class="fl" for="m-due">截止日期</label><input id="m-due" type="date"></div></div>
      <div class="grid2"><div class="field"><label class="fl" for="m-priority">轻重缓急 <span class="req">*</span></label><select id="m-priority"><option value="">请选择</option>${Object.entries(PRIORITIES).map(([key, item]) => `<option value="${key}">${item.label}</option>`).join('')}</select></div><div class="field"><label class="fl" for="m-category">所属类别</label><select id="m-category">${CATEGORY_KEYS.map(key => `<option value="${key}" ${key === state.modal.category ? 'selected' : ''}>${key}</option>`).join('')}</select></div></div>
      <div class="field"><label class="fl" for="m-owner">责任人</label><input id="m-owner" placeholder="待确认"></div>
      <div class="err hidden" id="m-error">请填写全部必填项。</div><div class="mact"><button class="btn btn-primary btn-sm" data-action="save-task">添加</button><button class="btn btn-ghost btn-sm" data-action="close-modal">取消</button></div>
    </section></div>`;
  }
}

function render() {
  renderTopbar();
  if (!state.authReady || state.screen === 'boot') renderBoot();
  else if (state.screen === 'recovery-code') renderRecoveryCode();
  else if (!state.user && state.screen === 'recovery') renderRecovery();
  else if (!state.user) renderLogin();
  else if (state.screen === 'workspace') renderWorkspace();
  else if (state.screen === 'daily') renderDaily();
  else if (state.screen === 'history') renderHistory();
  else if (state.screen === 'history-detail') renderHistoryDetail();
  else renderHome();
  renderModal();
}

function renderAtTop() {
  render();
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
}

function validateDailyPayload(payload) {
  if (
    !payload
    || typeof payload.trackingDate !== 'string'
    || !Array.isArray(payload.tasks)
    || !payload.tracking
    || typeof payload.tracking !== 'object'
    || !Array.isArray(payload.removedTaskIds)
    || !Number.isInteger(payload.revision)
    || !payload.sourceSummary
  ) {
    throw new Error('每日跟踪返回结构异常，请重试。');
  }
  return payload;
}

function applyDailyPayload(payload, saveStatus = 'idle') {
  const value = validateDailyPayload(payload);
  state.daily = {
    loaded: true,
    loading: false,
    trackingDate: value.trackingDate,
    tasks: value.tasks.map(normalizeTaskForUi),
    tracking: value.tracking,
    removedTaskIds: value.removedTaskIds,
    revision: value.revision,
    updatedAt: value.updatedAt || null,
    sourceSummary: value.sourceSummary,
    saveStatus,
    error: null,
  };
}

function updateDailySaveStatus() {
  const element = document.getElementById('daily-save-status');
  if (!element) return;
  element.className = `daily-save-status ${state.daily.saveStatus}`;
  element.textContent = dailySaveText();
  if (state.daily.saveStatus === 'failed') {
    const button = document.createElement('button');
    button.className = 'btn btn-ghost btn-sm';
    button.dataset.action = dailyFailureRequiresReload()
      ? 'reload-daily'
      : 'retry-daily-save';
    button.textContent = dailyFailureRequiresReload() ? '重新加载今天' : '重试';
    element.append(' ', button);
  }
}

function hasUnsafeDailyChanges() {
  return state.daily.loaded
    && ['dirty', 'saving', 'failed'].includes(state.daily.saveStatus);
}

function confirmDailyLeave(nextScreen) {
  if (
    state.screen !== 'daily'
    || nextScreen === 'daily'
    || !hasUnsafeDailyChanges()
  ) {
    return true;
  }
  return window.confirm('每日跟踪仍有未保存更改，确定离开吗？');
}

function dailySnapshot() {
  return {
    trackingDate: state.daily.trackingDate,
    tasks: state.daily.tasks,
    tracking: state.daily.tracking,
    removedTaskIds: state.daily.removedTaskIds,
    revision: state.daily.revision,
  };
}

function scheduleDailySave(delay = 800) {
  clearTimeout(dailySaveTimer);
  state.daily.saveStatus = 'dirty';
  updateDailySaveStatus();
  if (dailySaveInFlight) {
    dailySaveQueued = true;
    return;
  }
  dailySaveTimer = setTimeout(() => saveDaily(), delay);
}

async function saveDaily() {
  clearTimeout(dailySaveTimer);
  dailySaveTimer = null;
  if (!state.daily.loaded || !state.daily.trackingDate) return;
  if (dailySaveInFlight) {
    dailySaveQueued = true;
    return;
  }
  dailySaveInFlight = true;
  dailySaveQueued = false;
  const version = dailyChangeVersion;
  const snapshot = JSON.parse(JSON.stringify(dailySnapshot()));
  state.daily.saveStatus = 'saving';
  updateDailySaveStatus();
  try {
    const result = validateDailyPayload(await putJson(
      '/api/time-management/daily-tracking/today',
      snapshot,
    ));
    if (version === dailyChangeVersion) {
      applyDailyPayload(result, 'saved');
      if (state.screen === 'daily') render();
    } else {
      state.daily.revision = result.revision;
      state.daily.updatedAt = result.updatedAt || null;
      state.daily.saveStatus = 'dirty';
      updateDailySaveStatus();
      dailySaveQueued = true;
    }
  } catch (error) {
    state.daily.saveStatus = 'failed';
    state.daily.error = error;
    updateDailySaveStatus();
    toast(error.message || '每日跟踪保存失败，请重试。');
  } finally {
    dailySaveInFlight = false;
    if (dailySaveQueued && state.daily.saveStatus !== 'failed') {
      dailySaveQueued = false;
      scheduleDailySave(0);
    }
  }
}

async function loadDaily() {
  const id = ++dailyLoadId;
  clearTimeout(dailySaveTimer);
  state.daily.loading = true;
  state.daily.error = null;
  state.daily.saveStatus = 'idle';
  render();
  try {
    const result = validateDailyPayload(await getJson(
      '/api/time-management/daily-tracking/today',
    ));
    if (id !== dailyLoadId || state.screen !== 'daily') return;
    dailyChangeVersion = 0;
    applyDailyPayload(result);
    render();
    if (result.hasUnpersistedMerge) scheduleDailySave(0);
  } catch (error) {
    if (id !== dailyLoadId || state.screen !== 'daily') return;
    state.daily.loading = false;
    state.daily.loaded = false;
    state.daily.error = error;
    state.daily.saveStatus = 'failed';
    render();
  }
}

function reloadDaily() {
  if (
    hasUnsafeDailyChanges()
    && !window.confirm('重新加载将放弃当前未保存更改，确定继续吗？')
  ) {
    return;
  }
  state.daily.saveStatus = 'idle';
  state.daily.error = null;
  loadDaily();
}

function updateDailyTask(taskId, field, value) {
  const task = state.daily.tasks.find(item => item.id === taskId);
  if (!task) return;
  if (field === 'name') task.name = value;
  else if (field === 'category') task.source = CATS[value]?.source || '今天';
  else if (field === 'due') task.due = value || '待确认';
  else if (field === 'est') task.est = normalizeEstimate(value);
  else if (field === 'owner') task.owner = value.trim() || '待确认';
  else if (field === 'priority') {
    const priority = PRIORITIES[value];
    task.importance = priority?.importance ?? null;
    task.urgency = priority?.urgency ?? null;
    task.classificationSource = priority ? 'manual' : 'unclassified';
  }
  dailyChangeVersion += 1;
  scheduleDailySave();
}

function toggleDailyDone(taskId) {
  const current = dailyTracked(taskId);
  state.daily.tracking[taskId] = current.done
    ? { done: false, doneAt: '' }
    : { done: true, doneAt: current.doneAt || localDateTimeValue() };
  dailyChangeVersion += 1;
  render();
  scheduleDailySave();
}

function updateDailyDoneAt(taskId, value) {
  if (!state.daily.tasks.some(task => task.id === taskId)) return;
  state.daily.tracking[taskId] = { done: true, doneAt: value };
  dailyChangeVersion += 1;
  scheduleDailySave();
}

function deleteDailyTask(taskId) {
  const task = state.daily.tasks.find(item => item.id === taskId);
  if (!task || !window.confirm(`确定从今日清单删除“${task.name}”吗？`)) return;
  state.daily.tasks = state.daily.tasks.filter(item => item.id !== taskId);
  delete state.daily.tracking[taskId];
  if (!state.daily.removedTaskIds.includes(taskId)) {
    state.daily.removedTaskIds.push(taskId);
  }
  state.daily.sourceSummary = {
    ...state.daily.sourceSummary,
    taskCount: state.daily.tasks.length,
  };
  dailyChangeVersion += 1;
  render();
  scheduleDailySave();
}

function reportItemText(item) {
  return typeof item === 'string' ? item : String(item?.text || '');
}

function hydrateReport() {
  const target = document.getElementById('report-markdown');
  if (!target || !state.report) return;
  const markdown = [
    '### 精力分配原则', '',
    ...state.report.energyRules.map(reportItemText), '',
    '### 改变与举措', '',
    ...state.report.adjustments.map(reportItemText),
  ].join('\n');
  window.renderMarkdown(target, markdown);
}

function historyReportMarkdown(item) {
  const taskById = new Map(item.tasks.map(task => [task.id, task]));
  return [
    '## 今日优先处理顺序', '',
    ...item.report.order.map(entry => `- ${taskById.get(entry.taskId)?.name || ''} — ${entry.reason}`), '',
    '## 精力分配原则', '', ...item.report.energyRules.map(reportItemText), '',
    '## 改变与举措', '', ...item.report.adjustments.map(reportItemText),
  ].join('\n');
}

function hydrateHistoryReport() {
  const target = document.getElementById('history-report-markdown');
  if (target && state.historyDetail) window.renderMarkdown(target, historyReportMarkdown(state.historyDetail));
}

let progressTimer = null;
let progressStartedAt = 0;

function renderProcessing(title, subtitle, steps, { cancelable = true, baseAction = false } = {}) {
  const panel = document.getElementById('panel');
  if (!panel) return;
  clearInterval(progressTimer);
  progressStartedAt = Date.now();
  const existing = panel.innerHTML;
  // 保留上一步结果与已确认任务，只叠加进度卡片，不整页覆盖
  panel.innerHTML = `<div class="panel-progress"><div class="aiproc">
    <div class="ai-orb"></div>
    <div style="font-size:16px;font-weight:750">${escapeHtml(title)}</div>
    <div style="color:var(--muted);font-size:13px">${escapeHtml(subtitle)}</div>
    <div class="ai-steps">${steps.map(text => `<div class="ai-step"><span class="dot"></span>${escapeHtml(text)}</div>`).join('')}</div>
    <div class="progress-wait">已等待 <span id="progress-elapsed">0</span> 秒</div>
    ${baseAction ? '<div class="progress-hint">模型响应较慢，你可以继续使用基础报告。</div>' : ''}
    <div class="progress-actions">
      ${baseAction ? '<button class="btn btn-ghost btn-sm" data-action="use-base-report">使用基础报告</button>' : ''}
      ${cancelable ? '<button class="btn btn-ghost btn-sm" data-action="cancel-workflow">取消生成</button>' : ''}
    </div>
  </div><div class="progress-dim">${existing}</div></div>`;
  progressTimer = setInterval(() => {
    const element = document.getElementById('progress-elapsed');
    if (element) {
      element.textContent = String(Math.max(0, Math.round((Date.now() - progressStartedAt) / 1000)));
    }
  }, 1000);
}

function handleWorkflowError(error, id) {
  if (!isCurrent(id) || error.code === 'REQUEST_CANCELLED') return;
  state.pending = null;
  state.error = error;
  render();
  toast(error.message || '请求失败，请重试。');
}

function serializedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function recordTaskVisible(startedAt, decompositionId) {
  const metrics = globalThis.__TIME_MANAGEMENT_PERFORMANCE__ ||= [];
  metrics.push({
    name: 'task-visible',
    decompositionId,
    durationMs: Math.max(0, performance.now() - startedAt),
  });
  if (metrics.length > 20) metrics.splice(0, metrics.length - 20);
}

function coachingRequestPayload() {
  const taskStage = state.decomposition?.stages?.find(
    stage => stage.name === 'evidence-task-generation',
  );
  if (!taskStage || !Array.isArray(taskStage.output?.evidence)) return null;
  return {
    decompositionId: state.coaching.decompositionId,
    attemptId: state.coaching.attemptId,
    businessDate: state.decomposition.businessDate,
    entries: { ...state.entries },
    evidence: taskStage.output.evidence,
  };
}

function isCurrentCoaching({ decompositionId, attemptId, requestSequence }) {
  return state.decomposition?.decompositionId === decompositionId
    && state.coaching.decompositionId === decompositionId
    && state.coaching.attemptId === attemptId
    && state.coaching.requestSequence === requestSequence;
}

function mergeCoachingStage(stage) {
  const stages = state.decomposition.stages.filter(
    item => item.name !== 'coaching-analysis',
  );
  state.decomposition = { ...state.decomposition, stages: [...stages, stage] };
}

function renderCoachingStatus() {
  if (state.screen !== 'workspace') return;
  if (state.step === 2) {
    const host = document.getElementById('coaching-status-host');
    if (host) host.innerHTML = coachingStatus();
    return;
  }
  if (state.step === 5) render();
}

async function requestCoachingAnalysis() {
  const payload = coachingRequestPayload();
  const identity = {
    decompositionId: state.coaching.decompositionId,
    attemptId: state.coaching.attemptId,
    requestSequence: state.coaching.requestSequence,
  };
  if (!payload || serializedBytes(payload) > COACHING_REQUEST_MAX_BYTES) {
    if (!isCurrentCoaching(identity)) return;
    state.coaching.status = 'unavailable';
    state.coaching.error = {
      code: 'COACHING_PAYLOAD_TOO_LARGE',
      message: '教练诊断请求内容过大。',
    };
    renderCoachingStatus();
    return;
  }

  try {
    const result = await postJson(
      '/api/time-management/tasks/coaching-analysis',
      payload,
      { channel: 'coaching', cancelPrevious: true },
    );
    if (!isCurrentCoaching(identity)) return;
    if (
      result.decompositionId !== identity.decompositionId
      || result.attemptId !== identity.attemptId
      || !result.analysisId
      || result.stage?.name !== 'coaching-analysis'
      || result.stage.analysisId !== result.analysisId
    ) {
      throw Object.assign(new Error('教练诊断响应格式不正确。'), {
        code: 'COACHING_RESPONSE_INVALID',
      });
    }
    mergeCoachingStage(result.stage);
    state.coaching = {
      ...state.coaching,
      status: 'succeeded',
      analysisId: result.analysisId,
      stage: result.stage,
      error: null,
      historySyncStatus: 'pending',
    };
    renderCoachingStatus();
    void syncCurrentCoachingToHistory();
  } catch (error) {
    if (!isCurrentCoaching(identity)) return;
    const unavailable = error.status === 413
      || ['COACHING_PAYLOAD_TOO_LARGE', 'PAYLOAD_TOO_LARGE'].includes(error.code);
    state.coaching.status = unavailable
      ? 'unavailable'
      : error.code === 'MODEL_TIMEOUT'
        ? 'timed_out'
        : error.code === 'REQUEST_CANCELLED'
          ? 'cancelled'
          : 'failed';
    state.coaching.error = error;
    renderCoachingStatus();
  }
}

function retryCoachingAnalysis() {
  if (!['failed', 'timed_out', 'cancelled'].includes(state.coaching.status)) return;
  cancelRequestChannel('coaching');
  state.coaching = {
    ...state.coaching,
    status: 'running',
    requestSequence: state.coaching.requestSequence + 1,
    error: null,
  };
  renderCoachingStatus();
  void requestCoachingAnalysis();
}

async function decomposeTasks() {
  if (state.pending) return;
  cancelRequestChannel('coaching');
  resetCoaching();
  const id = ++operationId;
  const startedAt = performance.now();
  const entries = { ...state.entries };
  state.pending = 'decompose';
  renderProcessing('正在拆解可执行任务', '服务端一次生成证据与任务，校验完成后立即展示', ['校验四栏输入', '生成逐行证据与任务', '核验证据覆盖和任务来源', '标准化任务并完成 SMART 初检']);
  try {
    const result = await postJson('/api/time-management/tasks/decompose', { entries });
    if (!isCurrent(id)) return;
    const taskStage = result.decomposition?.stages?.find(
      stage => stage.name === 'evidence-task-generation',
    );
    if (
      !result.decomposition?.decompositionId
      || !result.decomposition.businessDate
      || !Array.isArray(taskStage?.output?.evidence)
      || !Array.isArray(result.tasks)
    ) {
      throw Object.assign(new Error('任务拆解响应格式不正确。'), {
        code: 'DECOMPOSITION_RESPONSE_INVALID',
      });
    }
    state.pending = null;
    state.intake = result.intake;
    state.decomposition = result.decomposition;
    state.tasks = result.tasks.map(normalizeTaskForUi);
    state.smart = result.smart;
    state.smartChecked = false;
    state.distribution = null;
    state.matrix = null;
    state.report = null;
    state.step = 2;
    state.maxStep = 2;
    state.clientRunId = createUuid();
    state.coaching = {
      status: 'running',
      decompositionId: result.decomposition.decompositionId,
      attemptId: createUuid(),
      requestSequence: 1,
      analysisId: null,
      stage: null,
      error: null,
      historySyncStatus: 'idle',
    };
    renderAtTop();
    recordTaskVisible(startedAt, result.decomposition.decompositionId);
    void requestCoachingAnalysis();
    toast(`已拆解出 ${result.tasks.length} 条任务`);
  } catch (error) {
    handleWorkflowError(error, id);
  }
}

async function checkSmart() {
  if (state.pending || !state.tasks.length) return;
  const id = ++operationId;
  state.pending = 'smart';
  render();
  try {
    const result = await postJson('/api/time-management/tasks/smart-check', { tasks: state.tasks });
    if (!isCurrent(id)) return;
    state.pending = null;
    state.smart = result;
    state.smartChecked = true;
    render();
    toast(result.overall === 'pass' ? '全部任务通过 SMART 校验' : `还有 ${result.summary.needFix} 条任务需要补全`);
  } catch (error) {
    handleWorkflowError(error, id);
  }
}

async function diagnoseDistribution() {
  if (!state.smartChecked) return toast('请先执行 SMART 校验');
  if (state.smart?.overall !== 'pass') return toast('请先补全所有标红字段');
  if (state.pending) return;
  const id = ++operationId;
  state.pending = 'distribution';
  renderProcessing('正在计算时间分布', '服务端按分钟汇总四类任务，不猜测缺失工时', ['解析任务工时', '汇总四类投入', '与目标区间比较', '生成诊断与改进方向']);
  try {
    const result = await postJson('/api/time-management/distribution/diagnose', { tasks: state.tasks });
    if (!isCurrent(id)) return;
    state.pending = null;
    state.distribution = result;
    state.matrix = null;
    state.report = null;
    state.step = 3;
    state.maxStep = 3;
    renderAtTop();
  } catch (error) {
    handleWorkflowError(error, id);
  }
}

function expectedQuadrant(task) {
  const important = task.importance === '高';
  const urgent = task.urgency === '高';
  if (important && urgent) return '第一象限';
  if (important) return '第二象限';
  if (urgent) return '第三象限';
  return '第四象限';
}

function validateAndMergeMatrix(tasks, matrix) {
  if (!matrix || !Array.isArray(matrix.classifications) || !Array.isArray(matrix.quadrants)) throw new Error('矩阵返回结构异常，请重试。');
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const classificationById = new Map();
  for (const item of matrix.classifications) {
    if (!item || classificationById.has(item.taskId) || !taskById.has(item.taskId)) throw new Error('矩阵任务集合不一致，请重试。');
    classificationById.set(item.taskId, item);
  }
  if (classificationById.size !== tasks.length) throw new Error('矩阵遗漏任务，请重试。');
  const merged = tasks.map(task => {
    const item = classificationById.get(task.id);
    if (!['高', '中', '低'].includes(item.importance) || !['高', '中', '低'].includes(item.urgency)) throw new Error('矩阵分类不完整，请重试。');
    if (task.classificationSource !== 'unclassified' && (item.importance !== task.importance || item.urgency !== task.urgency)) throw new Error('矩阵修改了已确认的轻重缓急，请重试。');
    return task.classificationSource === 'unclassified'
      ? { ...task, importance: item.importance, urgency: item.urgency, classificationSource: 'ai-matrix' }
      : task;
  });
  const placed = matrix.quadrants.flatMap(item => item.taskIds || []);
  if (placed.length !== tasks.length || new Set(placed).size !== tasks.length || placed.some(id => !taskById.has(id))) throw new Error('矩阵任务守恒失败，请重试。');
  for (const task of merged) {
    const quadrant = matrix.quadrants.find(item => (item.name || item.q) === expectedQuadrant(task));
    if (!quadrant?.taskIds.includes(task.id)) throw new Error('矩阵象限与轻重缓急不一致，请重试。');
  }
  return merged;
}

async function classifyTasks() {
  if (state.pending || !state.distribution) return;
  const id = ++operationId;
  state.pending = 'matrix';
  renderProcessing('正在进行优先级排序', '后端核验任务守恒并落入轻重缓急四象限', ['核对重要性与紧急度', '补齐未分类任务', '落位四象限', '验证任务不重不漏']);
  try {
    const matrix = await postJson('/api/time-management/matrix/classify', { tasks: state.tasks });
    if (!isCurrent(id)) return;
    state.tasks = validateAndMergeMatrix(state.tasks, matrix);
    state.pending = null;
    state.matrix = matrix;
    state.report = null;
    state.step = 4;
    state.maxStep = 4;
    renderAtTop();
  } catch (error) {
    handleWorkflowError(error, id);
  }
}

function validateReport(report) {
  if (!report || !Array.isArray(report.order) || !Array.isArray(report.energyRules) || !Array.isArray(report.adjustments)) throw new Error('报告返回结构异常，请重试。');
  const ids = new Set(state.tasks.map(task => task.id));
  const orderIds = report.order.map(item => item.taskId);
  if (new Set(orderIds).size !== orderIds.length || orderIds.some(id => !ids.has(id))) throw new Error('报告引用了无效任务，请重试。');
}

async function generateReport({ baseOnly = false } = {}) {
  if (state.pending || !state.matrix || !state.distribution) return;
  const id = ++operationId;
  state.pending = 'report';
  renderProcessing('正在生成优化报告', '综合任务、时间结构和四象限生成行动建议', ['汇总优先处理顺序', '读取时间分布诊断', '校准精力分配', '输出改变与举措'], { baseAction: !baseOnly });
  try {
    const body = {
      tasks: state.tasks,
      matrix: state.matrix,
      goals: state.entries,
      distribution: state.distribution,
    };
    if (baseOnly) body.baseOnly = true;
    const report = await postJson('/api/time-management/report/generate', body);
    if (!isCurrent(id)) return;
    validateReport(report);
    state.pending = null;
    state.report = report;
    state.step = 5;
    state.maxStep = 5;
    renderAtTop();
    saveCurrentHistory();
  } catch (error) {
    handleWorkflowError(error, id);
  }
}

function updateTask(taskId, field, value) {
  const task = state.tasks.find(item => item.id === taskId);
  if (!task) return;
  if (field === 'name') task.name = value.trim();
  else if (field === 'category') task.source = CATS[value]?.source || '今天';
  else if (field === 'due') task.due = value || '待确认';
  else if (field === 'est') task.est = normalizeEstimate(value);
  else if (field === 'owner') task.owner = value.trim() || '待确认';
  else if (field === 'priority') {
    const priority = PRIORITIES[value];
    task.importance = priority?.importance ?? null;
    task.urgency = priority?.urgency ?? null;
    task.classificationSource = priority ? 'manual' : 'unclassified';
  }
  invalidateAfterTasks();
  if (state.screen === 'workspace') state.step = 2;
  render();
}

function deleteTask(taskId) {
  state.tasks = state.tasks.filter(task => task.id !== taskId);
  delete state.tracking[taskId];
  invalidateAfterTasks();
  if (state.screen === 'workspace') state.step = Math.min(state.step, 2);
  render();
  toast('任务已删除，后续节点需要重新执行');
}

function openAddTask(category = '今天') {
  state.modal = { type: 'add-task', category };
  renderModal();
  document.getElementById('m-name')?.focus();
}

function closeModal() {
  state.modal = null;
  renderModal();
}

function saveTask() {
  const name = document.getElementById('m-name')?.value.trim();
  const estValue = document.getElementById('m-est')?.value;
  const dueValue = document.getElementById('m-due')?.value;
  const priorityKey = document.getElementById('m-priority')?.value;
  const category = document.getElementById('m-category')?.value;
  const ownerValue = document.getElementById('m-owner')?.value.trim();
  const priority = PRIORITIES[priorityKey];
  if (!name || !normalizeEstimate(estValue) || !priority) {
    document.getElementById('m-error')?.classList.remove('hidden');
    return;
  }
  state.tasks.push({
    id: createUuid(), name, source: CATS[category]?.source || '今天',
    due: dueValue || '待确认',
    est: normalizeEstimate(estValue), importance: priority.importance, urgency: priority.urgency,
    owner: ownerValue || '待确认',
    acceptanceCriteria: [], nextAction: '', status: 'pending', classificationSource: 'manual',
  });
  invalidateAfterTasks();
  if (state.screen === 'workspace') {
    state.step = 2;
    state.maxStep = 2;
  }
  closeModal();
  render();
  toast('已添加任务');
}

function toggleDone(taskId) {
  const current = tracked(taskId);
  state.tracking[taskId] = current.done ? { done: false, doneAt: '' } : { done: true, doneAt: current.doneAt || localDateTimeValue() };
  render();
  toast(state.tracking[taskId].done ? '已记录完成时间' : '已取消完成');
}

function copyTextFallback(text) {
  if (typeof document.execCommand !== 'function') return false;
  const activeElement = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.dataset.copyFallback = '';
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand('copy');
  } finally {
    textarea.remove();
    if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true });
  }
}

async function copyText(text, success) {
  if (!text) return toast('没有可复制内容');
  let copied = false;
  if (typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = false;
    }
  }
  if (!copied) copied = copyTextFallback(text);
  toast(copied ? success : '复制失败，请手动选择内容');
}

function currentHistoryTitle() {
  return `${TODAY} 时间管理优化报告`;
}

function currentHistorySnapshot() {
  return {
    clientRunId: state.clientRunId,
    title: currentHistoryTitle(),
    goals: state.entries,
    decomposition: state.decomposition,
    tasks: state.tasks,
    distribution: state.distribution,
    matrix: state.matrix,
    report: state.report,
  };
}

function renderCurrentHistoryStatus() {
  if (state.screen === 'workspace' && state.step === 5) render();
}

function historyWriteKey(clientRunId, decompositionId) {
  return `${clientRunId}:${decompositionId || 'none'}`;
}

function enqueueHistoryWrite(key, operation) {
  const previous = historyWriteChains.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  historyWriteChains.set(key, current);
  const cleanup = () => {
    if (historyWriteChains.get(key) === current) historyWriteChains.delete(key);
  };
  current.then(cleanup, cleanup);
  return current;
}

function syncCurrentCoachingToHistory() {
  const save = state.historySave;
  const coaching = state.coaching;
  if (
    save.status !== 'saved'
    || !save.id
    || coaching.status !== 'succeeded'
    || !coaching.stage
    || save.clientRunId !== state.clientRunId
    || save.decompositionId !== coaching.decompositionId
    || state.decomposition?.decompositionId !== coaching.decompositionId
  ) {
    return Promise.resolve(null);
  }

  const key = historyWriteKey(save.clientRunId, save.decompositionId);
  const patchKey = `${key}:${coaching.analysisId}`;
  const existing = historyPatchPromises.get(patchKey);
  if (existing) return existing;

  state.coaching.historySyncStatus = 'saving';
  const identity = {
    historyId: save.id,
    clientRunId: save.clientRunId,
    decompositionId: coaching.decompositionId,
    analysisId: coaching.analysisId,
  };
  const promise = enqueueHistoryWrite(key, () => patchJson(
    `/api/time-management/history/${encodeURIComponent(identity.historyId)}/coaching-analysis`,
    {
      decompositionId: identity.decompositionId,
      analysisId: identity.analysisId,
      coachingStage: coaching.stage,
    },
    { channel: 'history-write', cancelPrevious: false },
  )).then((item) => {
    if (
      state.clientRunId === identity.clientRunId
      && state.coaching.analysisId === identity.analysisId
      && state.historySave.id === identity.historyId
    ) {
      state.coaching.historySyncStatus = 'succeeded';
      renderCoachingStatus();
    }
    return item;
  }).catch((error) => {
    if (
      state.clientRunId === identity.clientRunId
      && state.coaching.analysisId === identity.analysisId
      && state.historySave.id === identity.historyId
    ) {
      state.coaching.historySyncStatus = 'failed';
      state.coaching.error = error;
      renderCoachingStatus();
    }
    return null;
  });
  historyPatchPromises.set(patchKey, promise);
  promise.then(() => {
    if (historyPatchPromises.get(patchKey) === promise) {
      historyPatchPromises.delete(patchKey);
    }
  });
  return promise;
}

function retryCurrentCoachingHistory() {
  if (state.coaching.historySyncStatus !== 'failed') return;
  void syncCurrentCoachingToHistory();
  renderCoachingStatus();
}

function saveCurrentHistory() {
  if (!state.report || !state.matrix || !state.distribution) return Promise.resolve(null);
  const snapshot = currentHistorySnapshot();
  const decompositionId = snapshot.decomposition?.decompositionId || null;
  const key = historyWriteKey(snapshot.clientRunId, decompositionId);
  const existing = historySavePromises.get(key);
  if (existing) return existing;

  state.historySave = {
    status: 'saving',
    id: state.historySave.id,
    clientRunId: snapshot.clientRunId,
    decompositionId,
    message: '',
  };
  renderCurrentHistoryStatus();
  const promise = enqueueHistoryWrite(key, () => postJson(
    '/api/time-management/history',
    snapshot,
    { channel: 'history-write', cancelPrevious: false },
  )).then((item) => {
    if (state.clientRunId !== snapshot.clientRunId) return item;
    state.historySave = {
      status: 'saved',
      id: item.id,
      clientRunId: snapshot.clientRunId,
      decompositionId,
      message: '',
    };
    renderCurrentHistoryStatus();
    void syncCurrentCoachingToHistory();
    return item;
  }).catch(() => {
    if (state.clientRunId !== snapshot.clientRunId) return null;
    state.historySave = {
      status: 'failed',
      id: null,
      clientRunId: snapshot.clientRunId,
      decompositionId,
      message: '报告已生成，但历史保存失败。',
    };
    renderCurrentHistoryStatus();
    return null;
  });
  historySavePromises.set(key, promise);
  promise.then(() => {
    if (historySavePromises.get(key) === promise) historySavePromises.delete(key);
  });
  return promise;
}

async function loadHistory({ append = false } = {}) {
  if (state.pending === 'history-list') return;
  const readId = ++historyReadId;
  const cursor = append ? state.historyCursor : null;
  if (!append) {
    state.historyItems = [];
    state.historyCursor = null;
  }
  state.pending = 'history-list';
  state.error = null;
  render();
  try {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor) query.set('cursor', cursor);
    const result = await getJson(`/api/time-management/history?${query}`, {
      channel: 'history-read',
      cancelPrevious: true,
    });
    if (readId !== historyReadId || state.screen !== 'history') return;
    state.historyItems = append ? [...state.historyItems, ...result.items] : result.items;
    state.historyCursor = result.nextCursor;
    state.pending = null;
    render();
  } catch (error) {
    if (readId !== historyReadId || state.screen !== 'history') return;
    state.pending = null;
    if (error.code !== 'REQUEST_CANCELLED') state.error = error;
    render();
  }
}

async function openHistoryDetail(id) {
  if (state.pending) return;
  const readId = ++historyReadId;
  state.pending = 'history-detail';
  try {
    const item = await getJson(
      `/api/time-management/history/${encodeURIComponent(id)}`,
      { channel: 'history-read', cancelPrevious: true },
    );
    if (readId !== historyReadId || state.screen !== 'history') return;
    state.historyDetail = item;
    state.pending = null;
    state.screen = 'history-detail';
    renderAtTop();
  } catch (error) {
    if (readId !== historyReadId || state.screen !== 'history') return;
    state.pending = null;
    if (error.code !== 'REQUEST_CANCELLED') state.error = error;
    render();
  }
}

async function deleteHistory(id) {
  if (!window.confirm('确定删除这条账号历史吗？')) return;
  if (state.pending) return;
  state.pending = 'history-delete';
  try {
    await deleteJson(
      `/api/time-management/history/${encodeURIComponent(id)}`,
      { channel: 'history-write', cancelPrevious: false },
    );
    state.historyItems = state.historyItems.filter(item => item.id !== id);
    if (state.historyDetail?.id === id) {
      state.historyDetail = null;
      state.screen = 'history';
    }
    state.pending = null;
    render();
  } catch (error) {
    state.pending = null;
    state.error = error;
    render();
  }
}

function navigate(screen) {
  if (screen === state.screen && screen === 'daily') return;
  if (!confirmDailyLeave(screen)) return;
  if (screen !== 'daily') dailyLoadId += 1;
  if (screen !== 'home') homeDailyLoadId += 1;
  if (!['history', 'history-detail'].includes(screen)) {
    historyReadId += 1;
    cancelRequestChannel('history-read');
  }
  cancelPending();
  state.error = null;
  if (screen === 'workspace') {
    state.screen = 'workspace';
    state.step = Math.min(Math.max(state.step, 1), state.maxStep);
  } else if (screen === 'history') {
    state.screen = 'history';
    state.historyDetail = null;
    render();
    loadHistory();
    return;
  } else if (screen === 'daily') {
    state.screen = 'daily';
    renderAtTop();
    loadDaily();
    return;
  } else state.screen = screen;
  renderAtTop();
  if (screen === 'home') loadHomeDaily();
}

function navigateStep(step) {
  if (step > state.maxStep) return toast('请先完成前一个节点');
  state.step = step;
  renderAtTop();
}

async function loadPreAuthCsrf() {
  const result = await getJson('/api/auth/csrf');
  rememberCsrfToken(result.csrfToken);
}

async function restoreAuth() {
  try {
    const session = await getJson('/api/auth/me');
    state.user = session.user;
    rememberCsrfToken(session.csrfToken);
    state.authReady = true;
    state.authError = null;
    resetState();
  } catch (error) {
    state.user = null;
    rememberCsrfToken(null);
    state.authReady = true;
    resetState();
    try {
      await loadPreAuthCsrf();
      state.authError = error.status === 401 ? null : error;
    } catch (csrfError) {
      state.authError = csrfError;
    }
  }
  render();
  if (state.user && state.screen === 'home') loadHomeDaily();
}

function authFormError(form, message) {
  const element = form.querySelector('.auth-error');
  if (element) element.textContent = message || '';
}

async function submitLogin(form) {
  if (state.pending) return;
  const data = new FormData(form);
  state.pending = 'auth';
  authFormError(form, '');
  render();
  try {
    await postJson('/api/auth/login', { username: data.get('username'), password: data.get('password') });
    const session = await getJson('/api/auth/me');
    state.user = session.user;
    rememberCsrfToken(session.csrfToken);
    state.pending = null;
    state.authError = null;
    resetState();
    render();
    loadHomeDaily();
  } catch (error) {
    state.pending = null;
    state.authError = error;
    render();
  }
}

async function submitRegister(form) {
  if (state.pending) return;
  const data = new FormData(form);
  if (data.get('password') !== data.get('passwordConfirm')) {
    authFormError(form, '两次输入的密码不一致。');
    return;
  }
  state.pending = 'auth';
  render();
  try {
    const result = await postJson('/api/auth/register', { username: data.get('username'), password: data.get('password') });
    state.pending = null;
    state.recoveryCode = result.recoveryCode;
    state.screen = 'recovery-code';
    render();
  } catch (error) {
    state.pending = null;
    state.authError = error;
    render();
  }
}

async function submitRecovery(form) {
  if (state.pending) return;
  const data = new FormData(form);
  if (data.get('newPassword') !== data.get('newPasswordConfirm')) {
    authFormError(form, '两次输入的新密码不一致。');
    return;
  }
  state.pending = 'auth';
  render();
  try {
    const result = await postJson('/api/auth/password/reset-with-recovery', {
      username: data.get('username'), recoveryCode: data.get('recoveryCode'), newPassword: data.get('newPassword'),
    });
    state.pending = null;
    state.recoveryCode = result.recoveryCode;
    state.screen = 'recovery-code';
    render();
  } catch (error) {
    state.pending = null;
    state.authError = error;
    render();
  }
}

async function logout() {
  if (!confirmDailyLeave('login')) return;
  if (state.pending) return;
  cancelPending();
  cancelRequestChannel('coaching');
  cancelRequestChannel('history-read');
  cancelRequestChannel('history-write');
  state.pending = 'auth';
  try {
    await postJson('/api/auth/logout');
    state.user = null;
    rememberCsrfToken(null);
    state.pending = null;
    state.recoveryCode = null;
    state.authError = null;
    resetState();
    await loadPreAuthCsrf();
    render();
  } catch (error) {
    state.pending = null;
    toast(error.message || '退出失败，请重试。');
  }
}

document.addEventListener('submit', event => {
  const form = event.target.closest('[data-auth-form]');
  if (!form) return;
  event.preventDefault();
  if (form.dataset.authForm === 'login') submitLogin(form);
  else if (form.dataset.authForm === 'register') submitRegister(form);
  else if (form.dataset.authForm === 'recovery') submitRecovery(form);
});

document.addEventListener('input', event => {
  const dailyTaskId = event.target.dataset.dailyTaskId;
  const dailyTaskField = event.target.dataset.dailyTaskField;
  if (dailyTaskId && dailyTaskField) {
    updateDailyTask(dailyTaskId, dailyTaskField, event.target.value);
    return;
  }
  const key = event.target.dataset.entry;
  if (!key) return;
  cancelRequestChannel('coaching');
  state.entries[key] = event.target.value;
  invalidateAfterEntries();
});

document.addEventListener('change', event => {
  const taskId = event.target.dataset.taskId;
  const field = event.target.dataset.taskField;
  if (taskId && field) {
    updateTask(taskId, field, event.target.value);
    return;
  }
  const trackingId = event.target.dataset.trackTime;
  if (trackingId) {
    state.tracking[trackingId] = { done: true, doneAt: event.target.value };
    return;
  }
  const dailyTrackingId = event.target.dataset.dailyTrackTime;
  if (dailyTrackingId) {
    updateDailyDoneAt(dailyTrackingId, event.target.value);
  }
});

document.addEventListener('click', event => {
  const nav = event.target.closest('[data-nav]');
  if (nav) return navigate(nav.dataset.nav);
  const step = event.target.closest('[data-step]');
  if (step) return navigateStep(Number(step.dataset.step));
  const element = event.target.closest('[data-action]');
  const action = element?.dataset.action;
  if (!action) {
    if (event.target.matches('[data-modal-mask]')) closeModal();
    return;
  }
  if (action === 'home') navigate(state.user ? 'home' : 'login');
  else if (action === 'open-workspace') navigate('workspace');
  else if (action === 'back-step') navigateStep(Math.max(1, state.step - 1));
  else if (action === 'decompose') decomposeTasks();
  else if (action === 'smart-check') checkSmart();
  else if (action === 'coaching-retry') retryCoachingAnalysis();
  else if (action === 'coaching-history-retry') retryCurrentCoachingHistory();
  else if (action === 'diagnose') diagnoseDistribution();
  else if (action === 'classify') classifyTasks();
  else if (action === 'generate-report') generateReport();
  else if (action === 'use-base-report') generateReport({ baseOnly: true });
  else if (action === 'regenerate-report') generateReport();
  else if (action === 'cancel-workflow') {
    clearInterval(progressTimer);
    cancelPending();
    state.error = null;
    render();
  }
  else if (action === 'open-add-task') openAddTask(element.dataset.defaultCategory || '今天');
  else if (action === 'close-modal') closeModal();
  else if (action === 'save-task') saveTask();
  else if (action === 'delete-task') deleteTask(element.dataset.taskId);
  else if (action === 'toggle-done') toggleDone(element.dataset.taskId);
  else if (action === 'delete-daily-task') deleteDailyTask(element.dataset.taskId);
  else if (action === 'toggle-daily-done') toggleDailyDone(element.dataset.taskId);
  else if (action === 'retry-daily-save') saveDaily();
  else if (action === 'reload-daily') reloadDaily();
  else if (action === 'open-daily') navigate('daily');
  else if (action === 'export-daily-excel') exportDailyToExcel();
  else if (action === 'copy-report') copyText(document.querySelector('.panel-body')?.innerText.trim(), '已复制报告');
  else if (action === 'history-retry') saveCurrentHistory();
  else if (action === 'history-more') loadHistory({ append: true });
  else if (action === 'history-detail') openHistoryDetail(element.dataset.historyId);
  else if (action === 'history-delete') deleteHistory(element.dataset.historyId);
  else if (action === 'history-back') { state.historyDetail = null; navigate('history'); }
  else if (action === 'history-copy') copyText(document.querySelector('.history-detail-content')?.innerText.trim(), '已复制历史报告');
  else if (action === 'toggle-home-daily') toggleHomeDaily();
  else if (action === 'reload-home-daily') loadHomeDaily();
  else if (action === 'auth-login-tab') { state.authMode = 'login'; state.authError = null; render(); }
  else if (action === 'auth-register-tab') { state.authMode = 'register'; state.authError = null; render(); }
  else if (action === 'show-recovery') { state.screen = 'recovery'; state.authError = null; render(); }
  else if (action === 'show-login') { state.screen = 'login'; state.authMode = 'login'; state.authError = null; render(); }
  else if (action === 'confirm-recovery-code') { state.recoveryCode = null; state.screen = 'login'; state.authMode = 'login'; render(); }
  else if (action === 'logout') logout();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.modal) closeModal();
  const brand = event.target.closest('.brand');
  if (brand && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    navigate(state.user ? 'home' : 'login');
  }
});

window.addEventListener('beforeunload', event => {
  if (!hasUnsafeDailyChanges()) return;
  event.preventDefault();
  event.returnValue = '';
});

render();
restoreAuth();
