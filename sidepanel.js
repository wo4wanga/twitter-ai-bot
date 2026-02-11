// ==================== DOM 元素 ====================
const elements = {
  twitterStatus: document.getElementById('twitter-status'),
  twitterStatusText: document.getElementById('twitter-status-text'),
  geminiStatus: document.getElementById('gemini-status'),
  geminiStatusText: document.getElementById('gemini-status-text'),
  openGeminiBtn: document.getElementById('open-gemini-btn'),
  startAutoBtn: document.getElementById('start-auto-btn'),
  stopAutoBtn: document.getElementById('stop-auto-btn'),
  runningStatus: document.getElementById('running-status'),
  currentTask: document.getElementById('current-task'),
  taskContent: document.getElementById('task-content'),
  statHour: document.getElementById('stat-hour'),
  statTotal: document.getElementById('stat-total'),
  autoReplyToggle: document.getElementById('auto-reply-toggle'),
  likeThreshold: document.getElementById('like-threshold'),
  retweetThreshold: document.getElementById('retweet-threshold'),
  maxPerHour: document.getElementById('max-per-hour'),
  replyThreshold: document.getElementById('reply-threshold'),
  thresholdValue: document.getElementById('threshold-value'),
  saveConfigBtn: document.getElementById('save-config-btn'),
  logContainer: document.getElementById('log-container'),
  clearLog: document.getElementById('clear-log'),
  // AI 模式相关
  geminiModeSection: document.getElementById('gemini-mode-section'),
  apiModeSection: document.getElementById('api-mode-section'),
  apiBaseUrl: document.getElementById('api-base-url'),
  apiKey: document.getElementById('api-key'),
  apiModel: document.getElementById('api-model'),
  testApiBtn: document.getElementById('test-api-btn'),
  apiTestResult: document.getElementById('api-test-result'),
};

// ==================== 状态管理 ====================
let state = {
  twitterConnected: false,
  geminiConnected: false,
  isProcessing: false,
  isAutoRunning: false,
};

