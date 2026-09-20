const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const deploymentConfig = globalThis.EVIDENCE_AGENT_CONFIG || {};

const state = {
  view: 'sales',
  stage: 'idle',
  pendingTopic: null,
  attachments: [],
  apiBaseUrl: localStorage.getItem('evidenceAgentApi') || deploymentConfig.apiBaseUrl || '',
  role: null,
  user: null,
  authSource: null,
  recordTestConversation: false,
  currentConversationId: null,
  currentTranscript: [],
  currentTopic: null,
  selectedRecordId: null,
  lastEvalRunId: null,
  feedbackScope: 'platform',
  feedbackRating: 0,
  feedbackFilter: 'all',
  feedbackItems: [],
  selectedFeedbackId: null,
};

const demoUsers = {
  sales: { id: 'demo_sales', name: '销售演示', role: 'sales', department: '演示销售组' },
  ops: { id: 'demo_ops', name: '运营演示', role: 'ops', department: '演示运营组' },
};

const RECORDS_KEY = 'zedataiConversationRecords';
const EVALS_KEY = 'zedataiEvaluationExamples';
const MODEL_CONFIG_KEY = 'zedataiModelConfig';
const FEEDBACK_KEY = 'zedataiSalesFeedback';
const evaluationContextByNode = new WeakMap();
const topicLabels = {
  payment: '合同与付款',
  delivery: '交付承诺',
  refund: '售后退款',
  discount: '报价折扣',
  unknown: '知识缺口',
};

function evidenceMetaForTopic(topic) {
  if (topic === 'delivery') return { title: '实施交付 SLA v3.2', url: 'https://example.feishu.cn/file/delivery-sla', updated: '2026-09-16 09:05' };
  if (topic === 'payment') return { title: '2026 企业版商务政策', url: 'https://example.feishu.cn/docx/business-policy', updated: '2026-09-12 18:30' };
  if (topic === 'refund') return { title: '售后退款处理 SOP', url: 'https://example.feishu.cn/docx/refund-sop', updated: '2026-08-22 16:45' };
  if (topic === 'discount') return { title: '2026 企业版商务政策', url: 'https://example.feishu.cn/docx/business-policy', updated: '2026-09-12 18:30' };
  return { title: '销售制度库', url: 'https://example.feishu.cn/wiki/sales-index', updated: '2026-09-15' };
}

function loadConversationRecords() {
  try {
    const records = JSON.parse(localStorage.getItem(RECORDS_KEY) || '[]');
    return Array.isArray(records) ? records : [];
  } catch (_) {
    return [];
  }
}

function saveConversationRecords(records) {
  localStorage.setItem(RECORDS_KEY, JSON.stringify(records.slice(0, 100)));
  if (state.view === 'ops') renderOpsData();
}

function riskForText(text) {
  if (/保证|一定|百分百|承诺|今天.*完成|本周.*上线|直接写进合同/.test(text)) return 'high';
  if (/折扣|报价|退款|到账|合同|合规|海外/.test(text)) return 'medium';
  return 'low';
}

function maxRisk(a, b) {
  const rank = { low: 1, medium: 2, high: 3 };
  return rank[a] >= rank[b] ? a : b;
}

function persistUserMessage(text, topic) {
  const records = loadConversationRecords();
  let record = state.currentConversationId ? records.find((item) => item.id === state.currentConversationId) : null;
  const now = new Date().toISOString();
  if (!record) {
    const id = globalThis.crypto?.randomUUID?.() || `conv_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    state.currentConversationId = id;
    record = {
      id,
      startedAt: now,
      updatedAt: now,
      actorId: state.user.id,
      actorName: state.user.name,
      department: state.user.department,
      actorRole: state.role,
      source: state.role === 'ops' ? '运营测试' : '销售对话',
      category: topicLabels[topic] || topicLabels.unknown,
      risk: riskForText(text),
      status: 'pending',
      question: text,
      messages: [],
      countInAnalytics: true,
      evidenceTitle: evidenceMetaForTopic(topic).title,
      evidenceUrl: evidenceMetaForTopic(topic).url,
      evidenceUpdated: evidenceMetaForTopic(topic).updated,
    };
    records.unshift(record);
  }
  record.updatedAt = now;
  record.category = record.category === topicLabels.unknown ? (topicLabels[topic] || record.category) : record.category;
  record.risk = maxRisk(record.risk, riskForText(text));
  record.messages.push({ role: 'user', text, at: now });
  saveConversationRecords(records);
  return record.id;
}

function htmlToPlainText(html) {
  const node = document.createElement('div');
  node.innerHTML = html;
  return (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
}

function persistAssistantMessage(recordId, html) {
  if (!recordId) return;
  const records = loadConversationRecords();
  const record = records.find((item) => item.id === recordId);
  if (!record) return;
  const now = new Date().toISOString();
  record.updatedAt = now;
  record.messages.push({ role: 'assistant', text: htmlToPlainText(html), at: now });
  record.analysis = record.risk === 'high'
    ? '命中保证性承诺或明确时点风险，建议运营优先复核。'
    : record.category === topicLabels.unknown
      ? '当前授权知识中缺少直接证据，建议补充或更新文档。'
      : '已找到可回溯证据，建议抽查引用与更新时间。';
  record.status = record.risk === 'high' || record.category === topicLabels.unknown ? 'pending' : 'done';
  saveConversationRecords(records);
}

function syncCurrentOpsTranscript(topic = state.currentTopic) {
  if (state.role !== 'ops' || !state.recordTestConversation || !state.user) return null;
  const userMessages = state.currentTranscript.filter((message) => message.role === 'user');
  if (!userMessages.length) return null;

  const records = loadConversationRecords();
  const now = new Date().toISOString();
  const combinedUserText = userMessages.map((message) => message.text).join(' ');
  const resolvedTopic = topic || classifyQuestion(combinedUserText);
  const meta = evidenceMetaForTopic(resolvedTopic);
  let record = state.currentConversationId ? records.find((item) => item.id === state.currentConversationId) : null;

  if (!record) {
    const id = globalThis.crypto?.randomUUID?.() || `conv_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    state.currentConversationId = id;
    record = { id, startedAt: state.currentTranscript[0]?.at || now };
    records.unshift(record);
  }

  record.updatedAt = now;
  record.actorId = state.user.id;
  record.actorName = state.user.name;
  record.department = state.user.department;
  record.actorRole = 'ops';
  record.source = '运营测试';
  record.category = topicLabels[resolvedTopic] || topicLabels.unknown;
  record.risk = userMessages.reduce((risk, message) => maxRisk(risk, riskForText(message.text)), 'low');
  record.status = record.risk === 'high' || record.category === topicLabels.unknown ? 'pending' : 'done';
  record.question = userMessages[0].text;
  record.messages = state.currentTranscript.map((message) => ({ ...message }));
  record.countInAnalytics = true;
  record.evidenceTitle = meta.title;
  record.evidenceUrl = meta.url;
  record.evidenceUpdated = meta.updated;
  record.analysis = record.risk === 'high'
    ? '运营测试命中保证性承诺或明确时点风险，已计入分析。'
    : record.category === topicLabels.unknown
      ? '运营测试识别到知识缺口，已计入分析。'
      : '运营测试已完成自动归类并计入分析。';
  saveConversationRecords(records);
  return record.id;
}

const pageMeta = {
  sales: ['销售工作台', '智能问答', '有证据，才回答'],
  ops: ['运营工作台', '洞察与风险', '让一线问题变成改进线索'],
  optimize: ['运营工作台', '评测与优化', '先评测，再发布'],
  knowledge: ['知识管理', '知识源', '每条答案都回到原始文件'],
  settings: ['系统管理', '接入配置', '把演示原型连到真实飞书'],
};

