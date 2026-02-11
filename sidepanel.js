// ==================== DOM 元素 ====================
const elements = {
  twitterStatus: document.getElementById('twitter-status'),
  twitterStatusText: document.getElementById('twitter-status-text'),
  apiStatus: document.getElementById('api-status'),
  apiStatusText: document.getElementById('api-status-text'),
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
  // API 配置
  apiBaseUrl: document.getElementById('api-base-url'),
  apiKey: document.getElementById('api-key'),
  apiModel: document.getElementById('api-model'),
  testApiBtn: document.getElementById('test-api-btn'),
  apiTestResult: document.getElementById('api-test-result'),
};

// ==================== 状态管理 ====================
let state = {
  twitterConnected: false,
  apiConfigured: false,
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
  
  // API 状态
  elements.apiStatus.className = 'status-dot' + (state.apiConfigured ? ' connected' : '');
  elements.apiStatusText.textContent = state.apiConfigured ? '已配置' : '未配置';
  
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
  const hasApiKey = elements.apiKey?.value?.length > 10;
  const canStart = state.twitterConnected && hasApiKey;
  
  elements.startAutoBtn.disabled = !canStart;
  
  if (!state.twitterConnected) {
    elements.startAutoBtn.textContent = '请先打开 Twitter';
  } else if (!hasApiKey) {
    elements.startAutoBtn.textContent = '请先配置 API Key';
  } else {
    elements.startAutoBtn.textContent = '🚀 一键启动全自动模式';
  }
}

// API Key 输入变化时更新状态
elements.apiKey?.addEventListener('input', () => {
  state.apiConfigured = elements.apiKey.value.length > 10;
  updateStatusUI();
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
      state.apiConfigured = true;
      updateStatusUI();
      
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

// ==================== 一键启动全自动模式 ====================
elements.startAutoBtn.addEventListener('click', async () => {
  if (!state.twitterConnected) {
    log('请先打开 Twitter 页面', 'error');
    return;
  }
  
  const apiKey = elements.apiKey.value.trim();
  if (!apiKey) {
    log('请先配置 API Key', 'error');
    return;
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
  log(`目标语言: ${langStr}，类别: ${categories.join(', ')}`, 'info');
  
  // 保存配置并启用
  const config = {
    enabled: true,
    autoScroll: true,
    likeThreshold: parseInt(elements.likeThreshold.value) || 100,
    retweetThreshold: parseInt(elements.retweetThreshold.value) || 50,
    maxPerHour: parseInt(elements.maxPerHour.value) || 10,
    replyThreshold: parseInt(elements.replyThreshold.value) || 80,
    categories: categories,
    languages: languages,
    apiConfig: {
      baseUrl: elements.apiBaseUrl.value.trim() || 'https://api.hodlai.fun/v1',
      apiKey: apiKey,
      model: elements.apiModel.value,
    },
  };
  
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

// ==================== 停止自动模式 ====================
elements.stopAutoBtn.addEventListener('click', async () => {
  try {
    const tabs = await chrome.tabs.query({ url: ['*://twitter.com/*', '*://x.com/*'] });
    
    for (const tab of tabs) {
      await chrome.tabs.sendMessage(tab.id, { type: 'STOP_AUTO' }).catch(() => {});
    }
    
    state.isAutoRunning = false;
    updateAutoModeUI();
    log('自动模式已停止', 'warning');
    
  } catch (error) {
    log(`停止失败: ${error.message}`, 'error');
  }
});

// ==================== 获取选中的类别和语言 ====================
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
    apiConfig: {
      baseUrl: elements.apiBaseUrl.value.trim() || 'https://api.hodlai.fun/v1',
      apiKey: elements.apiKey.value.trim(),
      model: elements.apiModel.value,
    },
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
  const result = await chrome.storage.local.get(['botConfig', 'apiConfig', 'contentCategories', 'targetLanguages']);
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
  
  // 加载 API 配置
  const apiConfig = result.apiConfig || config.apiConfig || {};
  if (elements.apiBaseUrl) {
    elements.apiBaseUrl.value = apiConfig.baseUrl || 'https://api.hodlai.fun/v1';
  }
  if (elements.apiKey) {
    elements.apiKey.value = apiConfig.apiKey || '';
    state.apiConfigured = apiConfig.apiKey?.length > 10;
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
    if (response) {
      elements.statHour.textContent = response.repliesThisHour || 0;
      elements.statTotal.textContent = response.totalReplies || 0;
    }
  } catch (e) {
    // 忽略错误
  }
}

// ==================== 检查状态 ====================
async function checkStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (response) {
      state.twitterConnected = response.twitterReady;
      state.isProcessing = response.isProcessing;
      updateStatusUI();
    }
  } catch (e) {
    // 忽略错误
  }
}

// ==================== 消息监听 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const sidepanelMessages = [
    'TWITTER_CONNECTED', 'PROCESSING_START', 
    'REPLY_GENERATED', 'REPLY_SENT', 'ERROR', 'CONTENT_FILTERED',
    'LIMIT_REACHED'
  ];
  
  if (!sidepanelMessages.includes(message.type)) {
    return false;
  }
  
  switch (message.type) {
    case 'TWITTER_CONNECTED':
      state.twitterConnected = true;
      updateStatusUI();
      log('Twitter 已连接', 'success');
      break;
    
    case 'PROCESSING_START':
      state.isProcessing = true;
      elements.currentTask.classList.add('active');
      elements.taskContent.textContent = `生成完成: ${message.tweetText}`;
      log(`处理推文: ${message.tweetText}`, 'info');
      break;
    
    case 'REPLY_GENERATED':
      log(`回复已生成: ${message.text?.substring(0, 50)}...`, 'success');
      updateStats();
      break;
    
    case 'REPLY_SENT':
      state.isProcessing = false;
      elements.currentTask.classList.remove('active');
      log('回复已发送', 'success');
      updateStats();
      break;
    
    case 'ERROR':
      state.isProcessing = false;
      elements.currentTask.classList.remove('active');
      log(`错误: ${message.message}`, 'error');
      break;
    
    case 'CONTENT_FILTERED':
      state.isProcessing = false;
      elements.currentTask.classList.remove('active');
      log(`跳过: ${message.reason}，继续浏览`, 'warning');
      break;
    
    case 'LIMIT_REACHED':
      log(`已达回复上限 (${message.currentCount}/${message.maxPerHour})，${Math.ceil(message.remainingSeconds/60)} 分钟后重置`, 'warning');
      break;
  }
  
  sendResponse({ received: true });
  return true;
});

// ==================== 初始化 ====================
async function init() {
  log('Twitter AI Bot 已启动', 'info');
  
  await loadConfig();
  await checkStatus();
  await updateStats();
  
  // 定时更新
  setInterval(checkStatus, 5000);
  setInterval(updateStats, 10000);
}

init();
