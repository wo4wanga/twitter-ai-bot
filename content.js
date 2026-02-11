// ==================== Twitter Content Script ====================
// 全自动模式：发现热门帖 → 停下回复 → 继续浏览

console.log('[Twitter AI Bot] Content Script 已加载');

// ==================== 配置 ====================
let config = {
  enabled: false,
  autoScroll: true,
  likeThreshold: 100,
  retweetThreshold: 50,
  maxPerHour: 10,
  scrollInterval: 8000,
  replyProbability: 0.5,
};

// ==================== 状态 ====================
const processedTweets = new Set();
let autoScrollTimer = null;
let isAutoRunning = false;
let repliesThisSession = 0;

// 用于等待 AI 回复的 Promise
let pendingReplyResolve = null;
let pendingTweetId = null;
let cachedReply = null; // 缓存早到的回复
let isWaitingForReply = false; // 标记是否正在等待回复

// ==================== Twitter DOM 选择器 ====================
const SELECTORS = {
  tweet: 'article[data-testid="tweet"]',
  tweetText: '[data-testid="tweetText"]',
  likeCount: '[data-testid="like"] span span, [data-testid="unlike"] span span',
  retweetCount: '[data-testid="retweet"] span span',
  replyButton: '[data-testid="reply"]',
  replyInput: '[data-testid="tweetTextarea_0"]',
  sendButton: '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',
  closeButton: '[data-testid="app-bar-close"], [aria-label="Close"], [aria-label="关闭"], [aria-label="閉じる"]',
};

// ==================== 工具函数 ====================
function parseCount(element) {
  if (!element) return 0;
  const text = element.textContent.trim();
  if (!text) return 0;
  
  const num = parseFloat(text.replace(/,/g, ''));
  if (text.includes('K') || text.includes('千')) return num * 1000;
  if (text.includes('M') || text.includes('万')) return num * 10000;
  return num || 0;
}

function detectLanguage(text) {
  const zhRegex = /[\u4e00-\u9fa5]/g;
  const jaRegex = /[\u3040-\u309f\u30a0-\u30ff]/g;
  
  const zhCount = (text.match(zhRegex) || []).length;
  const jaCount = (text.match(jaRegex) || []).length;
  
  if (jaCount > 5) return 'ja';
  if (zhCount > 5) return 'zh';
  return 'en';
}

function generateTweetId(text, likes, retweets) {
  // 只用文本内容生成 ID（likes/retweets 会变化，不能用）
  const str = text.substring(0, 150).trim();
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 清理弹窗和回复框 ====================
async function clearPopupsAndDialogs() {
  // 方法1: 多次按 ESC 确保关闭所有弹窗
  for (let i = 0; i < 5; i++) {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true
    }));
    await sleep(80);
  }
  
  await sleep(150);
  
  // 方法2: 点击各种关闭按钮（处理特殊弹窗如"仅限特定用户回复"）
  const closeSelectors = [
    '[data-testid="app-bar-close"]',
    '[aria-label="Close"]',
    '[aria-label="关闭"]',
    '[aria-label="閉じる"]',
    '[data-testid="confirmationSheetCancel"]',
    '[data-testid="confirmationSheetConfirm"]',
  ];
  
  for (const selector of closeSelectors) {
    const btn = document.querySelector(selector);
    if (btn) {
      btn.click();
      await sleep(100);
    }
  }
  
  // 方法3: 再按几次 ESC
  for (let i = 0; i < 3; i++) {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true
    }));
    await sleep(80);
  }
  
  await sleep(100);
}