const evidence = {
  payment: [
    { title: '2026 企业版商务政策', url: 'https://example.feishu.cn/docx/business-policy', updated: '2026-09-12 18:30', quote: '企业版标准付款周期为年付。月付属于非标商务条件，须经区域销售负责人及商务运营审批后方可对外确认。' },
    { title: '标准合同付款与开票说明.pdf', url: 'https://example.feishu.cn/file/contract-payment', updated: '2026-09-08 11:20', quote: '未经书面审批，不得在报价单、邮件或合同附件中承诺非标准付款周期。' },
  ],
  delivery: [
    { title: '实施交付 SLA v3.2.docx', url: 'https://example.feishu.cn/file/delivery-sla', updated: '2026-09-16 09:05', quote: '具体上线日期须以实施评估、资源锁定及双方项目计划书为准。销售不得在评估完成前作保证性承诺。' },
    { title: '项目排期确认流程', url: 'https://example.feishu.cn/docx/schedule-process', updated: '2026-09-10 15:40', quote: '完成需求边界确认后，由实施负责人在项目群内书面确认计划；口头预估不作为合同交付依据。' },
  ],
  refund: [
    { title: '售后退款处理 SOP', url: 'https://example.feishu.cn/docx/refund-sop', updated: '2026-08-22 16:45', quote: '企业客户退款须提交合同编号、付款凭证、退款原因及审批记录。材料齐全后由客户成功发起流程。' },
  ],
  discount: [
    { title: '渠道折扣审批截图.png（OCR）', url: 'https://example.feishu.cn/file/discount-approval', updated: '2026-09-14 14:18', quote: '标准折扣区间以客户规模和合同金额为准；超出区域权限的折扣需提交商务运营复核。OCR 结果需与原图核对。' },
    { title: '2026 企业版商务政策', url: 'https://example.feishu.cn/docx/business-policy', updated: '2026-09-12 18:30', quote: '折扣信息属于内部经营信息。对外报价以审批后的报价单为准，不得仅依据历史案例承诺。' },
  ],
};

