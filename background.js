// ==================== 状态管理 ====================
let geminiTabId = null;
let twitterTabId = null;
let pendingRequest = null;
let isProcessing = false;

// 统计数据
let stats = {
  repliesThisHour: 0,
  lastHourReset: Date.now(),
  totalReplies: 0,
};

// ==================== 侧边栏设置 ====================
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// 监听标签页更新
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    if (tab.url.includes('twitter.com') || tab.url.includes('x.com')) {
      twitterTabId = tabId;
      await chrome.sidePanel.setOptions({
        tabId,
        path: 'sidepanel.html',
        enabled: true,
      });
    }
    
    if (tab.url.includes('gemini.google.com')) {
      geminiTabId = tabId;
      console.log('[Background] Gemini 标签页:', tabId);
      broadcastToSidePanel({ type: 'GEMINI_READY', tabId });
    }
  }
});

// 标签页关闭时清理
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === geminiTabId) {
    geminiTabId = null;
    broadcastToSidePanel({ type: 'GEMINI_CLOSED' });
  }
  if (tabId === twitterTabId) {
    twitterTabId = null;
  }
});

// ==================== 消息路由 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Background] 消息:', message.type);
  
  switch (message.type) {
    case 'OPEN_GEMINI':
      openGeminiTab().then(sendResponse);
      return true;
    
    case 'GET_STATUS':
      sendResponse({
        geminiReady: geminiTabId !== null,
        twitterReady: twitterTabId !== null,
        isProcessing,
        stats,
      });
      return true;
    
    case 'GET_STATS':
      checkHourReset();
      sendResponse(stats);
      return true;
    
    case 'GENERATE_REPLY':
      handleGenerateReply(message, sender.tab?.id).then(sendResponse);
      return true;
    
    case 'TWITTER_READY':
      twitterTabId = sender.tab?.id;
      broadcastToSidePanel({ type: 'TWITTER_CONNECTED', tabId: twitterTabId });
      sendResponse({ success: true });
      return true;
    
    case 'GEMINI_RESPONSE':
      handleGeminiResponse(message);
      sendResponse({ success: true });
      return true;
    
    case 'GEMINI_ERROR':
      handleGeminiError(message);
      sendResponse({ success: true });
      return true;
    
    case 'GEMINI_STATUS':
      console.log('[Background] Gemini:', message.status);
      broadcastToSidePanel({ type: 'GEMINI_STATUS_UPDATE', status: message.status });
      sendResponse({ success: true });
      return true;
    
    case 'TEST_API':
      testApiConnection(message).then(sendResponse);
      return true;
  }
  
  return false;
});