// ==================== 提取推文数据 ====================
function extractTweetData(tweetElement) {
  const textElement = tweetElement.querySelector(SELECTORS.tweetText);
  const likeElement = tweetElement.querySelector(SELECTORS.likeCount);
  const retweetElement = tweetElement.querySelector(SELECTORS.retweetCount);
  const replyElement = tweetElement.querySelector('[data-testid="reply"] span span');
  
  const text = textElement?.textContent || '';
  const likes = parseCount(likeElement);
  const retweets = parseCount(retweetElement);
  const replies = parseCount(replyElement);
  const tweetId = generateTweetId(text, likes, retweets);
  
  // 检测是否包含视频
  const hasVideo = !!(
    tweetElement.querySelector('video') ||
    tweetElement.querySelector('[data-testid="videoPlayer"]') ||
    tweetElement.querySelector('[data-testid="videoComponent"]') ||
    tweetElement.querySelector('[aria-label*="video"]') ||
    tweetElement.querySelector('[aria-label*="Video"]') ||
    tweetElement.querySelector('[data-testid="tweetPhoto"] video')
  );
  
  // 提取推文 URL 和发布时间
  let tweetUrl = null;
  let publishTime = null;
  let minutesAgo = null;
  
  const timeElement = tweetElement.querySelector('a[href*="/status/"] time');
  if (timeElement) {
    const datetime = timeElement.getAttribute('datetime');
    if (datetime) {
      publishTime = datetime;
      const publishDate = new Date(datetime);
      minutesAgo = Math.floor((Date.now() - publishDate.getTime()) / 60000);
    }
    if (timeElement.parentElement?.href) {
      tweetUrl = timeElement.parentElement.href;
    }
  }
  
  if (!tweetUrl) {
    const statusLink = tweetElement.querySelector('a[href*="/status/"]');
    if (statusLink?.href) {
      tweetUrl = statusLink.href;
    }
  }
  
  // 提取作者信息
  let authorName = null;
  let authorHandle = null;
  let isVerified = false;
  let isBlueVerified = false;
  
  // 作者名称通常在用户头像链接旁边
  const userNameElement = tweetElement.querySelector('[data-testid="User-Name"]');
  if (userNameElement) {
    // 获取显示名称
    const nameSpan = userNameElement.querySelector('span span');
    if (nameSpan) {
      authorName = nameSpan.textContent?.trim();
    }
    
    // 获取 @handle
    const handleLink = userNameElement.querySelector('a[href^="/"]');
    if (handleLink) {
      const href = handleLink.getAttribute('href');
      if (href && href.startsWith('/')) {
        authorHandle = href.substring(1).split('/')[0];
      }
    }
    
    // 检测蓝标/验证标记
    // Twitter 蓝标是一个 SVG 图标
    const verifiedBadge = userNameElement.querySelector('svg[aria-label*="Verified"], svg[aria-label*="認証済み"], svg[aria-label*="已验证"], svg[data-testid="icon-verified"]');
    if (verifiedBadge) {
      isVerified = true;
      // 检查是否是蓝色认证（付费）还是金色/灰色（官方/企业）
      const badgeColor = verifiedBadge.querySelector('path')?.getAttribute('fill') || '';
      isBlueVerified = badgeColor.includes('#1D9BF0') || badgeColor.includes('rgb(29, 155, 240)');
    }
    
    // 备用检测方法
    if (!isVerified) {
      isVerified = !!(
        userNameElement.querySelector('[aria-label*="Verified"]') ||
        userNameElement.querySelector('[aria-label*="verified"]') ||
        userNameElement.querySelector('[data-testid="icon-verified"]')
      );
    }
  }
  
  // 计算互动率（评论+转发 相对于 点赞）
  const engagementRatio = likes > 0 ? ((replies + retweets) / likes * 100).toFixed(1) : 0;
  
  return {
    element: tweetElement,
    text,
    likes,
    retweets,
    replies,
    tweetId,
    language: detectLanguage(text),
    hasVideo,
    tweetUrl,
    // 新增元数据
    publishTime,
    minutesAgo,
    authorName,
    authorHandle,
    isVerified,
    isBlueVerified,
    engagementRatio,
  };
}

// ==================== 检查是否为热门帖 ====================
function isHotTweet(tweetData) {
  return tweetData.likes >= config.likeThreshold || 
         tweetData.retweets >= config.retweetThreshold;
}