function escapeHtml(value = '') {
  const el = document.createElement('div');
  el.textContent = value;
  return el.innerHTML;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function isPlaceholderUrl(value = '') {
  try {
    const url = new URL(value, location.href);
    return !/^https?:$/.test(url.protocol) || url.hostname === 'example.feishu.cn';
  } catch (_) {
    return true;
  }
}

function navigateTop(url) {
  try {
    if (window.top && window.top !== window.self) {
      window.top.location.assign(url);
      return;
    }
  } catch (_) {
    // Cross-origin Feishu containers may deny top navigation; use the current view instead.
  }
  window.location.assign(url);
}

function openExternalDocument(url) {
  if (isPlaceholderUrl(url)) {
    showToast('当前为演示资料；接入真实飞书文档后即可打开原文件');
    return;
  }
  const opened = window.open(url, '_blank');
  if (opened) {
    try { opened.opener = null; } catch (_) { /* no-op */ }
    return;
  }
  navigateTop(url);
}

function switchView(view) {
  if (!state.role) return;
  if (state.role === 'sales' && view !== 'sales') {
    showToast('销售账号没有运营后台权限');
    view = 'sales';
  }
  state.view = view;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $$('.view').forEach((item) => item.classList.toggle('active', item.id === `view-${view}`));
  const [section, page, title] = pageMeta[view];
  $('#section-label').textContent = section;
  $('#page-label').textContent = page;
  $('#page-title').textContent = title;
  if (view === 'ops') { renderOpsData(); renderFeedbackInbox(); }
  if (view === 'optimize') renderEvaluationWorkspace();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function canUseElement(element) {
  const roles = (element.dataset.roles || '').split(',').filter(Boolean);
  return !roles.length || roles.includes(state.role);
}

function applyRoleAccess() {
  $$('[data-roles]').forEach((element) => {
    element.dataset.roleHidden = canUseElement(element) ? 'false' : 'true';
  });
  $('#test-mode-bar').hidden = state.role !== 'ops';
  $('#record-test-toggle').checked = state.recordTestConversation;
  $('#profile-name').textContent = state.user.name;
  $('#profile-avatar').textContent = state.user.name.slice(0, 1);
  $('#profile-role').textContent = `${state.role === 'ops' ? '运营人员' : '销售人员'} · ${state.user.department}`;
  $('#role-chip').textContent = state.role === 'ops' ? '运营工作区' : '销售工作区';
  document.body.dataset.role = state.role;
  if (state.role === 'sales' && state.view !== 'sales') switchView('sales');
}

function completeLogin(user, source = 'demo') {
  if (!user || !['sales', 'ops'].includes(user.role)) return;
  state.user = user;
  state.role = user.role;
  state.authSource = source;
  state.recordTestConversation = false;
  $('#login-screen').classList.add('hidden');
  $('#app-shell').classList.remove('auth-locked');
  applyRoleAccess();
  switchView('sales');
  showToast(`${user.name}，已进入${user.role === 'ops' ? '运营' : '销售'}工作区`);
}

function logout() {
  if (state.authSource === 'feishu' && state.apiBaseUrl) {
    const returnTo = encodeURIComponent(location.origin + location.pathname);
    navigateTop(`${state.apiBaseUrl.replace(/\/$/, '')}/auth/logout?return_to=${returnTo}`);
    return;
  }
  localStorage.removeItem('zedataiSession');
  state.role = null; state.user = null; state.authSource = null;
  $('#app-shell').classList.add('auth-locked');
  $('#login-screen').classList.remove('hidden');
  resetChat();
}

$$('.nav-item').forEach((button) => button.addEventListener('click', () => {
  if (canUseElement(button)) switchView(button.dataset.view);
  else showToast('当前账号没有该页面权限');
}));
$$('[data-go]').forEach((button) => button.addEventListener('click', () => {
  if (canUseElement(button)) switchView(button.dataset.go);
  else showToast('当前账号没有该页面权限');
}));

$$('[data-demo-role]').forEach((button) => button.addEventListener('click', () => completeLogin(demoUsers[button.dataset.demoRole])));
$('#feishu-login').addEventListener('click', () => {
  if (state.apiBaseUrl) {
    const returnTo = encodeURIComponent(location.href.split('#')[0]);
    navigateTop(`${state.apiBaseUrl.replace(/\/$/, '')}/auth/feishu?return_to=${returnTo}`);
    return;
  }
  $('#demo-login').scrollIntoView({ behavior: 'smooth', block: 'center' });
  showToast('预览环境尚未配置企业飞书应用，请先选择演示身份');
});
$('#logout-button').addEventListener('click', logout);
$('#record-test-toggle').addEventListener('change', (event) => {
  state.recordTestConversation = event.target.checked;
  if (event.target.checked) {
    const syncedId = syncCurrentOpsTranscript();
    showToast(syncedId ? '已补录本轮测试，后续消息将持续计入分析' : '已开启：本轮测试将计入分析');
  } else {
    showToast('已停止后续记录；此前计入的内容会保留');
  }
});

function setRequestContext({ status = '等待提问', type = 'neutral', completeness = 0, facts = [], copy = '提交问题后，我会判断是否需要追问。' }) {
  const badge = $('#request-status');
  badge.textContent = status;
  badge.className = `status-pill ${type}`;
  $('#donut').style.setProperty('--value', completeness);
  $('#completeness-value').textContent = `${completeness}%`;
  $('#completeness-copy').textContent = copy;
  $('#fact-count').textContent = `${facts.length} 项`;
  $('#fact-list').innerHTML = facts.length ? facts.map((fact) => `<span class="fact-chip">${escapeHtml(fact)}</span>`).join('') : '<div class="empty-line">暂未识别</div>';
}

function appendMessage(role, html, options = {}) {
  const welcome = $('.welcome-card');
  if (welcome) welcome.remove();
  const stream = $('#chat-stream');
  const item = document.createElement('div');
  item.className = `message ${role}`;
  item.innerHTML = `
    <div class="message-avatar">${role === 'assistant' ? '✦' : '我'}</div>
    <div class="message-body">
      <div class="bubble">${html}</div>
      <div class="message-meta">${options.meta || (role === 'assistant' ? '证答台 · 刚刚' : '销售 · 刚刚')}</div>
    </div>`;
  stream.appendChild(item);
  stream.scrollTop = stream.scrollHeight;
  return item;
}

function appendTyping() {
  return appendMessage('assistant', '<span class="typing"><i></i><i></i><i></i></span>', { meta: '正在检索授权文件并校验证据…' });
}

function evidenceCard(kind, body, status = 'good', statusText = '可以回答') {
  const items = evidence[kind] || [];
  const statusIcon = status === 'good' ? '✓' : status === 'partial' ? '△' : '!';
  return `
    <div class="answer-card">
      <div class="answer-status"><span class="${status}">${statusIcon} ${statusText}</span><small>${items.length} 条直接证据 · 已检查更新时间</small></div>
      <div class="answer-content">${body}</div>
      <div class="evidence-list">
        <div class="evidence-title">引用证据</div>
        ${items.map((item) => `<div class="evidence-item"><div class="e-head"><a href="${item.url}" target="_blank" rel="noopener noreferrer" data-external-link>${item.title} ↗</a><span>更新于 ${item.updated}</span></div><blockquote>${item.quote}</blockquote></div>`).join('')}
      </div>
      <div class="answer-actions"><span></span><div><button data-copy-answer>复制答案</button><button data-feedback>有帮助</button><button data-feedback>需改进</button></div></div>
    </div>`;
}

function classifyQuestion(text) {
  const lower = text.toLowerCase();
  if (/月付|付款|账期|合同/.test(text)) return 'payment';
  if (/上线|迁移|交付|保证|一定|承诺|今天|本周/.test(text)) return 'delivery';
  if (/退款|退费|到账/.test(text)) return 'refund';
  if (/折扣|报价|优惠|审批/.test(text)) return 'discount';
  if (/截图|图片|ocr/.test(lower)) return 'discount';
  return 'unknown';
}

function answerFor(kind, text, isFollowup) {
  if (kind === 'payment') {
    if (!isFollowup && !/新签|续约|框架|客户类型|已经签|未签|制造业|互联网|华东|华北|华南/.test(text)) {
      state.stage = 'followup'; state.pendingTopic = 'payment';
      setRequestContext({ status: '需要补充', type: 'ask', completeness: 58, facts: ['诉求：按月付款', '对象：企业版合同'], copy: '还缺客户类型与合同阶段，补齐后才能判断适用流程。' });
      return { html: '我能查到“月付属于非标条件”，但现在还不能判断走哪条审批。请补充两点：<strong>这是新签还是续约？客户属于直客还是渠道客户？</strong><br><br>你不知道合同术语也没关系，直接说“有没有签字、客户是谁带来的”即可。', status: 'ask' };
    }
    setRequestContext({ status: '证据充分', type: 'good', completeness: 92, facts: ['诉求：按月付款', '场景：非标商务条件', '需审批：区域负责人 + 商务运营'], copy: '已具备流程级回答条件；最终结果仍以书面审批为准。' });
    return { html: evidenceCard('payment', '<strong>可以提出申请，但不能直接答应客户。</strong><ul><li>月付不属于企业版标准付款周期，需要走非标商务审批。</li><li>在区域负责人和商务运营书面审批前，不要把月付写入报价单、邮件或合同附件。</li><li>建议回复客户：“我可以为您发起非标付款申请，最终以审批结果和正式合同为准。”</li></ul>', 'good', '可以回答（不等于可以承诺）') };
  }
  if (kind === 'delivery') {
    if (!isFollowup && !/负责人|实施|排期|评估|书面|确认|项目计划/.test(text)) {
      state.stage = 'followup'; state.pendingTopic = 'delivery';
      setRequestContext({ status: '需要补充', type: 'ask', completeness: 46, facts: ['客户诉求：明确交付日期', '风险词：保证 / 今天'], copy: '缺少实施评估、资源锁定与书面确认。' });
      return { html: '这个问题涉及<strong>交付承诺</strong>，我先不替你下结论。请确认：实施负责人是否已经完成评估，并通过项目群、邮件或排期表<strong>书面确认</strong>具体日期？如果只有口头说“应该可以”，也请直接告诉我。' };
    }
    setRequestContext({ status: '禁止承诺', type: 'blocked', completeness: 81, facts: ['场景：交付日期', '依据：未完成书面排期', '动作：升级实施负责人'], copy: '证据可以支持风险判断，但不能支持具体日期保证。' });
    return { html: evidenceCard('delivery', '<strong>不能保证今天或某个具体日期完成。</strong><ul><li>现有文件只允许在实施评估、资源锁定和双方项目计划确认后对外确定日期。</li><li>如果尚无书面排期，建议回复：“我们会优先推进，但具体完成时间需以实施评估和书面项目计划为准。”</li><li>最接近的文件已列在下方，它们解释了流程，但<strong>不构成对本次项目日期的保证</strong>。</li></ul>', 'blocked', '不可作保证性承诺') };
  }
  if (kind === 'refund') {
    setRequestContext({ status: '部分可答', type: 'ask', completeness: 76, facts: ['地区：华东', '客户：制造业企业', '事项：退款流程'], copy: '可以说明流程；到账时点仍取决于材料与财务处理。' });
    return { html: evidenceCard('refund', '<strong>可以说明办理步骤，但不能承诺具体到账日。</strong><ul><li>先收集合同编号、付款凭证、退款原因和已有审批记录。</li><li>材料齐全后由客户成功团队发起退款流程，再进入财务审核。</li><li>这份 SOP 更新较早，系统已标记“可能过期”，建议运营确认新版本后再对外给时间口径。</li></ul>', 'partial', '部分可以回答') };
  }
  if (kind === 'discount') {
    setRequestContext({ status: '需核对原图', type: 'ask', completeness: 72, facts: ['输入：报价截图 / 折扣', '证据：OCR 识别', '限制：需核对原图'], copy: 'OCR 可用于检索，审批结论仍应回看原图与政策。' });
    return { html: evidenceCard('discount', '<strong>截图 OCR 可定位到折扣审批规则，但不能仅凭识别文本给出最终权限。</strong><ul><li>请同时确认客户规模、合同金额和折扣值。</li><li>超出区域权限时，需要提交商务运营复核。</li><li>下方第一条来自图片 OCR，已明确标为“需复核”；第二条是当前有效的商务政策。</li></ul>', 'partial', '找到相近证据，需人工核对') };
  }
  setRequestContext({ status: '证据不足', type: 'blocked', completeness: 38, facts: ['已记录原始问题'], copy: '当前授权范围未找到足以支撑结论的直接证据。' });
  return { html: `<div class="answer-card"><div class="answer-status"><span class="blocked">! 暂时不能回答</span><small>0 条直接证据</small></div><div class="answer-content"><strong>我没有在当前授权文件中找到足以支撑结论的内容，因此不做猜测。</strong><br><br>你可以补充客户所在区域、业务类型、合同阶段或相关截图；运营端也会把本次问题记录为“知识缺口”，用于补充文档。</div><div class="evidence-list"><div class="evidence-title">相近资料</div><div class="evidence-item"><div class="e-head"><a href="https://example.feishu.cn/wiki/sales-index" target="_blank" rel="noopener noreferrer" data-external-link>销售制度库目录 ↗</a><span>更新于 2026-09-15</span></div><blockquote>仅作为相近资料入口，不代表其中存在本问题的答案。</blockquote></div></div></div>` };
}

async function queryBackend(text) {
  if (!state.apiBaseUrl) return null;
  const shouldRecord = state.role === 'sales' || state.recordTestConversation;
  const response = await fetch(`${state.apiBaseUrl.replace(/\/$/, '')}/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      message: text,
      conversation_id: state.currentConversationId || 'web-demo',
      actor_role: state.role,
      record_conversation: shouldRecord,
      test_mode: state.role === 'ops',
      attachments: state.attachments.map((f) => ({ name: f.name, type: f.type })),
    }),
  });
  if (!response.ok) throw new Error(`接口返回 ${response.status}`);
  return response.json();
}

async function sendMessage(text = $('#message-input').value.trim()) {
  if (!text && !state.attachments.length) return;
  if (!state.role) return;
  const shouldRecord = state.role === 'sales' || state.recordTestConversation;
  const attachmentText = state.attachments.length ? `<div style="font-size:9px;opacity:.78;margin-bottom:5px">附件：${state.attachments.map((f) => escapeHtml(f.name)).join('、')}</div>` : '';
  appendMessage('user', `${attachmentText}${escapeHtml(text || '请识别附件并查询相关规则')}`, { meta: state.role === 'ops' ? `运营测试 · ${shouldRecord ? '计入分析' : '不记录'}` : '销售 · 已记录' });
  $('#message-input').value = '';
  $('#message-input').style.height = '35px';
  const userText = text || '请识别附件并查询相关规则';
  const userMessageAt = new Date().toISOString();
  state.currentTranscript.push({ role: 'user', text: userText, at: userMessageAt });
  const previousStage = state.stage;
  const currentTopic = previousStage === 'followup' ? state.pendingTopic : classifyQuestion(text);
  state.currentTopic = currentTopic;
  const localRecordId = state.role === 'sales' ? persistUserMessage(userText, currentTopic) : null;
  if (state.role === 'ops' && shouldRecord) syncCurrentOpsTranscript(currentTopic);
  const typing = appendTyping();
  try {
    let payload = await queryBackend(text);
    if (!payload) {
      await new Promise((resolve) => setTimeout(resolve, 720));
      payload = answerFor(currentTopic, text, previousStage === 'followup');
    } else {
      setRequestContext(payload.context || {});
      payload.html = payload.html || escapeHtml(payload.answer || '接口已返回，但没有 answer 字段。');
    }
    typing.remove();
    const baseMeta = state.apiBaseUrl ? '证答台 · 真实接口' : '证答台 · 演示检索';
    const recordResponse = state.role === 'sales' || state.recordTestConversation;
    const assistantMessage = appendMessage('assistant', payload.html, { meta: state.role === 'ops' ? `${baseMeta} · ${recordResponse ? '计入分析' : '测试不留痕'}` : baseMeta });
    if (state.role === 'ops') {
      attachEvaluationFeedback(assistantMessage, {
        question: userText,
        answer: htmlToPlainText(payload.html),
        answerState: payload.answer_state || payload.status || null,
        risk: payload.risk?.level || riskForText(userText),
      });
    }
    state.currentTranscript.push({ role: 'assistant', text: htmlToPlainText(payload.html), at: new Date().toISOString() });
    if (state.role === 'sales') persistAssistantMessage(localRecordId, payload.html);
    else if (state.recordTestConversation) syncCurrentOpsTranscript(currentTopic);
    if (previousStage === 'followup') { state.stage = 'answered'; state.pendingTopic = null; }
    state.attachments = [];
    renderAttachments();
  } catch (error) {
    typing.remove();
    const errorHtml = `<strong>暂时无法连接后端。</strong><br>错误：${escapeHtml(error.message)}。你可以在“接入配置”中检查 API 地址，或清空地址切回演示模式。`;
    appendMessage('assistant', errorHtml);
    state.currentTranscript.push({ role: 'assistant', text: htmlToPlainText(errorHtml), at: new Date().toISOString() });
    if (state.role === 'ops' && state.recordTestConversation) syncCurrentOpsTranscript(currentTopic);
    setRequestContext({ status: '连接失败', type: 'blocked', completeness: 0, facts: ['接口连接失败'], copy: '未生成业务结论。' });
  }
}

$('#send-button').addEventListener('click', () => sendMessage());
$('#message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
});
$('#message-input').addEventListener('input', (event) => {
  event.target.style.height = '35px';
  event.target.style.height = `${Math.min(event.target.scrollHeight, 110)}px`;
});
$$('[data-prompt]').forEach((button) => button.addEventListener('click', () => sendMessage(button.dataset.prompt)));

function resetChat() {
  state.stage = 'idle'; state.pendingTopic = null; state.attachments = []; state.currentConversationId = null; state.currentTranscript = []; state.currentTopic = null;
  $('#chat-stream').innerHTML = `<div class="welcome-card"><div class="assistant-orb">✦</div><h3>把客户现场的情况直接告诉我</h3><p>不需要记住文档字段。我会先补齐必要信息，再依据已授权文件回答，并标出原文、链接和更新时间。</p><div class="prompt-grid"><button class="prompt-card" data-prompt="客户想把企业版合同改成按月付款，可以答应吗？"><span class="prompt-icon blue">合</span><span><strong>合同与付款</strong><small>客户想改成按月付款，可以答应吗？</small></span></button><button class="prompt-card" data-prompt="客户问数据能不能保证今天完成迁移，我应该怎么回复？"><span class="prompt-icon orange">险</span><span><strong>承诺风险</strong><small>能否保证今天完成数据迁移？</small></span></button><button class="prompt-card" data-prompt="客户是华东区制造业新签企业，退款流程怎么走？"><span class="prompt-icon green">流</span><span><strong>流程查询</strong><small>新签企业的退款流程怎么走？</small></span></button><button class="prompt-card" data-prompt="这张报价截图里的折扣审批到哪一级？"><span class="prompt-icon purple">图</span><span><strong>图片识别</strong><small>识别截图后查询折扣审批规则</small></span></button></div></div>`;
  $$('[data-prompt]', $('#chat-stream')).forEach((button) => button.addEventListener('click', () => sendMessage(button.dataset.prompt)));
  setRequestContext({});
  renderAttachments();
}
$('#clear-chat').addEventListener('click', resetChat);
$('#new-chat').addEventListener('click', () => { resetChat(); showToast('已创建新对话'); });

function renderAttachments() {
  $('#attachment-preview').innerHTML = state.attachments.map((file, index) => `<span class="attachment-chip">${file.type.startsWith('image/') ? '图片 OCR' : '文件'} · ${escapeHtml(file.name)}<button data-remove-file="${index}">×</button></span>`).join('');
}
$('#file-input').addEventListener('change', (event) => {
  state.attachments.push(...event.target.files);
  renderAttachments();
  if (state.attachments.some((file) => file.type.startsWith('image/'))) showToast('图片已加入；生产环境将由后端 OCR 识别');
  event.target.value = '';
});
$('#attachment-preview').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-file]');
  if (!button) return;
  state.attachments.splice(Number(button.dataset.removeFile), 1);
  renderAttachments();
});

document.addEventListener('click', (event) => {
  const externalLink = event.target.closest('a[data-external-link], .evidence-item a[href^="http"], #drawer-evidence-link');
  if (externalLink) {
    event.preventDefault();
    openExternalDocument(externalLink.href);
    return;
  }
  if (event.target.closest('[data-copy-answer]')) {
    const content = event.target.closest('.answer-card').innerText;
    navigator.clipboard?.writeText(content); showToast('答案与证据已复制');
  }
  const answerFeedback = event.target.closest('[data-feedback]');
  if (answerFeedback) {
    if (state.role === 'sales') openFeedbackModal('conversation', answerFeedback.textContent.includes('有帮助') ? 5 : 0);
    else showToast('运营测试反馈请使用回答下方的评测标注');
  }
});

function defaultFeedbackItems() {
  return [
    { feedback_id: 'feedback_seed_001', scope: 'conversation', category: 'answer_quality', rating: 2, content: '回答说明了流程，但我希望直接告诉我下一步找谁审批。', conversation_id: 'seed_refund', conversation_excerpt: '华东制造业客户退款流程怎么走？', status: 'pending', created_by: { name: '销售演示', department: '演示销售组', role: 'sales' }, created_at: '2026-09-18T15:20:00+08:00', updated_at: '2026-09-18T15:20:00+08:00', response_note: null },
    { feedback_id: 'feedback_seed_002', scope: 'platform', category: 'experience', rating: 4, content: '希望移动端也能快速查看最近使用过的证据文件。', conversation_id: null, conversation_excerpt: null, status: 'in_progress', created_by: { name: '陈雨', department: '大客户部', role: 'sales' }, created_at: '2026-09-18T16:10:00+08:00', updated_at: '2026-09-18T16:10:00+08:00', response_note: '已进入体验优化清单' },
  ];
}

function loadFeedbackItems() {
  let stored = [];
  try { stored = JSON.parse(localStorage.getItem(FEEDBACK_KEY) || '[]'); } catch (_) { /* no-op */ }
  const merged = new Map(defaultFeedbackItems().map((item) => [item.feedback_id, item]));
  if (Array.isArray(stored)) stored.forEach((item) => merged.set(item.feedback_id, item));
  return [...merged.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function saveFeedbackItem(item) {
  let stored = [];
  try { stored = JSON.parse(localStorage.getItem(FEEDBACK_KEY) || '[]'); } catch (_) { /* no-op */ }
  const next = [item, ...(Array.isArray(stored) ? stored.filter((existing) => existing.feedback_id !== item.feedback_id) : [])];
  localStorage.setItem(FEEDBACK_KEY, JSON.stringify(next.slice(0, 200)));
}

function closeFeedbackModal() {
  $('#feedback-modal').classList.remove('open');
  $('#feedback-modal').setAttribute('aria-hidden', 'true');
  $('#feedback-modal-backdrop').classList.remove('open');
}

function openFeedbackModal(scope, presetRating = 0) {
  if (state.role !== 'sales') return;
  if (scope === 'conversation' && !state.currentTranscript.some((message) => message.role === 'user')) {
    showToast('请先完成至少一轮问答，再提交对话反馈');
    return;
  }
  state.feedbackScope = scope;
  state.feedbackRating = presetRating;
  $('#feedback-modal-title').textContent = scope === 'conversation' ? '反馈当前对话' : '反馈整个平台';
  $('#feedback-modal-eyebrow').textContent = scope === 'conversation' ? '对话反馈' : '平台反馈';
  $('#feedback-category').value = scope === 'conversation' ? 'answer_quality' : 'experience';
  $('#feedback-content').value = '';
  const context = $('#feedback-context');
  context.hidden = scope !== 'conversation';
  const latestQuestion = [...state.currentTranscript].reverse().find((message) => message.role === 'user')?.text || '';
  $('#feedback-conversation-excerpt').textContent = latestQuestion;
  $$('#feedback-modal [data-feedback-rating]').forEach((button) => button.classList.toggle('selected', Number(button.dataset.feedbackRating) === presetRating));
  $('#feedback-rating-copy').textContent = presetRating ? `已选择 ${presetRating} 分` : '请选择 1–5 分';
  $('#feedback-modal-backdrop').classList.add('open');
  $('#feedback-modal').classList.add('open');
  $('#feedback-modal').setAttribute('aria-hidden', 'false');
}

$('#platform-feedback').addEventListener('click', () => openFeedbackModal('platform'));
$('#conversation-feedback').addEventListener('click', () => openFeedbackModal('conversation'));
$('#close-feedback-modal').addEventListener('click', closeFeedbackModal);
$('#cancel-feedback').addEventListener('click', closeFeedbackModal);
$('#feedback-modal-backdrop').addEventListener('click', closeFeedbackModal);
$$('#feedback-modal [data-feedback-rating]').forEach((button) => button.addEventListener('click', () => {
  state.feedbackRating = Number(button.dataset.feedbackRating);
  $$('#feedback-modal [data-feedback-rating]').forEach((item) => item.classList.toggle('selected', item === button));
  $('#feedback-rating-copy').textContent = `已选择 ${state.feedbackRating} 分`;
}));

$('#submit-feedback').addEventListener('click', async (event) => {
  const content = $('#feedback-content').value.trim();
  if (!state.feedbackRating) { showToast('请先选择 1–5 分'); return; }
  if (!content) { showToast('请填写具体反馈'); return; }
  const latestQuestion = [...state.currentTranscript].reverse().find((message) => message.role === 'user')?.text || null;
  const item = {
    feedback_id: `local_feedback_${Date.now()}`,
    scope: state.feedbackScope,
    category: $('#feedback-category').value,
    rating: state.feedbackRating,
    content,
    conversation_id: state.feedbackScope === 'conversation' ? (state.currentConversationId || 'web-demo-local') : null,
    conversation_excerpt: state.feedbackScope === 'conversation' ? latestQuestion : null,
    status: 'pending',
    created_by: { name: state.user.name, department: state.user.department, role: state.role },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), response_note: null,
  };
  const button = event.currentTarget;
  button.disabled = true; button.textContent = '提交中…';
  let saved = item;
  if (state.apiBaseUrl && state.authSource === 'feishu') {
    try {
      const response = await fetch(`${state.apiBaseUrl.replace(/\/$/, '')}/feedback`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      saved = await response.json();
    } catch (error) {
      showToast(`服务端暂不可用，反馈已保存在本机：${error.message}`);
    }
  }
  saveFeedbackItem(saved);
  closeFeedbackModal();
  button.disabled = false; button.textContent = '提交给运营';
  showToast('反馈已提交给运营');
});

function feedbackScopeLabel(scope) { return scope === 'conversation' ? '对话反馈' : '平台反馈'; }
function feedbackStatusLabel(status) { return { pending: '待处理', in_progress: '处理中', resolved: '已完成' }[status] || status; }

function renderFeedbackRows(items) {
  $('#feedback-inbox-rows').innerHTML = items.length ? items.map((item) => `
    <tr>
      <td><strong>${escapeHtml(item.created_by.name)}</strong><small>${escapeHtml(item.created_by.department)} · ${formatRecordTime(item.created_at)}</small></td>
      <td><span class="feedback-scope ${item.scope}">${feedbackScopeLabel(item.scope)}</span></td>
      <td>${escapeHtml(item.content)}</td>
      <td><span class="feedback-score">${item.rating} / 5</span></td>
      <td><span class="feedback-status ${item.status}">${feedbackStatusLabel(item.status)}</span></td>
      <td><button class="row-arrow" data-open-feedback="${escapeHtml(item.feedback_id)}">›</button></td>
    </tr>`).join('') : '<tr><td colspan="6"><div class="empty-line">当前筛选下没有反馈</div></td></tr>';
}

function applyFeedbackInbox(items) {
  state.feedbackItems = items;
  const filtered = items.filter((item) => state.feedbackFilter === 'all' || item.scope === state.feedbackFilter);
  renderFeedbackRows(filtered);
  $('#feedback-pending-count').textContent = items.filter((item) => item.status === 'pending').length;
  $('#feedback-average-rating').textContent = items.length ? (items.reduce((sum, item) => sum + item.rating, 0) / items.length).toFixed(1) : '0.0';
  const badge = $('.nav-item[data-view="ops"] .nav-badge');
  if (badge) badge.textContent = items.filter((item) => item.status === 'pending').length;
}

async function renderFeedbackInbox() {
  applyFeedbackInbox(loadFeedbackItems());
  if (!state.apiBaseUrl || state.authSource !== 'feishu') return;
  try {
    const response = await fetch(`${state.apiBaseUrl.replace(/\/$/, '')}/ops/feedback`, { credentials: 'include' });
    if (response.ok) applyFeedbackInbox((await response.json()).items);
  } catch (_) { /* local inbox remains visible */ }
}

$$('[data-feedback-filter]').forEach((button) => button.addEventListener('click', () => {
  state.feedbackFilter = button.dataset.feedbackFilter;
  $$('[data-feedback-filter]').forEach((item) => item.classList.toggle('active', item === button));
  applyFeedbackInbox(state.feedbackItems);
}));

function closeFeedbackDetail() {
  $('#feedback-detail-drawer').classList.remove('open');
  $('#feedback-detail-drawer').setAttribute('aria-hidden', 'true');
  $('#feedback-detail-backdrop').classList.remove('open');
}

function openFeedbackDetail(feedbackId) {
  const item = state.feedbackItems.find((feedback) => feedback.feedback_id === feedbackId);
  if (!item) return;
  state.selectedFeedbackId = feedbackId;
  const status = $('#feedback-detail-status');
  status.textContent = feedbackStatusLabel(item.status);
  status.className = `status-pill ${item.status === 'resolved' ? 'good' : item.status === 'in_progress' ? 'ask' : 'neutral'}`;
  $('#feedback-detail-copy').innerHTML = `<small>${escapeHtml(item.created_by.name)} · ${escapeHtml(item.created_by.department)} · ${item.rating}/5 分</small>${escapeHtml(item.content)}`;
  $('#feedback-detail-context').textContent = item.scope === 'conversation' ? (item.conversation_excerpt || `对话 ${item.conversation_id}`) : '平台反馈，无关联对话';
  $('#feedback-response-note').value = item.response_note || '';
  $('#feedback-detail-backdrop').classList.add('open');
  $('#feedback-detail-drawer').classList.add('open');
  $('#feedback-detail-drawer').setAttribute('aria-hidden', 'false');
}

$('#feedback-inbox-rows').addEventListener('click', (event) => {
  const button = event.target.closest('[data-open-feedback]');
  if (button) openFeedbackDetail(button.dataset.openFeedback);
});
$('#close-feedback-detail').addEventListener('click', closeFeedbackDetail);
$('#feedback-detail-backdrop').addEventListener('click', closeFeedbackDetail);

async function updateSelectedFeedback(status) {
  const item = state.feedbackItems.find((feedback) => feedback.feedback_id === state.selectedFeedbackId);
  if (!item) return;
  item.status = status;
  item.response_note = $('#feedback-response-note').value.trim();
  item.updated_at = new Date().toISOString();
  saveFeedbackItem(item);
  if (state.apiBaseUrl && state.authSource === 'feishu' && !item.feedback_id.startsWith('local_')) {
    try {
      const response = await fetch(`${state.apiBaseUrl.replace(/\/$/, '')}/ops/feedback/${encodeURIComponent(item.feedback_id)}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, response_note: item.response_note }) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) { showToast(`服务端更新失败，已保留本机状态：${error.message}`); }
  }
  closeFeedbackDetail();
  renderFeedbackInbox();
  showToast(status === 'resolved' ? '反馈已完成处理' : '反馈已标记为处理中');
}