// ==================== 测试 API 连接 ====================
async function testApiConnection({ baseUrl, apiKey, model }) {
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 10,
      }),
    });
    
    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${error}` };
    }
    
    const data = await response.json();
    return { success: true, model: data.model };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== 打开 Gemini ====================
async function openGeminiTab() {
  try {
    const existingTabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    if (existingTabs.length > 0) {
      geminiTabId = existingTabs[0].id;
      await chrome.tabs.update(geminiTabId, { active: true });
      return { success: true, tabId: geminiTabId, existing: true };
    }
    
    const tab = await chrome.tabs.create({
      url: 'https://gemini.google.com/app',
      active: true,
    });
    geminiTabId = tab.id;
    return { success: true, tabId: tab.id, existing: false };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== 处理生成回复请求 ====================
async function handleGenerateReply(message, sourceTabId) {
  console.log('[Background] ===== 处理回复请求 =====');
  
  // 获取当前配置
  const { botConfig } = await chrome.storage.local.get(['botConfig']);
  const maxPerHour = botConfig?.maxPerHour || 10;
  const aiMode = botConfig?.aiMode || 'gemini';
  
  // 频率检查
  checkHourReset();
  if (stats.repliesThisHour >= maxPerHour) {
    // 计算距离下一小时重置的剩余时间（毫秒）
    const elapsed = Date.now() - stats.lastHourReset;
    const remaining = Math.max(0, 3600000 - elapsed);
    const remainingSeconds = Math.ceil(remaining / 1000);
    
    console.log(`[Background] 已达上限 ${stats.repliesThisHour}/${maxPerHour}，剩余 ${remainingSeconds} 秒重置`);
    
    // 通知 sidepanel
    broadcastToSidePanel({ 
      type: 'LIMIT_REACHED', 
      currentCount: stats.repliesThisHour,
      maxPerHour: maxPerHour,
      remainingSeconds: remainingSeconds
    });
    
    return { 
      success: false, 
      error: '已达到每小时回复上限',
      limitReached: true,
      remainingSeconds: remainingSeconds,
      currentCount: stats.repliesThisHour,
      maxPerHour: maxPerHour
    };
  }
  
  if (isProcessing) {
    return { success: false, error: '正在处理中' };
  }
  
  console.log('[Background] AI 模式:', aiMode);
  
  if (aiMode === 'api') {
    // API 模式
    return await handleApiGenerateReply(message, sourceTabId, botConfig?.apiConfig);
  } else {
    // Gemini 网页版模式
    return await handleGeminiGenerateReply(message, sourceTabId);
  }
}

// ==================== API 模式生成回复 ====================
async function handleApiGenerateReply(message, sourceTabId, apiConfig) {
  if (!apiConfig?.apiKey) {
    return { success: false, error: '请先配置 API Key' };
  }
  
  isProcessing = true;
  
  const prompt = await buildPrompt(message.tweetText, message.language, message.tweetUrl, message.metadata);
  
  pendingRequest = {
    sourceTabId,
    tweetId: message.tweetId,
    timestamp: Date.now(),
  };
  
  broadcastToSidePanel({ 
    type: 'PROCESSING_START', 
    tweetText: message.tweetText.substring(0, 50) + '...' 
  });
  
  try {
    const baseUrl = apiConfig.baseUrl || 'https://api.hodlai.fun/v1';
    const model = apiConfig.model || 'gpt-4o-mini';
    
    console.log('[Background] 调用 API:', baseUrl, model);
    
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: '你是一个社交媒体回复助手。如果推文不属于用户指定的内容类别，直接回复 false。如果属于，则生成简短、自然、有趣的回复。' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 150,
        temperature: 0.8,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API 错误 ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    const replyText = data.choices?.[0]?.message?.content?.trim();
    
    if (!replyText) {
      throw new Error('API 返回空回复');
    }
    
    console.log('[Background] API 回复:', replyText);
    
    // 检查是否为跳过响应
    const skipInfo = parseSkipResponse(replyText);
    if (skipInfo) {
      console.log('[Background] 跳过:', skipInfo.message);
      isProcessing = false;
      pendingRequest = null;
      
      broadcastToSidePanel({ 
        type: 'CONTENT_FILTERED', 
        reason: skipInfo.message,
        score: skipInfo.score 
      });
      
      // 通知 Twitter 关闭回复框并继续浏览
      chrome.tabs.sendMessage(sourceTabId, {
        type: 'SKIP_REPLY',
        tweetId: message.tweetId,
        reason: skipInfo.reason,
        score: skipInfo.score,
        message: skipInfo.message,
      }).catch(e => console.error('[Background] 发送跳过消息失败:', e));
      
      return { success: true, skipped: true, reason: skipInfo.reason, score: skipInfo.score };
    }
    
    // 清理回复文本
    let cleanText = replyText
      .replace(/^["'「」『』]|["'「」『』]$/g, '')
      .replace(/^(回复|Reply)[：:]\s*/i, '')
      .replace(/^\*\*.*?\*\*\s*/, '')
      .split('\n')[0]
      .trim();
    
    if (cleanText.length > 150) {
      cleanText = cleanText.substring(0, 147) + '...';
    }
    
    // 更新统计
    stats.repliesThisHour++;
    stats.totalReplies++;
    saveStats();
    
    broadcastToSidePanel({ type: 'REPLY_GENERATED', text: cleanText });
    
    // 发送到 Twitter
    chrome.tabs.sendMessage(sourceTabId, {
      type: 'FILL_REPLY',
      text: cleanText,
      tweetId: message.tweetId,
    }).catch(e => console.error('[Background] 发送到 Twitter 失败:', e));
    
    isProcessing = false;
    pendingRequest = null;
    
    return { success: true };
    
  } catch (error) {
    console.error('[Background] API 调用失败:', error.message);
    isProcessing = false;
    pendingRequest = null;
    
    // 发送错误到 Twitter
    chrome.tabs.sendMessage(sourceTabId, {
      type: 'FILL_REPLY',
      text: null,
      tweetId: message.tweetId,
      error: error.message,
    }).catch(() => {});
    
    return { success: false, error: 'API 调用失败: ' + error.message };
  }
}

// ==================== Gemini 网页版生成回复 ====================
async function handleGeminiGenerateReply(message, sourceTabId) {
  // 查找 Gemini 标签页
  if (!geminiTabId) {
    const existingTabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    if (existingTabs.length > 0) {
      geminiTabId = existingTabs[0].id;
    } else {
      return { success: false, error: '请先打开 Gemini 页面' };
    }
  }
  
  // 验证标签页存在
  try {
    await chrome.tabs.get(geminiTabId);
  } catch (e) {
    geminiTabId = null;
    return { success: false, error: 'Gemini 标签页已关闭，请重新打开' };
  }
  
  isProcessing = true;
  
  const prompt = await buildPrompt(message.tweetText, message.language, message.tweetUrl, message.metadata);
  
  pendingRequest = {
    sourceTabId,
    tweetId: message.tweetId,
    timestamp: Date.now(),
  };
  
  // 先尝试注入脚本，确保 content script 已加载
  try {
    console.log('[Background] 注入 gemini-content.js...');
    await chrome.scripting.executeScript({
      target: { tabId: geminiTabId },
      files: ['gemini-content.js']
    });
    console.log('[Background] 脚本注入成功');
  } catch (e) {
    console.log('[Background] 脚本可能已存在:', e.message);
  }
  
  // 等待脚本初始化
  await new Promise(r => setTimeout(r, 500));
  
  // 【关键】切换到 Gemini 标签页，避免后台节流
  try {
    console.log('[Background] 切换到 Gemini 标签页，避免后台节流');
    await chrome.tabs.update(geminiTabId, { active: true });
    await new Promise(r => setTimeout(r, 300)); // 等待标签页激活
  } catch (e) {
    console.log('[Background] 切换标签页失败:', e.message);
  }
  
  // 发送消息到 Gemini
  try {
    console.log('[Background] 发送 SEND_PROMPT 到 Gemini tabId:', geminiTabId);
    
    const result = await chrome.tabs.sendMessage(geminiTabId, {
      type: 'SEND_PROMPT',
      prompt,
    });
    
    console.log('[Background] Gemini 响应:', result);
    
    if (!result || !result.success) {
      throw new Error(result?.error || 'Gemini 返回失败');
    }
    
    broadcastToSidePanel({ 
      type: 'PROCESSING_START', 
      tweetText: message.tweetText.substring(0, 50) + '...' 
    });
    
    // 添加超时保护，120秒后自动重置状态
    const requestTime = Date.now();
    setTimeout(() => {
      if (isProcessing && pendingRequest?.timestamp <= requestTime) {
        console.log('[Background] 处理超时，重置状态');
        isProcessing = false;
        pendingRequest = null;
        broadcastToSidePanel({ type: 'ERROR', message: '处理超时，已重置状态' });
        // 超时时也切回 Twitter
        switchBackToTwitter(sourceTabId);
      }
    }, 120000);
    
    return { success: true };
    
  } catch (error) {
    console.error('[Background] 发送失败:', error.message);
    isProcessing = false;
    pendingRequest = null;
    // 失败时切回 Twitter
    switchBackToTwitter(sourceTabId);
    return { success: false, error: '与 Gemini 通信失败: ' + error.message };
  }
}

// ==================== 切换回 Twitter 标签页 ====================
async function switchBackToTwitter(tabId) {
  if (!tabId) return;
  
  try {
    // 验证标签页存在
    await chrome.tabs.get(tabId);
    console.log('[Background] 切换回 Twitter 标签页:', tabId);
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) {
    console.log('[Background] 切换回 Twitter 失败:', e.message);
  }
}

// ==================== 解析跳过响应 ====================
function parseSkipResponse(text) {
  const lower = text.toLowerCase().trim();
  
  // 检查是否以 false 开头
  if (!lower.startsWith('false')) {
    return null; // 不是跳过响应
  }
  
  // 解析格式：false:language 或 false:category 或 false:score:XX
  const parts = lower.split(':');
  
  if (parts.length >= 3 && parts[1] === 'score') {
    // false:score:XX
    const score = parseInt(parts[2]) || 0;
    return {
      isSkip: true,
      reason: 'low_score',
      score: score,
      message: `评分 ${score} 分，未达阈值`
    };
  } else if (parts.length >= 2 && parts[1] === 'language') {
    // false:language
    return {
      isSkip: true,
      reason: 'language',
      score: null,
      message: '非目标语言'
    };
  } else if (parts.length >= 2 && parts[1] === 'category') {
    // false:category
    return {
      isSkip: true,
      reason: 'category',
      score: null,
      message: '不属于指定类别'
    };
  } else {
    // 兼容旧格式：只有 false
    return {
      isSkip: true,
      reason: 'unknown',
      score: null,
      message: '不符合条件'
    };
  }
}

// ==================== 内容类别映射 ====================
const CATEGORY_MAP = {
  web3: 'Web3/加密货币/区块链/NFT/DeFi',
  tech: '科技/AI/编程/互联网/软件',
  finance: '经济/金融/股票/投资/理财',
  news: '时事/新闻/政治/社会热点',
  gaming: '游戏/电竞/主机/手游',
  entertainment: '娱乐/明星/影视/音乐',
  sports: '体育/运动/健身/赛事',
  lifestyle: '生活/日常/美食/旅行',
};

// ==================== 语言名称映射 ====================
const LANGUAGE_MAP = {
  zh: '中文',
  ja: '日文',
  en: '英文',
};

// ==================== 构建 Prompt ====================
async function buildPrompt(tweetText, language, tweetUrl = null, metadata = null) {
  const langMap = { zh: '中文', ja: '日文', en: '英文' };
  const lang = langMap[language] || '原推文语言';
  
  // 获取用户配置
  const { contentCategories, botConfig, targetLanguages } = await chrome.storage.local.get(['contentCategories', 'botConfig', 'targetLanguages']);
  const categories = contentCategories || botConfig?.categories || ['web3', 'tech', 'finance', 'news'];
  const languages = targetLanguages || botConfig?.languages || ['zh', 'ja', 'en'];
  const replyThreshold = botConfig?.replyThreshold || 80;
  
  // 构建类别列表
  const categoryList = categories.map(cat => CATEGORY_MAP[cat] || cat).join('、');
  
  // 构建目标语言列表
  const languageList = languages.map(l => LANGUAGE_MAP[l] || l).join('、');
  
  // 推文链接（模型可以直接访问获取完整信息）
  let urlInfo = tweetUrl ? `\n推文链接（可直接访问查看完整内容、作者、时间等）：${tweetUrl}` : '';
  
  return `你是一名资深的 Twitter 流量运营专家。请判断这条推文是否值得回复。
