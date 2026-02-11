// ==================== 状态管理 ====================
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
  }
});

// 标签页关闭时清理
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === twitterTabId) {
    twitterTabId = null;
  }
});

// ==================== 消息路由 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Background] 消息:', message.type);
  
  switch (message.type) {
    case 'GET_STATUS':
      sendResponse({
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

// ==================== 处理生成回复请求 ====================
async function handleGenerateReply(message, sourceTabId) {
  console.log('[Background] ===== 处理回复请求 =====');
  
  // 获取当前配置
  const { botConfig } = await chrome.storage.local.get(['botConfig']);
  const maxPerHour = botConfig?.maxPerHour || 10;
  const apiConfig = botConfig?.apiConfig;
  
  // 检查 API 配置
  if (!apiConfig?.apiKey) {
    return { success: false, error: '请先配置 API Key' };
  }
  
  // 频率检查
  checkHourReset();
  if (stats.repliesThisHour >= maxPerHour) {
    const elapsed = Date.now() - stats.lastHourReset;
    const remaining = Math.max(0, 3600000 - elapsed);
    const remainingSeconds = Math.ceil(remaining / 1000);
    
    console.log(`[Background] 已达上限 ${stats.repliesThisHour}/${maxPerHour}，剩余 ${remainingSeconds} 秒重置`);
    
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
  
  // 调用 API 生成回复
  return await handleApiGenerateReply(message, sourceTabId, apiConfig);
}

// ==================== API 生成回复 ====================
async function handleApiGenerateReply(message, sourceTabId, apiConfig) {
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
    console.log('[Background] 调用 API:', apiConfig.baseUrl);
    
    const response = await fetch(`${apiConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: apiConfig.model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.8,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
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
    
    if (cleanText.length > 280) {
      cleanText = cleanText.substring(0, 277) + '...';
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
    
    chrome.tabs.sendMessage(sourceTabId, {
      type: 'FILL_REPLY',
      text: null,
      tweetId: message.tweetId,
      error: error.message,
    }).catch(() => {});
    
    return { success: false, error: 'API 调用失败: ' + error.message };
  }
}

// ==================== 解析跳过响应 ====================
function parseSkipResponse(text) {
  const lower = text.toLowerCase().trim();
  
  if (!lower.startsWith('false')) {
    return null;
  }
  
  const parts = lower.split(':');
  
  if (parts.length >= 3 && parts[1] === 'score') {
    const score = parseInt(parts[2]) || 0;
    return {
      isSkip: true,
      reason: 'low_score',
      score: score,
      message: `评分 ${score} 分，未达阈值`
    };
  } else if (parts.length >= 2 && parts[1] === 'language') {
    return {
      isSkip: true,
      reason: 'language',
      score: null,
      message: '非目标语言'
    };
  } else if (parts.length >= 2 && parts[1] === 'category') {
    return {
      isSkip: true,
      reason: 'category',
      score: null,
      message: '不属于指定类别'
    };
  } else {
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
  
  const { contentCategories, botConfig, targetLanguages } = await chrome.storage.local.get(['contentCategories', 'botConfig', 'targetLanguages']);
  const categories = contentCategories || botConfig?.categories || ['web3', 'tech', 'finance', 'news'];
  const languages = targetLanguages || botConfig?.languages || ['zh', 'ja', 'en'];
  const replyThreshold = botConfig?.replyThreshold || 80;
  
  const categoryList = categories.map(cat => CATEGORY_MAP[cat] || cat).join('、');
  const languageList = languages.map(l => LANGUAGE_MAP[l] || l).join('、');
  
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