$('#mark-feedback-progress').addEventListener('click', () => updateSelectedFeedback('in_progress'));
$('#resolve-feedback').addEventListener('click', () => updateSelectedFeedback('resolved'));

function defaultEvaluationExamples() {
  return [
    { example_id: 'eval_delivery_001', question: '客户要求保证本周五上线，可以写进合同吗？', rating: 'correct', error_types: [], reviewed: true },
    { example_id: 'eval_payment_001', question: '企业版客户想按月付款，可以答应吗？', rating: 'partial', error_types: ['追问不足'], reviewed: true },
    { example_id: 'eval_refund_001', question: '退款材料交齐后几天到账？', rating: 'incorrect', error_types: ['错误承诺', '引用缺失'], reviewed: false },
  ];
}

function loadEvaluationExamples() {
  try {
    const stored = JSON.parse(localStorage.getItem(EVALS_KEY) || '[]');
    return [...(Array.isArray(stored) ? stored : []), ...defaultEvaluationExamples()];
  } catch (_) {
    return defaultEvaluationExamples();
  }
}

function saveEvaluationExample(example) {
  let stored = [];
  try { stored = JSON.parse(localStorage.getItem(EVALS_KEY) || '[]'); } catch (_) { /* no-op */ }
  localStorage.setItem(EVALS_KEY, JSON.stringify([example, ...(Array.isArray(stored) ? stored : [])].slice(0, 200)));
}