${urlInfo}

【推文内容预览】
"${tweetText}"

【第一步：语言过滤】
推文必须是以下语言之一：${languageList}

非目标语言 → 回复：false:language

【第二步：类别过滤】
推文必须属于以下类别之一：
${categoryList}

不属于上述类别 → 回复：false:category

【第三步：质量评分】（仅对通过前两步的推文）
从以下维度综合打分（0-100）：
1. 时效动量 (40%)：30分钟内黄金期，2小时以上降权
2. 账号能量 (20%)：蓝标、大V、高互动量优先
3. 内容增量 (40%)：能否引发争议、共鸣或提供干货

分数 < ${replyThreshold} → 回复：false:score:XX（XX为实际分数）
分数 >= ${replyThreshold} → 生成回复

【回复要求】
1. 判断策略：反驳/吹捧/补充干货/神回复
2. 风格匹配：科技话题专业幽默，Web3老韭菜视角，时事理性有态度
3. 严禁 AI 腔，像真人聊天
4. 30 字以内，语气自然
5. 禁用列表、分号、emoji
6. 使用${lang}回复

【输出格式】
- 语言不符：false:language
- 类别不符：false:category
- 分数不够：false:score:XX
- 值得回复：直接输出回复内容（无前缀）`;
}

// ==================== 处理 Gemini 响应 ====================
function handleGeminiResponse(message) {
  console.log('[Background] 收到 Gemini 响应:', message.text);
  
  if (!pendingRequest) {
    console.warn('[Background] 没有待处理请求');
    return;
  }
  
  const replyText = message.text.trim();
  const { sourceTabId, tweetId } = pendingRequest;
  
  // 【关键】收到响应后，先切换回 Twitter 标签页
  switchBackToTwitter(sourceTabId);
  
  // 检查是否为跳过响应
  const skipInfo = parseSkipResponse(replyText);
  if (skipInfo) {
    console.log('[Background] Gemini 跳过:', skipInfo.message);
    isProcessing = false;
    pendingRequest = null;
    
    broadcastToSidePanel({ 
      type: 'CONTENT_FILTERED', 
      reason: skipInfo.message,
      score: skipInfo.score 
    });
    
    // 通知 Twitter 关闭回复框并继续浏览
    chrome.tabs.sendMessage(sourceTabId, {
      type: 'SKIP_REPLY',
      tweetId,
      reason: skipInfo.reason,
      score: skipInfo.score,
      message: skipInfo.message,
    }).catch(e => console.error('[Background] 发送跳过消息失败:', e));
    
    return;
  }
  
  stats.repliesThisHour++;
  stats.totalReplies++;
  saveStats();
  
  broadcastToSidePanel({ type: 'REPLY_GENERATED', text: replyText });
  
  chrome.tabs.sendMessage(sourceTabId, {
    type: 'FILL_REPLY',
    text: replyText,
    tweetId,
  }).then(() => {
    broadcastToSidePanel({ type: 'REPLY_SENT' });
  }).catch(e => {
    console.error('[Background] 发送到 Twitter 失败:', e);
  });
  
  isProcessing = false;
  pendingRequest = null;
}

// ==================== 处理 Gemini 错误 ====================
function handleGeminiError(message) {
  console.log('[Background] Gemini 错误:', message.error);
  
  broadcastToSidePanel({ type: 'ERROR', message: message.error });
  
  if (pendingRequest?.sourceTabId) {
    // 【关键】错误时也切换回 Twitter
    switchBackToTwitter(pendingRequest.sourceTabId);
    
    chrome.tabs.sendMessage(pendingRequest.sourceTabId, {
      type: 'FILL_REPLY',
      text: null,
      tweetId: pendingRequest.tweetId,
      error: message.error,
    }).catch(() => {});
  }
  
  isProcessing = false;
  pendingRequest = null;
}

// ==================== 工具函数 ====================
function broadcastToSidePanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function checkHourReset() {
  if (Date.now() - stats.lastHourReset > 3600000) {
    stats.repliesThisHour = 0;
    stats.lastHourReset = Date.now();
    saveStats();
  }
}

function saveStats() {
  chrome.storage.local.set({ botStats: stats });
}

chrome.storage.local.get(['botStats'], (result) => {
  if (result.botStats) {
    stats = { ...stats, ...result.botStats };
    checkHourReset();
  }
});

console.log('[Background] Twitter AI Bot 启动');