// ==================== 日志函数 ====================
function log(message, type = 'info') {
  const time = new Date().toLocaleTimeString('zh-CN', { 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit' 
  });
  
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-${type}">${message}</span>
  `;
  
  elements.logContainer.insertBefore(entry, elements.logContainer.firstChild);
  
  while (elements.logContainer.children.length > 50) {
    elements.logContainer.removeChild(elements.logContainer.lastChild);
  }
}

// ==================== 更新状态显示 ====================
function updateStatusUI() {
  // Twitter 状态
  elements.twitterStatus.className = 'status-dot' + (state.twitterConnected ? ' connected' : '');
  elements.twitterStatusText.textContent = state.twitterConnected ? '已连接' : '未连接';
  
  // Gemini 状态
  elements.geminiStatus.className = 'status-dot' + (state.geminiConnected ? ' connected' : '');
  elements.geminiStatusText.textContent = state.geminiConnected ? '已连接' : '未连接';
  
  // Gemini 按钮
  elements.openGeminiBtn.textContent = state.geminiConnected ? 'Gemini 已就绪' : '打开 Gemini';
  elements.openGeminiBtn.disabled = state.geminiConnected;
  
  // 自动模式按钮
  updateAutoModeUI();
}

function updateAutoModeUI() {
  if (state.isAutoRunning) {
    elements.startAutoBtn.style.display = 'none';
    elements.stopAutoBtn.style.display = 'block';
    elements.runningStatus.style.display = 'flex';
  } else {
    elements.startAutoBtn.style.display = 'block';
    elements.stopAutoBtn.style.display = 'none';
    elements.runningStatus.style.display = 'none';
  }
  
  // 检查是否可以启动
  const aiMode = document.querySelector('input[name="ai-mode"]:checked')?.value || 'gemini';
  let canStart = state.twitterConnected;
  
  if (aiMode === 'gemini') {
    canStart = canStart && state.geminiConnected;
    if (!canStart) {
      elements.startAutoBtn.textContent = '请先连接 Twitter 和 Gemini';
    }
  } else {
    // API 模式需要配置 API Key
    const hasApiKey = elements.apiKey?.value?.length > 10;
    canStart = canStart && hasApiKey;
    if (!canStart) {
      if (!state.twitterConnected) {
        elements.startAutoBtn.textContent = '请先打开 Twitter';
      } else {
        elements.startAutoBtn.textContent = '请先配置 API Key';
      }
    }
  }
  
  elements.startAutoBtn.disabled = !canStart;
  if (canStart) {
    elements.startAutoBtn.textContent = '🚀 一键启动全自动模式';
  }
}

// ==================== AI 模式切换 ====================
document.querySelectorAll('input[name="ai-mode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    const mode = e.target.value;
    
    if (mode === 'gemini') {
      elements.geminiModeSection.style.display = 'block';
      elements.apiModeSection.style.display = 'none';
    } else {
      elements.geminiModeSection.style.display = 'none';
      elements.apiModeSection.style.display = 'block';
    }
    
    // 保存模式选择
    chrome.storage.local.set({ aiMode: mode });
    updateAutoModeUI();
    log(`切换到 ${mode === 'gemini' ? 'Gemini 网页版' : 'API 调用'} 模式`, 'info');
  });
});

// API Key 输入变化时更新按钮状态
elements.apiKey?.addEventListener('input', () => {
  updateAutoModeUI();
});

// ==================== 测试 API 连接 ====================
elements.testApiBtn?.addEventListener('click', async () => {
  const baseUrl = elements.apiBaseUrl.value.trim() || 'https://api.hodlai.fun/v1';
  const apiKey = elements.apiKey.value.trim();
  const model = elements.apiModel.value;
  
  if (!apiKey) {
    elements.apiTestResult.innerHTML = '<span style="color: #e0245e;">请输入 API Key</span>';
    return;
  }
  
  elements.testApiBtn.disabled = true;
  elements.testApiBtn.textContent = '测试中...';
  elements.apiTestResult.innerHTML = '<span style="color: #ffad1f;">正在连接...</span>';
  
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'TEST_API',
      baseUrl,
      apiKey,
      model,
    });
    
    if (response.success) {
      elements.apiTestResult.innerHTML = '<span style="color: #17bf63;">连接成功！</span>';
      log('API 连接测试成功', 'success');
      
      // 保存配置
      chrome.storage.local.set({
        apiConfig: { baseUrl, apiKey, model }
      });
    } else {
      elements.apiTestResult.innerHTML = `<span style="color: #e0245e;">失败: ${response.error}</span>`;
      log(`API 测试失败: ${response.error}`, 'error');
    }
  } catch (error) {
    elements.apiTestResult.innerHTML = `<span style="color: #e0245e;">错误: ${error.message}</span>`;
  }
  
  elements.testApiBtn.disabled = false;
  elements.testApiBtn.textContent = '测试 API 连接';
});

// ==================== 打开 Gemini ====================
elements.openGeminiBtn.addEventListener('click', async () => {
  elements.openGeminiBtn.disabled = true;
  elements.openGeminiBtn.textContent = '正在打开...';
  
  try {
    const response = await chrome.runtime.sendMessage({ type: 'OPEN_GEMINI' });
    
    if (response.success) {
      log('Gemini 标签页已打开', 'success');
      if (!response.existing) {
        log('请在 Gemini 页面完成登录', 'warning');
      }
    } else {
      log(`打开 Gemini 失败: ${response.error}`, 'error');
      elements.openGeminiBtn.disabled = false;
      elements.openGeminiBtn.textContent = '打开 Gemini';
    }
  } catch (error) {
    log(`错误: ${error.message}`, 'error');
    elements.openGeminiBtn.disabled = false;
    elements.openGeminiBtn.textContent = '打开 Gemini';
  }
});

// ==================== 一键启动全自动模式 ====================
elements.startAutoBtn.addEventListener('click', async () => {
  const aiMode = document.querySelector('input[name="ai-mode"]:checked')?.value || 'gemini';
  
  if (!state.twitterConnected) {
    log('请先打开 Twitter 页面', 'error');
    return;
  }
  
  if (aiMode === 'gemini' && !state.geminiConnected) {
    log('请先打开 Gemini 并登录', 'error');
    return;
  }
  
  if (aiMode === 'api') {
    const apiKey = elements.apiKey.value.trim();
    if (!apiKey) {
      log('请先配置 API Key', 'error');
      return;
    }
  }
  
  const categories = getSelectedCategories();
  const languages = getSelectedLanguages();
  
  if (categories.length === 0) {
    log('请至少选择一个内容类别', 'error');
    return;
  }
  
  if (languages.length === 0) {
    log('请至少选择一种语言', 'error');
    return;
  }
  
  const langNames = { zh: '中文', ja: '日文', en: '英文' };
  const langStr = languages.map(l => langNames[l] || l).join('/');
  
  log('正在启动全自动模式...', 'info');
  log(`AI 模式: ${aiMode === 'gemini' ? 'Gemini 网页版' : 'API 调用'}`, 'info');
  log(`目标语言: ${langStr}，类别: ${categories.join(', ')}`, 'info');
  
  // 保存配置并启用
  const config = {
    enabled: true,
    autoScroll: true,
    likeThreshold: parseInt(elements.likeThreshold.value) || 100,
    retweetThreshold: parseInt(elements.retweetThreshold.value) || 50,
    maxPerHour: parseInt(elements.maxPerHour.value) || 10,
    replyThreshold: parseInt(elements.replyThreshold.value) || 80,
    aiMode: aiMode,
    categories: categories,
    languages: languages,
  };
  
  // 如果是 API 模式，保存 API 配置
  if (aiMode === 'api') {
    config.apiConfig = {
      baseUrl: elements.apiBaseUrl.value.trim() || 'https://api.hodlai.fun/v1',
      apiKey: elements.apiKey.value.trim(),
      model: elements.apiModel.value,
    };
  }
  
  await chrome.storage.local.set({ botConfig: config, contentCategories: categories, targetLanguages: languages });
  
  // 通知 Twitter 页面启动
  try {
    const tabs = await chrome.tabs.query({ url: ['*://twitter.com/*', '*://x.com/*'] });
    
    if (tabs.length === 0) {
      log('找不到 Twitter 标签页', 'error');
      return;
    }
    
    for (const tab of tabs) {
      await chrome.tabs.sendMessage(tab.id, { type: 'START_AUTO' }).catch(() => {});
    }
    
    state.isAutoRunning = true;
    updateAutoModeUI();
    log('全自动模式已启动！', 'success');
    log('Bot 将自动滚动浏览并回复热门推文', 'info');
    
  } catch (error) {
    log(`启动失败: ${error.message}`, 'error');
  }
});

// ==================== 停止全自动模式 ====================
elements.stopAutoBtn.addEventListener('click', async () => {
  log('正在停止全自动模式...', 'info');
  
  try {
    const tabs = await chrome.tabs.query({ url: ['*://twitter.com/*', '*://x.com/*'] });
    
    for (const tab of tabs) {
      await chrome.tabs.sendMessage(tab.id, { type: 'STOP_AUTO' }).catch(() => {});
    }
    
    // 更新配置
    const result = await chrome.storage.local.get(['botConfig']);
    const config = result.botConfig || {};
    config.enabled = false;
    config.autoScroll = false;
    await chrome.storage.local.set({ botConfig: config });
    
    state.isAutoRunning = false;
    updateAutoModeUI();
    log('全自动模式已停止', 'warning');
    
  } catch (error) {
    log(`停止失败: ${error.message}`, 'error');
  }
});

// ==================== 获取选中的内容类别 ====================
function getSelectedCategories() {
  const checkboxes = document.querySelectorAll('input[name="category"]:checked');
  return Array.from(checkboxes).map(cb => cb.value);
}

function getSelectedLanguages() {
  const checkboxes = document.querySelectorAll('input[name="language"]:checked');
  return Array.from(checkboxes).map(cb => cb.value);
}

// ==================== 回复阈值滑块实时更新 ====================
elements.replyThreshold.addEventListener('input', () => {
  elements.thresholdValue.textContent = elements.replyThreshold.value;
});

// ==================== 保存配置 ====================
elements.saveConfigBtn.addEventListener('click', async () => {
  const categories = getSelectedCategories();
  const languages = getSelectedLanguages();
  
  if (categories.length === 0) {
    log('请至少选择一个内容类别', 'error');
    return;
  }
  
  if (languages.length === 0) {
    log('请至少选择一种语言', 'error');
    return;
  }
  
  const replyThreshold = parseInt(elements.replyThreshold.value) || 80;
  
  const config = {
    enabled: elements.autoReplyToggle.checked,
    autoScroll: elements.autoReplyToggle.checked,
    likeThreshold: parseInt(elements.likeThreshold.value) || 100,
    retweetThreshold: parseInt(elements.retweetThreshold.value) || 50,
    maxPerHour: parseInt(elements.maxPerHour.value) || 10,
    replyThreshold: replyThreshold,
    categories: categories,
    languages: languages,
  };
  
  await chrome.storage.local.set({ botConfig: config, contentCategories: categories, targetLanguages: languages });
  log('配置已保存', 'success');
  
  const langNames = { zh: '中文', ja: '日文', en: '英文' };
  const langStr = languages.map(l => langNames[l] || l).join('/');
  log(`语言: ${langStr}，阈值: ${replyThreshold}分`, 'info');
  
  // 通知 content script
  chrome.tabs.query({ url: ['*://twitter.com/*', '*://x.com/*'] }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_UPDATED', config }).catch(() => {});
    });
  });
});

// ==================== 清空日志 ====================
elements.clearLog.addEventListener('click', () => {
  elements.logContainer.innerHTML = '';
  log('日志已清空', 'info');
});

// ==================== 加载配置 ====================
async function loadConfig() {
  const result = await chrome.storage.local.get(['botConfig', 'aiMode', 'apiConfig', 'contentCategories', 'targetLanguages']);
  const config = result.botConfig || {};
  
  elements.autoReplyToggle.checked = config.enabled || false;
  elements.likeThreshold.value = config.likeThreshold || 100;
  elements.retweetThreshold.value = config.retweetThreshold || 50;
  elements.maxPerHour.value = config.maxPerHour || 10;
  
  // 加载回复阈值
  const replyThreshold = config.replyThreshold || 80;
  elements.replyThreshold.value = replyThreshold;
  elements.thresholdValue.textContent = replyThreshold;
  
  state.isAutoRunning = config.enabled && config.autoScroll;
  
  // 加载 AI 模式
  const aiMode = result.aiMode || config.aiMode || 'gemini';
  const modeRadio = document.querySelector(`input[name="ai-mode"][value="${aiMode}"]`);
  if (modeRadio) {
    modeRadio.checked = true;
    // 触发 change 事件更新 UI
    if (aiMode === 'api') {
      elements.geminiModeSection.style.display = 'none';
      elements.apiModeSection.style.display = 'block';
    }
  }
  
  // 加载 API 配置
  const apiConfig = result.apiConfig || config.apiConfig || {};
  if (elements.apiBaseUrl) {
    elements.apiBaseUrl.value = apiConfig.baseUrl || 'https://api.hodlai.fun/v1';
  }
  if (elements.apiKey) {
    elements.apiKey.value = apiConfig.apiKey || '';
  }
  if (elements.apiModel && apiConfig.model) {
    elements.apiModel.value = apiConfig.model;
  }
  
  // 加载内容类别
  const categories = result.contentCategories || config.categories || ['web3', 'tech', 'finance', 'news'];
  document.querySelectorAll('input[name="category"]').forEach(cb => {
    cb.checked = categories.includes(cb.value);
  });
  
  // 加载目标语言
  const languages = result.targetLanguages || config.languages || ['zh', 'ja', 'en'];
  document.querySelectorAll('input[name="language"]').forEach(cb => {
    cb.checked = languages.includes(cb.value);
  });
}

// ==================== 更新统计 ====================
async function updateStats() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
    elements.statHour.textContent = response.repliesThisHour || 0;
    elements.statTotal.textContent = response.totalReplies || 0;
  } catch (error) {
    // 忽略错误
  }
}

// ==================== 获取状态 ====================
async function fetchStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    state.geminiConnected = response.geminiReady;
    state.twitterConnected = response.twitterReady;
    state.isProcessing = response.isProcessing;
    updateStatusUI();
    
    if (response.stats) {
      elements.statHour.textContent = response.stats.repliesThisHour || 0;
      elements.statTotal.textContent = response.stats.totalReplies || 0;
    }
  } catch (error) {
    // 忽略错误
  }
  
  // 检查 Twitter 页面的运行状态
  try {
    const tabs = await chrome.tabs.query({ url: ['*://twitter.com/*', '*://x.com/*'] });
    if (tabs.length > 0) {
      const status = await chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STATUS' }).catch(() => null);
      if (status) {
        state.isAutoRunning = status.isRunning;
        updateAutoModeUI();
      }
    }
  } catch (error) {
    // 忽略错误
  }
}

// ==================== 监听来自 Background 的消息 ====================
// 注意：只处理 sidepanel 关心的消息，不要拦截其他消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 只处理特定的消息类型，其他消息让 background 处理
  const sidepanelMessages = [
    'TWITTER_CONNECTED', 'GEMINI_READY', 'GEMINI_CLOSED', 
    'GEMINI_STATUS_UPDATE', 'PROCESSING_START', 
    'REPLY_GENERATED', 'REPLY_SENT', 'ERROR', 'CONTENT_FILTERED',
    'LIMIT_REACHED'
  ];
  
  if (!sidepanelMessages.includes(message.type)) {
    // 不是 sidepanel 的消息，不处理，让其他监听器处理
    return false;
  }
  
  console.log('[SidePanel] 收到消息:', message.type);
  
  switch (message.type) {
    case 'TWITTER_CONNECTED':
      state.twitterConnected = true;
      updateStatusUI();
      log('Twitter 已连接', 'success');
      break;
    
    case 'GEMINI_READY':
      state.geminiConnected = true;
      updateStatusUI();
      log('Gemini 已就绪', 'success');
      break;
    
    case 'GEMINI_CLOSED':
      state.geminiConnected = false;
      updateStatusUI();
      log('Gemini 标签页已关闭', 'warning');
      break;
    
    case 'GEMINI_STATUS_UPDATE':
      log(`Gemini: ${message.status}`, 'info');
      break;
    
    case 'PROCESSING_START':
      state.isProcessing = true;
      elements.currentTask.classList.add('active');
      elements.taskContent.textContent = message.tweetText;
      elements.geminiStatus.classList.add('processing');
      log(`开始处理推文: ${message.tweetText}`, 'info');
      break;
    
    case 'REPLY_GENERATED':
      log(`AI 回复: ${message.text}`, 'success');
      elements.taskContent.textContent = `生成完成: ${message.text}`;
      break;
    
    case 'REPLY_SENT':
      state.isProcessing = false;
      elements.currentTask.classList.remove('active');
      elements.geminiStatus.classList.remove('processing');
      log('回复已发送到 Twitter', 'success');
      updateStats();
      break;
    
    case 'ERROR':
      state.isProcessing = false;
      elements.currentTask.classList.remove('active');
      elements.geminiStatus.classList.remove('processing');
      log(`错误: ${message.message}`, 'error');
      break;
    
    case 'CONTENT_FILTERED':
      state.isProcessing = false;
      elements.currentTask.classList.remove('active');
      elements.geminiStatus.classList.remove('processing');
      log(`跳过: ${message.reason}，继续浏览`, 'warning');
      break;
    
    case 'LIMIT_REACHED':
      state.isProcessing = false;
      elements.currentTask.classList.remove('active');
      elements.geminiStatus.classList.remove('processing');
      const minutes = Math.floor(message.remainingSeconds / 60);
      const seconds = message.remainingSeconds % 60;
      log(`已达上限 (${message.currentCount}/${message.maxPerHour})，等待 ${minutes}分${seconds}秒 后重置`, 'warning');
      elements.taskContent.textContent = `等待重置: ${minutes}分${seconds}秒`;
      elements.currentTask.classList.add('active');
      break;
  }
  
  // 不需要 sendResponse，因为这些都是广播消息
  return false;
});

// ==================== 初始化 ====================
async function init() {
  log('侧边栏已启动', 'info');
  await loadConfig();
  await fetchStatus();
  updateAutoModeUI();
  
  // 定期刷新状态
  setInterval(fetchStatus, 5000);
  setInterval(updateStats, 10000);
}

init();