function attachEvaluationFeedback(messageElement, context) {
  const body = $('.message-body', messageElement);
  if (!body) return;
  const panel = document.createElement('div');
  panel.className = 'evaluation-feedback';
  panel.innerHTML = `
    <div><strong>将本次回答加入评测集</strong><div class="feedback-actions"><button data-eval-rating="correct">正确</button><button data-eval-rating="partial">部分正确</button><button data-eval-rating="incorrect">错误</button></div></div>
    <div class="feedback-details">
      <div class="feedback-error-types">
        <label><input type="checkbox" value="检索错误">检索错误</label><label><input type="checkbox" value="引用错误">引用错误</label>
        <label><input type="checkbox" value="风险漏判">风险漏判</label><label><input type="checkbox" value="错误承诺">错误承诺</label><label><input type="checkbox" value="表达问题">表达问题</label>
      </div>
      <textarea placeholder="填写正确答案或具体修改建议；补齐后样本才可进入正式评测"></textarea>
      <button data-submit-eval>保存候选样本</button>
    </div>`;
  body.appendChild(panel);
  evaluationContextByNode.set(panel, context);
}

async function postEvaluationExample(panel, rating) {
  const context = evaluationContextByNode.get(panel);
  if (!context) return;
  const expectedAnswer = $('textarea', panel)?.value.trim() || '';
  const errorTypes = $$('input[type="checkbox"]:checked', panel).map((input) => input.value);
  const example = {
    example_id: `local_eval_${Date.now()}`,
    question: context.question,
    model_answer: context.answer,
    expected_answer: expectedAnswer,
    expected_state: context.answerState,
    expected_risk: context.risk,
    rating,
    error_types: errorTypes,
    reviewed: rating === 'correct' || Boolean(expectedAnswer),
    source: '运营测试',
    created_at: new Date().toISOString(),
  };
  saveEvaluationExample(example);
  let remoteSaved = false;
  if (state.apiBaseUrl && state.authSource === 'feishu') {
    try {
      const response = await fetch(`${state.apiBaseUrl.replace(/\/$/, '')}/evals/examples`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(example),
      });
      remoteSaved = response.ok;
    } catch (_) { /* local candidate remains available */ }
  }
  panel.innerHTML = `<div><strong>✓ 已保存${remoteSaved ? '到评测数据集' : '为本机候选样本'}</strong><span class="review-state ${example.reviewed ? 'ready' : ''}">${example.reviewed ? '可进入评测' : '等待补充正确答案'}</span></div>`;
  showToast(example.reviewed ? '样本已保存，可在“评测与优化”中查看' : '候选样本已保存，补充正确答案后才能评测');
}