// ==================== 通知提示 ====================
function showNotification(message, type = 'info') {
  const existing = document.querySelector('.twitter-ai-notification');
  if (existing) existing.remove();
  
  const notification = document.createElement('div');
  notification.className = `twitter-ai-notification twitter-ai-notification-${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.classList.add('twitter-ai-notification-hide');
    setTimeout(() => notification.remove(), 300);
  }, 4000);
}

// ==================== 倒计时通知（持久显示） ====================
function showCountdownNotification(message) {
  let notification = document.querySelector('.twitter-ai-countdown');
  
  if (!notification) {
    notification = document.createElement('div');
    notification.className = 'twitter-ai-notification twitter-ai-notification-warning twitter-ai-countdown';
    notification.style.cssText = 'position: fixed; bottom: 80px; right: 20px; z-index: 10001;';
    document.body.appendChild(notification);
  }
  
  notification.textContent = message;
  return notification;
}

function removeCountdownNotification() {
  const notification = document.querySelector('.twitter-ai-countdown');
  if (notification) {
    notification.classList.add('twitter-ai-notification-hide');
    setTimeout(() => notification.remove(), 300);
  }
}

// ==================== 等待上限重置 ====================
async function waitForLimitReset(remainingSeconds, currentCount, maxPerHour) {
  console.log(`[Twitter AI Bot] 等待上限重置，剩余 ${remainingSeconds} 秒`);
  
  // 暂停自动模式
  const wasAutoRunning = isAutoRunning;
  isAutoRunning = false;
  
  showNotification(`已达到每小时上限 (${currentCount}/${maxPerHour})，等待重置...`, 'warning');
  
  // 倒计时
  let remaining = remainingSeconds;
  
  while (remaining > 0) {
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    const timeStr = minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
    
    showCountdownNotification(`⏳ 回复上限 - 重置倒计时: ${timeStr}`);
    
    // 每秒更新
    await sleep(1000);
    remaining--;
    
    // 每30秒检查一次是否手动停止
    if (remaining % 30 === 0 && !config.enabled) {
      console.log('[Twitter AI Bot] 用户停止了自动模式，取消倒计时');
      removeCountdownNotification();
      return;
    }
  }
  
  // 倒计时结束
  removeCountdownNotification();
  console.log('[Twitter AI Bot] 上限重置，准备刷新页面');
  showNotification('上限已重置，刷新页面...', 'success');
  
  await sleep(1000);
  
  // 刷新页面
  window.location.reload();
}

// ==================== 模拟键盘输入 ====================
async function simulateTyping(element, text) {
  console.log('[Twitter AI Bot] simulateTyping 开始, 文本长度:', text.length);
  
  // 找到 DraftJS 编辑器
  const draftEditor = document.querySelector('[data-testid="tweetTextarea_0"]');
  const editableDiv = draftEditor?.querySelector('[contenteditable="true"]') ||
                      document.querySelector('[role="textbox"][contenteditable="true"]') ||
                      element.querySelector('[contenteditable="true"]') ||
                      element;
  
  console.log('[Twitter AI Bot] 目标元素:', editableDiv?.tagName, editableDiv?.className);
  
  if (!editableDiv) {
    console.error('[Twitter AI Bot] 找不到编辑器');
    return;
  }
  
  // 聚焦
  editableDiv.focus();
  await sleep(200);
  
  // 方法：使用 DataTransfer 模拟粘贴（最可靠的方式）
  try {
    // 创建 DataTransfer 对象
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', text);
    
    // 创建粘贴事件
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    });
    
    // 先触发 beforeinput
    editableDiv.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertFromPaste',
      data: text,
      dataTransfer: dataTransfer,
    }));
    
    // 触发粘贴事件
    const pasteResult = editableDiv.dispatchEvent(pasteEvent);
    console.log('[Twitter AI Bot] paste 事件结果:', pasteResult);
    
    await sleep(300);
    
    // 检查是否成功
    let currentText = editableDiv.textContent || '';
    console.log('[Twitter AI Bot] paste 后内容长度:', currentText.length);
    
    if (currentText.length >= text.length * 0.8) {
      console.log('[Twitter AI Bot] paste 方式成功');
      return;
    }
  } catch (e) {
    console.log('[Twitter AI Bot] paste 方式失败:', e.message);
  }
  
  // 备用方法：逐字符输入 + Selection API
  console.log('[Twitter AI Bot] 使用逐字符 + Selection 方式');
  
  editableDiv.focus();
  editableDiv.innerHTML = '';
  await sleep(100);
  
  // 创建文本节点
  const textNode = document.createTextNode('');
  editableDiv.appendChild(textNode);
  
  // 设置光标位置
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  
  // 逐字符输入
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    // 模拟 keydown
    editableDiv.dispatchEvent(new KeyboardEvent('keydown', {
      key: char,
      bubbles: true,
      cancelable: true,
    }));
    
    // 模拟 beforeinput
    editableDiv.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: char,
    }));
    
    // 实际插入字符
    textNode.textContent += char;
    
    // 更新光标
    range.setStart(textNode, textNode.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    
    // 模拟 input
    editableDiv.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      inputType: 'insertText',
      data: char,
    }));
    
    // 模拟 keyup
    editableDiv.dispatchEvent(new KeyboardEvent('keyup', {
      key: char,
      bubbles: true,
    }));
    
    // 延迟
    if (i % 5 === 0) {
      await sleep(10);
    }
  }
  
  await sleep(300);
  console.log('[Twitter AI Bot] 最终内容长度:', editableDiv.textContent?.length || 0);
}

// ==================== 标记开始等待回复 ====================
function startWaitingForReply(tweetId) {
  console.log('[Twitter AI Bot] 开始等待回复，tweetId:', tweetId);
  isWaitingForReply = true;
  pendingTweetId = tweetId;
  cachedReply = null;
  pendingReplyResolve = null;
}

// ==================== 设置回复回调（在发送消息后调用） ====================
function setupReplyCallback(tweetId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    // 检查是否已经有缓存的回复（API 响应太快的情况）
    if (cachedReply !== null) {
      console.log('[Twitter AI Bot] 使用缓存的回复:', cachedReply.text?.substring(0, 30));
      const { text, error } = cachedReply;
      cachedReply = null;
      isWaitingForReply = false;
      pendingTweetId = null;
      
      if (error) {
        reject(new Error(error));
      } else if (text) {
        resolve(text);
      } else {
        reject(new Error('收到空回复'));
      }
      return;
    }
    
    // 设置回调
    pendingReplyResolve = (text, error) => {
      pendingReplyResolve = null;
      pendingTweetId = null;
      isWaitingForReply = false;
      
      if (error) {
        reject(new Error(error));
      } else if (text) {
        resolve(text);
      } else {
        reject(new Error('收到空回复'));
      }
    };
    
    // 超时处理
    setTimeout(() => {
      if (pendingReplyResolve) {
        pendingReplyResolve = null;
        pendingTweetId = null;
        cachedReply = null;
        isWaitingForReply = false;
        reject(new Error('等待 AI 回复超时'));
      }
    }, timeoutMs);
  });
}

// ==================== 旧的等待函数（保留兼容） ====================
function waitForAIReply(tweetId, timeoutMs = 120000) {
  startWaitingForReply(tweetId);
  return setupReplyCallback(tweetId, timeoutMs);
}

// ==================== 在视图中查找热门推文 ====================
function findHotTweetInView() {
  const tweets = document.querySelectorAll(SELECTORS.tweet);
  
  for (const tweetElement of tweets) {
    const rect = tweetElement.getBoundingClientRect();
    const isVisible = rect.top >= 50 && rect.top <= window.innerHeight - 200;
    
    if (!isVisible) continue;
    
    const tweetData = extractTweetData(tweetElement);
    
    if (processedTweets.has(tweetData.tweetId)) continue;
    if (!isHotTweet(tweetData)) continue;
    if (!tweetData.text || tweetData.text.length < 10) continue;
    
    // 跳过包含视频的推文
    if (tweetData.hasVideo) {
      console.log('[Twitter AI Bot] 跳过视频推文');
      processedTweets.add(tweetData.tweetId);
      continue;
    }
    
    // 概率决定
    if (Math.random() > config.replyProbability) {
      console.log('[Twitter AI Bot] 随机跳过此推文');
      processedTweets.add(tweetData.tweetId);
      continue;
    }
    
    return tweetData;
  }
  
  return null;
}

// ==================== 完整的回复流程 ====================
async function replyToTweet(tweetData) {
  console.log('[Twitter AI Bot] ========== 开始回复流程 ==========');
  console.log('[Twitter AI Bot] 推文:', tweetData.text.substring(0, 50));
  
  // 标记为已处理
  processedTweets.add(tweetData.tweetId);
  console.log('[Twitter AI Bot] 标记推文 ID:', tweetData.tweetId, '已处理总数:', processedTweets.size);
  
  try {
    // 1. 滚动到推文
    console.log('[Twitter AI Bot] 步骤1: 滚动到推文');
    tweetData.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(1500);
    
    // 2. 点击回复按钮
    console.log('[Twitter AI Bot] 步骤2: 点击回复按钮');
    const replyButton = tweetData.element.querySelector(SELECTORS.replyButton);
    if (!replyButton) {
      throw new Error('找不到回复按钮');
    }
    
    replyButton.click();
    showNotification('正在打开回复框...', 'info');
    await sleep(2000);
    
    // 3. 确认回复框已打开
    console.log('[Twitter AI Bot] 步骤3: 确认回复框');
    let replyInput = document.querySelector(SELECTORS.replyInput);
    if (!replyInput) {
      // 重试一次
      await sleep(1000);
      replyInput = document.querySelector(SELECTORS.replyInput);
    }
    
    if (!replyInput) {
      throw new Error('回复框未能打开');
    }
    
    console.log('[Twitter AI Bot] 回复框已打开');
    
    // 4. 发送到 AI 并等待回复
    console.log('[Twitter AI Bot] 步骤4: 发送请求到 AI');
    showNotification('正在生成 AI 回复，请等待...', 'info');
    
    // 【关键】先标记开始等待，再发送消息（防止 API 响应太快）
    startWaitingForReply(tweetData.tweetId);
    
    let sendResult;
    try {
      sendResult = await chrome.runtime.sendMessage({
        type: 'GENERATE_REPLY',
        tweetText: tweetData.text,
        tweetId: tweetData.tweetId,
        language: tweetData.language,
        tweetUrl: tweetData.tweetUrl,
        // 新增元数据用于 AI 评估
        metadata: {
          likes: tweetData.likes,
          retweets: tweetData.retweets,
          replies: tweetData.replies,
          minutesAgo: tweetData.minutesAgo,
          authorName: tweetData.authorName,
          authorHandle: tweetData.authorHandle,
          isVerified: tweetData.isVerified,
          isBlueVerified: tweetData.isBlueVerified,
          engagementRatio: tweetData.engagementRatio,
        },
      });
      console.log('[Twitter AI Bot] Background 返回:', JSON.stringify(sendResult));
    } catch (e) {
      // 清理状态
      isWaitingForReply = false;
      pendingReplyResolve = null;
      pendingTweetId = null;
      cachedReply = null;
      console.error('[Twitter AI Bot] 发送消息失败:', e);
      throw new Error('无法连接到 Background: ' + e.message);
    }
    
    if (!sendResult) {
      isWaitingForReply = false;
      pendingReplyResolve = null;
      pendingTweetId = null;
      cachedReply = null;
      throw new Error('Background 没有响应');
    }
    
    // 检查是否达到每小时上限
    if (sendResult.limitReached) {
      console.log('[Twitter AI Bot] 达到每小时回复上限，暂停浏览');
      pendingReplyResolve = null;
      pendingTweetId = null;
      
      // 关闭回复对话框
      const closeBtn = document.querySelector(SELECTORS.closeButton);
      if (closeBtn) closeBtn.click();
      await sleep(300);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      
      // 启动倒计时等待
      await waitForLimitReset(sendResult.remainingSeconds, sendResult.currentCount, sendResult.maxPerHour);
      
      return false; // 返回 false，主循环会继续（此时已刷新页面）
    }
    
    if (!sendResult.success) {
      isWaitingForReply = false;
      pendingReplyResolve = null;
      pendingTweetId = null;
      cachedReply = null;
      throw new Error(sendResult.error || '发送到 AI 失败');
    }
    
    // 5. 等待 AI 回复（如果已经收到则立即返回）
    console.log('[Twitter AI Bot] 步骤5: 等待 AI 回复...');
    // 此时如果 cachedReply 已有值，setupReplyCallback 会立即返回
    const aiReplyText = await setupReplyCallback(tweetData.tweetId, 120000);
    
    console.log('[Twitter AI Bot] 收到 AI 回复:', aiReplyText);
    
    // 检查是否为内容过滤跳过
    if (aiReplyText === '__SKIP__') {
      console.log('[Twitter AI Bot] 内容过滤，关闭回复框继续浏览');
      
      // 使用统一的清理函数
      await clearPopupsAndDialogs();
      await clearPopupsAndDialogs(); // 多调用一次确保关闭
      
      // 滚动继续浏览
      window.scrollBy(0, 400);
      await sleep(500);
      
      return false; // 返回 false 表示跳过（非错误）
    }
    
    // 6. 确保回复框还在
    console.log('[Twitter AI Bot] 步骤6: 确认回复框状态');
    replyInput = document.querySelector(SELECTORS.replyInput);
    if (!replyInput) {
      // 尝试重新打开
      console.log('[Twitter AI Bot] 回复框已关闭，重新打开');
      const btn = tweetData.element.querySelector(SELECTORS.replyButton);
      if (btn) {
        btn.click();
        await sleep(2000);
        replyInput = document.querySelector(SELECTORS.replyInput);
      }
    }
    
    if (!replyInput) {
      throw new Error('回复框丢失');
    }
    
    // 7. 输入回复
    console.log('[Twitter AI Bot] 步骤7: 输入回复');
    showNotification('正在输入回复...', 'info');
    await simulateTyping(replyInput, aiReplyText);
    await sleep(1000);
    
    // 8. 点击发送
    console.log('[Twitter AI Bot] 步骤8: 等待发送按钮可用...');
    
    // 等待发送按钮变为可用（最多等10秒）
    let sendButton = null;
    for (let i = 0; i < 20; i++) {
      sendButton = document.querySelector(SELECTORS.sendButton);
      console.log('[Twitter AI Bot] 发送按钮状态:', sendButton ? `disabled=${sendButton.disabled}` : '未找到');
      
      if (sendButton && !sendButton.disabled) {
        break;
      }
      await sleep(500);
    }
    
    if (!sendButton) {
      throw new Error('找不到发送按钮');
    }
    
    if (sendButton.disabled) {
      // 如果按钮仍然禁用，可能是输入框内容没有被正确识别
      // 尝试再次触发输入事件
      console.log('[Twitter AI Bot] 按钮仍禁用，尝试重新触发输入事件');
      const replyInput2 = document.querySelector(SELECTORS.replyInput);
      if (replyInput2) {
        replyInput2.focus();
        replyInput2.dispatchEvent(new InputEvent('input', { bubbles: true, data: aiReplyText }));
        await sleep(1000);
      }
      
      // 再次检查
      sendButton = document.querySelector(SELECTORS.sendButton);
      if (!sendButton || sendButton.disabled) {
        throw new Error('发送按钮不可用，输入可能未被识别');
      }
    }
    
    console.log('[Twitter AI Bot] 点击发送按钮');
    sendButton.click();
    repliesThisSession++;
    
    await sleep(2000);
    
    // 关闭回复对话框（如果还在）
    const closeBtn = document.querySelector(SELECTORS.closeButton);
    if (closeBtn) {
      closeBtn.click();
      await sleep(500);
    }
    
    showNotification(`回复成功！(本次: ${repliesThisSession} 条)`, 'success');
    console.log('[Twitter AI Bot] ========== 回复完成 ==========');
    console.log('[Twitter AI Bot] 已处理推文数:', processedTweets.size);
    
    // 滚动离开当前推文，避免重复检测
    window.scrollBy(0, 600);
    await sleep(1000);
    
    return true;
    
  } catch (error) {
    console.error('[Twitter AI Bot] 回复失败:', error.message);
    showNotification('回复失败: ' + error.message, 'error');
    
    // 尝试关闭可能打开的对话框
    const closeBtn = document.querySelector(SELECTORS.closeButton);
    if (closeBtn) {
      closeBtn.click();
      await sleep(500);
    }
    
    return false;
  }
}

// ==================== 主循环 ====================
async function mainLoop() {
  console.log('[Twitter AI Bot] 开始主循环');
  
  // 开始前先清理可能存在的弹窗
  await clearPopupsAndDialogs();
  
  while (isAutoRunning && config.enabled) {
    // 每次循环开始前清理残留弹窗
    await clearPopupsAndDialogs();
    
    // 1. 查找热门推文
    const hotTweet = findHotTweetInView();
    
    if (hotTweet) {
      // 2. 找到了！执行回复（会阻塞直到完成）
      console.log('[Twitter AI Bot] 发现热门推文，开始处理');
      
      // 随机等待 2-5 秒
      const waitBefore = Math.floor(Math.random() * 3000) + 2000;
      showNotification(`发现热门推文，${Math.round(waitBefore/1000)}秒后开始回复...`, 'info');
      await sleep(waitBefore);
      
      if (!isAutoRunning) break;
      
      // 处理前再清理一次，确保没有残留弹窗
      await clearPopupsAndDialogs();
      
      await replyToTweet(hotTweet);
      
      // 回复后等待 5-10 秒再继续
      if (isAutoRunning) {
        const waitAfter = Math.floor(Math.random() * 5000) + 5000;
        console.log(`[Twitter AI Bot] 等待 ${waitAfter/1000} 秒后继续浏览`);
        await sleep(waitAfter);
      }
      
    } else {
      // 3. 没找到，滚动页面
      const scrollDistance = Math.floor(Math.random() * 400) + 300;
      window.scrollBy({ top: scrollDistance, behavior: 'smooth' });
      console.log(`[Twitter AI Bot] 滚动 ${scrollDistance}px`);
      
      // 等待后继续
      await sleep(config.scrollInterval);
    }
  }
  
  console.log('[Twitter AI Bot] 主循环结束');
}

// ==================== 启动/停止 ====================
function startAutoMode() {
  if (isAutoRunning) return;
  
  isAutoRunning = true;
  console.log('[Twitter AI Bot] 启动自动模式');
  showNotification('自动浏览模式已启动', 'success');
  
  // 启动主循环
  mainLoop();
}

function stopAutoMode() {
  isAutoRunning = false;
  console.log('[Twitter AI Bot] 停止自动模式');
  showNotification('自动浏览模式已停止', 'warning');
}

// ==================== 消息监听 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Twitter AI Bot] 收到消息:', message.type);
  
  switch (message.type) {
    case 'FILL_REPLY':
      // AI 回复到达，解决 Promise
      console.log('[Twitter AI Bot] FILL_REPLY 详情:', {
        messageId: message.tweetId,
        pendingId: pendingTweetId,
        hasResolve: !!pendingReplyResolve,
        isWaiting: isWaitingForReply,
        text: message.text?.substring(0, 30),
        error: message.error
      });
      
      if (pendingReplyResolve) {
        // 回调已设置，直接调用
        console.log('[Twitter AI Bot] 收到 AI 回复，准备 resolve');
        const callback = pendingReplyResolve;
        pendingReplyResolve = null;
        pendingTweetId = null;
        isWaitingForReply = false;
        
        if (message.error) {
          callback(null, message.error);
        } else {
          callback(message.text, null);
        }
      } else if (isWaitingForReply) {
        // 正在等待但回调还没设置，说明 API 响应太快，缓存回复
        console.log('[Twitter AI Bot] API 响应太快，缓存回复');
        cachedReply = {
          text: message.text,
          error: message.error,
          tweetId: message.tweetId
        };
      } else {
        console.log('[Twitter AI Bot] 没有等待中的请求，忽略此消息');
      }
      sendResponse({ success: true });
      break;
    
    case 'CONFIG_UPDATED':
      config = { ...config, ...message.config };
      console.log('[Twitter AI Bot] 配置已更新');
      sendResponse({ success: true });
      break;
    
    case 'START_AUTO':
      config.enabled = true;
      config.autoScroll = true;
      startAutoMode();
      sendResponse({ success: true });
      break;
    
    case 'STOP_AUTO':
      config.enabled = false;
      stopAutoMode();
      sendResponse({ success: true });
      break;
    
    case 'GET_STATUS':
      sendResponse({
        isRunning: isAutoRunning,
        repliesThisSession,
        processedCount: processedTweets.size,
      });
      break;
    
    case 'SKIP_REPLY':
      // 内容被过滤，跳过回复
      let skipReason;
      if (message.reason === 'low_score') {
        skipReason = `评分 ${message.score} 分，跳过`;
      } else if (message.reason === 'language') {
        skipReason = '非目标语言，跳过';
      } else if (message.reason === 'category') {
        skipReason = '不属于指定类别，跳过';
      } else {
        skipReason = '不符合条件，跳过';
      }
      console.log(`[Twitter AI Bot] SKIP_REPLY: ${message.message || skipReason}`);
      
      // 直接执行关闭和继续浏览的操作（不依赖 Promise）
      (async () => {
        try {
          showNotification(skipReason, 'warning');
          
          console.log('[Twitter AI Bot] 尝试关闭对话框...');
          
          // 方法1: 多次 ESC 关闭（处理多层弹窗）
          for (let i = 0; i < 8; i++) {
            document.dispatchEvent(new KeyboardEvent('keydown', { 
              key: 'Escape', 
              code: 'Escape',
              keyCode: 27,
              which: 27,
              bubbles: true,
              cancelable: true
            }));
            await sleep(100);
          }
          
          await sleep(300);
          
          // 方法2: 尝试点击各种关闭按钮（处理"仅限特定用户回复"等弹窗）
          const closeSelectors = [
            '[data-testid="app-bar-close"]',
            '[aria-label="Close"]',
            '[aria-label="关闭"]',
            '[aria-label="閉じる"]',
            'div[role="dialog"] button[aria-label]',
            '[data-testid="confirmationSheetConfirm"]', // 确认按钮
            '[data-testid="confirmationSheetCancel"]',  // 取消按钮
          ];
          
          for (const selector of closeSelectors) {
            const btn = document.querySelector(selector);
            if (btn) {
              console.log('[Twitter AI Bot] 点击关闭按钮:', selector);
              btn.click();
              await sleep(200);
            }
          }
          
          // 方法3: 再按几次 ESC 确保关闭
          for (let i = 0; i < 3; i++) {
            document.dispatchEvent(new KeyboardEvent('keydown', { 
              key: 'Escape', 
              code: 'Escape',
              keyCode: 27,
              which: 27,
              bubbles: true,
              cancelable: true
            }));
            await sleep(100);
          }
          
          await sleep(300);
          
          // 滚动继续浏览
          console.log('[Twitter AI Bot] 滚动继续浏览');
          window.scrollBy(0, 500);
          await sleep(500);
          
          console.log('[Twitter AI Bot] SKIP_REPLY 处理完成');
          
        } catch (e) {
          console.error('[Twitter AI Bot] 关闭对话框失败:', e);
        }
      })();
      
      // 同时也通知 Promise（如果还在等待）
      if (pendingReplyResolve) {
        console.log('[Twitter AI Bot] 通知等待中的 Promise');
        const callback = pendingReplyResolve;
        pendingReplyResolve = null;
        pendingTweetId = null;
        isWaitingForReply = false;
        callback('__SKIP__', null);
      } else if (isWaitingForReply) {
        // 回调还没设置，缓存跳过信号
        console.log('[Twitter AI Bot] 缓存跳过信号');
        cachedReply = {
          text: '__SKIP__',
          error: null,
          tweetId: pendingTweetId
        };
      } else {
        console.log('[Twitter AI Bot] 没有等待中的 Promise');
      }
      sendResponse({ success: true });
      break;
  }
  
  return true;
});

// ==================== 初始化 ====================
async function init() {
  console.log('[Twitter AI Bot] 初始化...');
  
  const result = await chrome.storage.local.get(['botConfig']);
  if (result.botConfig) {
    config = { ...config, ...result.botConfig };
  }
  
  chrome.runtime.sendMessage({ type: 'TWITTER_READY' });
  
  if (config.enabled && config.autoScroll) {
    setTimeout(() => startAutoMode(), 3000);
  }
  
  console.log('[Twitter AI Bot] 初始化完成');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