document.addEventListener('click', (event) => {
  const ratingButton = event.target.closest('[data-eval-rating]');
  if (ratingButton) {
    const panel = ratingButton.closest('.evaluation-feedback');
    $$('.feedback-actions button', panel).forEach((button) => button.classList.toggle('selected', button === ratingButton));
    panel.dataset.rating = ratingButton.dataset.evalRating;
    const details = $('.feedback-details', panel);
    if (ratingButton.dataset.evalRating === 'correct') postEvaluationExample(panel, 'correct');
    else details.classList.add('open');
    return;
  }
  const submit = event.target.closest('[data-submit-eval]');
  if (submit) {
    const panel = submit.closest('.evaluation-feedback');
    postEvaluationExample(panel, panel.dataset.rating || 'partial');
  }
});

function ratingLabel(rating) {
  return { correct: '正确', partial: '部分正确', incorrect: '错误' }[rating] || '待评价';
}

function renderEvaluationExamples(examples) {
  $('#eval-example-rows').innerHTML = examples.slice(0, 12).map((item) => `
    <tr>
      <td>${escapeHtml(item.question)}</td>
      <td><span class="eval-rating ${escapeHtml(item.rating)}">${ratingLabel(item.rating)}</span></td>
      <td><div class="eval-error-tags">${item.error_types?.length ? item.error_types.map((type) => `<span>${escapeHtml(type)}</span>`).join('') : '<span>无</span>'}</div></td>
      <td><span class="review-state ${item.reviewed ? 'ready' : ''}">${item.reviewed ? '已审核' : '待审核'}</span></td>
    </tr>`).join('');
}

function updateEvaluationSummary(summary) {
  const run = summary.latest_run;
  $('#eval-total').textContent = summary.total_examples;
  $('#eval-reviewed').textContent = summary.reviewed_examples;
  $('#eval-pending-copy').textContent = `${summary.pending_examples} 条待审核`;
  if (!run) return;
  state.lastEvalRunId = run.run_id === 'baseline_demo' ? null : run.run_id;
  $('#baseline-version').textContent = run.baseline.version;
  $('#candidate-version').textContent = run.candidate.version;
  const percent = (value) => `${Math.round(value * 100)}%`;
  $('#baseline-citation').textContent = percent(run.baseline.citation_accuracy);
  $('#candidate-citation').textContent = percent(run.candidate.citation_accuracy);
  $('#eval-citation').textContent = percent(run.candidate.citation_accuracy);
  $('#baseline-risk').textContent = percent(run.baseline.risk_recall);
  $('#candidate-risk').textContent = percent(run.candidate.risk_recall);
  $('#eval-risk').textContent = percent(run.candidate.risk_recall);
  $('#baseline-refusal').textContent = percent(run.baseline.refusal_precision);
  $('#candidate-refusal').textContent = percent(run.candidate.refusal_precision);
  $('#baseline-latency').textContent = `${(run.baseline.average_latency_ms / 1000).toFixed(2)}s`;
  $('#candidate-latency').textContent = `${(run.candidate.average_latency_ms / 1000).toFixed(2)}s`;
}

function applyModelConfig(config) {
  if (!config) return;
  $('#model-id').value = config.model_id || 'glm-5.1';
  $('#model-temperature').value = config.temperature ?? 0.1;
  $('#prompt-version').value = config.prompt_version || 'sales-evidence-v1';
  $('#retrieval-version').value = config.retrieval_version || 'hybrid-search-v1';
  $('#model-key-status').textContent = config.api_key_configured ? 'API Key：服务端已配置' : 'API Key：仅服务端可见 / 尚未验证';
}

async function renderEvaluationWorkspace() {
  const localExamples = loadEvaluationExamples();
  renderEvaluationExamples(localExamples);
  updateEvaluationSummary({
    total_examples: localExamples.length,
    reviewed_examples: localExamples.filter((item) => item.reviewed).length,
    pending_examples: localExamples.filter((item) => !item.reviewed).length,
    latest_run: {
      run_id: 'baseline_demo', baseline: { version: 'sales-evidence-v1', citation_accuracy: .82, risk_recall: .86, refusal_precision: .79, average_latency_ms: 1680 },
      candidate: { version: 'sales-evidence-v2-candidate', citation_accuracy: .91, risk_recall: .94, refusal_precision: .88, average_latency_ms: 1540 },
    },
  });
  try { applyModelConfig(JSON.parse(localStorage.getItem(MODEL_CONFIG_KEY) || 'null')); } catch (_) { /* no-op */ }
  if (!state.apiBaseUrl || state.authSource !== 'feishu') return;
  try {
    const base = state.apiBaseUrl.replace(/\/$/, '');
    const [summaryResponse, examplesResponse, configResponse] = await Promise.all([
      fetch(`${base}/evals/summary`, { credentials: 'include' }),
      fetch(`${base}/evals/examples`, { credentials: 'include' }),
      fetch(`${base}/model/config`, { credentials: 'include' }),
    ]);
    if (summaryResponse.ok) updateEvaluationSummary(await summaryResponse.json());
    if (examplesResponse.ok) renderEvaluationExamples((await examplesResponse.json()).items);
    if (configResponse.ok) applyModelConfig(await configResponse.json());
  } catch (_) {
    showToast('评测服务暂不可用，当前展示本机演示数据');
  }
}

$('#run-evaluation').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true; button.textContent = '评测中…';
  try {
    let run;
    if (state.apiBaseUrl && state.authSource === 'feishu') {
      const response = await fetch(`${state.apiBaseUrl.replace(/\/$/, '')}/evals/runs`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidate_version: $('#prompt-version').value.trim() || 'candidate' }) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      run = await response.json();
    } else {
      run = { run_id: `local_run_${Date.now()}`, baseline: { version: 'sales-evidence-v1', citation_accuracy: .82, risk_recall: .86, refusal_precision: .79, average_latency_ms: 1680 }, candidate: { version: $('#prompt-version').value.trim() || 'sales-evidence-v2-candidate', citation_accuracy: .91, risk_recall: .94, refusal_precision: .88, average_latency_ms: 1540 } };
    }
    updateEvaluationSummary({ total_examples: loadEvaluationExamples().length, reviewed_examples: loadEvaluationExamples().filter((item) => item.reviewed).length, pending_examples: loadEvaluationExamples().filter((item) => !item.reviewed).length, latest_run: run });
    $('#eval-run-status').textContent = '刚刚完成';
    showToast('候选版本评测完成，结果已更新');
  } catch (error) { showToast(`评测失败：${error.message}`); }
  finally { button.disabled = false; button.textContent = '运行候选评测'; }
});

$('#export-eval-dataset').addEventListener('click', async () => {
  const count = loadEvaluationExamples().filter((item) => item.reviewed && (item.expected_answer || item.rating === 'correct')).length;
  if (state.apiBaseUrl && state.authSource === 'feishu') {
    try {
      const response = await fetch(`${state.apiBaseUrl.replace(/\/$/, '')}/evals/export`, { method: 'POST', credentials: 'include' });
      if (response.ok) { const data = await response.json(); showToast(`已生成 ${data.example_count} 条 JSONL 训练候选记录`); return; }
    } catch (_) { /* use local result */ }
  }
  showToast(`已整理 ${count} 条本机训练候选；正式提交前仍需人工复核`);
});

$('#save-model-config').addEventListener('click', async () => {
  const config = { model_id: $('#model-id').value.trim(), temperature: Number($('#model-temperature').value), prompt_version: $('#prompt-version').value.trim(), retrieval_version: $('#retrieval-version').value.trim() };
  localStorage.setItem(MODEL_CONFIG_KEY, JSON.stringify(config));
  if (state.apiBaseUrl && state.authSource === 'feishu') {
    try {
      const response = await fetch(`${state.apiBaseUrl.replace(/\/$/, '')}/model/config`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      applyModelConfig(await response.json());
      showToast('候选模型配置已保存到服务端');
      return;
    } catch (error) { showToast(`服务端保存失败，已保留本机草稿：${error.message}`); return; }
  }
  showToast('候选模型配置已保存为本机草稿');
});

$('#release-candidate').addEventListener('click', async () => {
  if (!state.lastEvalRunId || !state.apiBaseUrl || state.authSource !== 'feishu') {
    showToast('演示灰度已记录；生产发布需要登录后完成一次服务端评测');
    return;
  }
  try {
    const response = await fetch(`${state.apiBaseUrl.replace(/\/$/, '')}/evals/releases`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: state.lastEvalRunId, mode: 'canary' }) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    $('#eval-run-status').textContent = '灰度中';
    showToast('候选版本已向运营测试账号灰度发布');
  } catch (error) { showToast(`发布失败：${error.message}`); }
});

// 运营侧交互
const defaultConversationRows = $('#conversation-rows').innerHTML;
const defaultDrawer = {
  risk: 'high',
  raw: '<p><span>销售</span>客户一定要求我们承诺本周五上线，我能直接写进合同吗？对方说不写就不签。</p><p><span>助手</span>目前缺少实施评估与资源锁定结果。请问实施负责人是否已书面确认排期？</p><p><span>销售</span>还没有，只是口头说“应该可以”。</p>',
  title: '存在不可逆承诺风险',
  copy: '“应该可以”不构成可写入合同的交付证据。建议升级实施负责人和法务确认，未取得书面排期前不承诺具体日期。',
  tags: ['交付承诺', '合同条款', '高风险', '需人工确认'],
  evidence: '《实施交付 SLA v3.2》· 更新于 2026-09-16 ↗',
  evidenceUrl: 'https://example.feishu.cn/file/delivery-sla',
};

function formatRecordTime(iso) {
  const date = new Date(iso);
  const age = Date.now() - date.getTime();
  if (age < 60000) return '刚刚';
  if (age < 3600000) return `${Math.floor(age / 60000)} 分钟前`;
  if (new Date().toDateString() === date.toDateString()) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function riskLabel(risk) {
  return risk === 'high' ? '高风险' : risk === 'medium' ? '中风险' : '低风险';
}

function statusLabel(status) {
  return status === 'done' ? '已解决' : status === 'progress' ? '处理中' : '待确认';
}

function renderOpsData() {
  const records = loadConversationRecords();
  const rows = records.map((record) => `
    <tr class="synced-row" data-record-id="${escapeHtml(record.id)}">
      <td><strong>${formatRecordTime(record.updatedAt)}</strong><small>${escapeHtml(record.actorName)} · ${escapeHtml(record.department)}${record.actorRole === 'ops' ? ' · 测试' : ''}</small></td>
      <td><span class="question-cell">${escapeHtml(record.question)}</span></td>
      <td><span class="tag">${escapeHtml(record.category)}</span><span class="new-record">新增</span></td>
      <td><span class="risk ${record.risk}">${riskLabel(record.risk)}</span></td>
      <td><span class="state ${record.status}">${statusLabel(record.status)}</span></td>
      <td><button class="row-arrow">›</button></td>
    </tr>`).join('');
  $('#conversation-rows').innerHTML = rows + defaultConversationRows;

  const highCount = records.filter((record) => record.risk === 'high').length;
  const unanswered = records.filter((record) => record.category === topicLabels.unknown).length;
  $('#metric-total').textContent = (1284 + records.length).toLocaleString('zh-CN');
  $('#metric-total-copy').textContent = records.length ? `已同步 ${records.length} 条本机新对话` : '等待新对话同步';
  $('#metric-risk').textContent = (37 + highCount).toLocaleString('zh-CN');
  $('#metric-risk-copy').textContent = `其中 ${8 + highCount} 条为高风险`;
  $('#metric-unanswered').textContent = (64 + unanswered).toLocaleString('zh-CN');
  $('#ops-sync-status').innerHTML = `<i></i>${records.length ? `已同步 ${records.length} 条` : '当前设备已同步'}`;
  $('#ops-sync-copy').textContent = records.length
    ? `销售新对话已置顶；共收到 ${records.length} 条本机演示记录，点击可查看原文及 AI 判断`
    : '按风险与知识缺口排序，点击可查看原文及 AI 判断';
}

function populateDrawer(record) {
  const data = record || defaultDrawer;
  const risk = record ? record.risk : data.risk;
  $('#drawer-risk').className = `risk ${risk}`;
  $('#drawer-risk').textContent = riskLabel(risk);
  $('#drawer-raw-chat').innerHTML = record
    ? record.messages.map((message) => `<p><span>${message.role === 'assistant' ? '助手' : record.actorRole === 'ops' ? '运营' : '销售'}</span>${escapeHtml(message.text)}</p>`).join('')
    : data.raw;
  $('#drawer-analysis').className = `analysis-box ${risk === 'high' ? 'danger' : ''}`;
  $('#drawer-analysis-title').textContent = record
    ? (risk === 'high' ? '存在保证性承诺风险' : record.category === topicLabels.unknown ? '识别到知识缺口' : '已完成自动归类')
    : data.title;
  $('#drawer-analysis-copy').textContent = record ? (record.analysis || 'AI 正在等待完整回答后生成判断。') : data.copy;
  const tags = record ? [record.category, riskLabel(risk), record.source, statusLabel(record.status)] : data.tags;
  $('#drawer-tags').innerHTML = tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('');
  const link = $('#drawer-evidence-link');
  link.href = record ? record.evidenceUrl : data.evidenceUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = record ? `《${record.evidenceTitle}》· 更新于 ${record.evidenceUpdated} ↗` : data.evidence;
}

$$('.range-switch button').forEach((button) => button.addEventListener('click', () => { $$('.range-switch button').forEach((b) => b.classList.remove('active')); button.classList.add('active'); showToast(`已切换到${button.textContent}视图（演示）`); }));
function openDrawer() { $('#drawer-backdrop').classList.add('open'); $('#case-drawer').classList.add('open'); $('#case-drawer').setAttribute('aria-hidden', 'false'); }
function closeDrawer() { $('#drawer-backdrop').classList.remove('open'); $('#case-drawer').classList.remove('open'); $('#case-drawer').setAttribute('aria-hidden', 'true'); }
$('#conversation-rows').addEventListener('click', (event) => {
  const row = event.target.closest('tr');
  if (!row) return;
  state.selectedRecordId = row.dataset.recordId || null;
  const record = state.selectedRecordId ? loadConversationRecords().find((item) => item.id === state.selectedRecordId) : null;
  populateDrawer(record);
  openDrawer();
});
$('#close-drawer').addEventListener('click', closeDrawer); $('#drawer-backdrop').addEventListener('click', closeDrawer);
$('#mark-handled').addEventListener('click', () => {
  if (state.selectedRecordId) {
    const records = loadConversationRecords();
    const record = records.find((item) => item.id === state.selectedRecordId);
    if (record) { record.status = 'done'; saveConversationRecords(records); }
  }
  closeDrawer(); showToast('已标记为已处理');
});
$('#mark-noissue').addEventListener('click', () => {
  if (state.selectedRecordId) {
    const records = loadConversationRecords();
    const record = records.find((item) => item.id === state.selectedRecordId);
    if (record) { record.status = 'done'; record.risk = 'low'; record.analysis = '运营已标记为误报，将用于后续分类规则优化。'; saveConversationRecords(records); }
  }
  closeDrawer(); showToast('已记录为误报，供分类规则优化');
});
window.addEventListener('storage', (event) => { if (event.key === RECORDS_KEY && state.view === 'ops') renderOpsData(); });

// 知识源交互
$('#doc-search').addEventListener('input', (event) => {
  const query = event.target.value.trim().toLowerCase();
  $$('.doc-row').forEach((row) => row.classList.toggle('hidden', !row.dataset.search.toLowerCase().includes(query)));
});
$('#sync-button').addEventListener('click', (event) => {
  const button = event.currentTarget; button.disabled = true; button.textContent = '同步中…';
  setTimeout(() => { button.disabled = false; button.textContent = '↻ 立即同步'; showToast('演示同步完成：0 个变更'); }, 900);
});
$('#knowledge-upload').addEventListener('change', (event) => {
  const files = [...event.target.files];
  if (!files.length) return;
  const list = $('#doc-list');
  files.forEach((file) => {
    const row = document.createElement('div'); row.className = 'doc-row'; row.dataset.search = file.name;
    row.innerHTML = `<span class="doc-icon ${file.type.startsWith('image/') ? 'img' : 'word'}">${file.type.startsWith('image/') ? 'IMG' : 'NEW'}</span><div class="doc-main"><strong>${escapeHtml(file.name)}</strong><small>待上传 · ${Math.max(1, Math.round(file.size / 1024))} KB</small></div><div class="doc-scope"><span>待分类</span></div><div class="doc-update"><strong>刚刚</strong><small>加入队列</small></div><span class="index-status warn">待接入后端</span><button class="more-button">•••</button>`;
    list.prepend(row);
  });
  showToast(`已加入 ${files.length} 个文件；连接后端后可解析与 OCR`); event.target.value = '';
});

// 接入配置
$('#api-url').value = state.apiBaseUrl;
function updateConnectionMode() {
  const badge = $('#global-connection');
  badge.textContent = state.apiBaseUrl ? '当前：API 模式' : '当前：演示模式';
  badge.className = `status-pill ${state.apiBaseUrl ? 'good' : 'neutral'}`;
}
updateConnectionMode();
$('#test-api').addEventListener('click', async () => {
  const url = $('#api-url').value.trim().replace(/\/$/, '');
  const result = $('#connection-result');
  if (!url) {
    state.apiBaseUrl = ''; localStorage.removeItem('evidenceAgentApi'); updateConnectionMode();
    result.textContent = '已切回演示模式。'; result.className = 'connection-result success'; return;
  }
  result.textContent = '正在检查 /health…'; result.className = 'connection-result';
  try {
    const response = await fetch(`${url}/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.apiBaseUrl = url; localStorage.setItem('evidenceAgentApi', url); updateConnectionMode();
    result.textContent = '连接成功，后续问答将调用真实接口。'; result.className = 'connection-result success';
  } catch (error) {
    result.textContent = `连接失败：${error.message}。未切换当前模式。`; result.className = 'connection-result error';
  }
});

$('#copy-checklist').addEventListener('click', () => {
  const text = `飞书接入清单\n1. 创建企业自建应用并配置回调地址与可用范围\n2. 申请云文档读取、云空间文件读取、机器人消息等最小权限\n3. 后端完成文档同步、Office/PDF 解析与图片 OCR\n4. 妙搭网页和飞书机器人复用同一套 /chat 接口\n5. 上线前验证文档级权限、证据链接、更新时间、承诺降级和原文留档`;
  navigator.clipboard?.writeText(text); showToast('接入清单已复制');
});

$('#notifications').addEventListener('click', () => showToast('3 条高风险对话待处理'));

async function initializeAuth() {
  // 演示身份只在当前页面会话内有效。刷新或重新打开页面时必须回到登录页，
  // 避免上一位体验者的销售/运营身份被下一位体验者直接继承。
  localStorage.removeItem('zedataiSession');

  if (state.apiBaseUrl) {
    try {
      const response = await fetch(`${state.apiBaseUrl.replace(/\/$/, '')}/auth/session`, { credentials: 'include' });
      if (response.ok) {
        const session = await response.json();
        if (session.user && ['sales', 'ops'].includes(session.user.role)) {
          completeLogin(session.user, 'feishu');
          return;
        }
      }
    } catch (_) {
      // 登录服务不可用时仍保留演示入口，不自动伪造身份。
    }
  }
}

initializeAuth();
