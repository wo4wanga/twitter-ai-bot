// ==================== Gemini 页面 Content Script ====================
// 用于操作 Gemini 网页版的 DOM

// 防止重复注入
if (window.__GEMINI_CONTENT_LOADED__) {
  console.log('[Gemini Content] 脚本已存在，跳过');
} else {
  window.__GEMINI_CONTENT_LOADED__ = true;
  
console.log('[Gemini Content] 脚本已加载');

// ==================== 状态管理 ====================
let isWaitingForResponse = false;
let pollInterval = null;
let lastMessageCount = 0;
let stableCount = 0;
let lastResponseText = '';
let previousResponseText = ''; // 发送前的最后一条响应，用于排除旧响应

// ==================== 工具函数 ====================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 查找输入框 - 更新的选择器
function findInputBox() {
  // Gemini 2024-2025 版本的选择器
  const selectors = [
    // 主要输入框 - rich-textarea 内部
    'rich-textarea .ql-editor',
    'rich-textarea div[contenteditable="true"]',
    '.ql-editor[contenteditable="true"]',
    // 通用
    'div[contenteditable="true"][aria-label]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    // 备用
    '[data-placeholder][contenteditable="true"]',
    'textarea',
  ];
  
  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      // 确保是可见的输入框
      if (el.offsetParent !== null && el.offsetHeight > 20) {
        console.log('[Gemini Content] 匹配选择器:', selector);
        return el;
      }
    }
  }
  return null;
}

// 模拟真实用户输入
async function simulateTyping(element, text) {
  console.log('[Gemini Content] simulateTyping 开始');
  
  // 聚焦
  element.focus();
  await sleep(100);
  
  // 彻底清空
  element.innerHTML = '';
  element.innerText = '';
  element.textContent = '';
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  await sleep(100);
  
  // 方法1: 使用 Clipboard API
  try {
    await navigator.clipboard.writeText(text);
    document.execCommand('paste');
    console.log('[Gemini Content] Clipboard paste 成功');
    await sleep(100);
    if (element.innerText.length > 10) return true;
  } catch (e) {
    console.log('[Gemini Content] Clipboard 不可用');
  }
  
  // 方法2: DataTransfer paste
  try {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', text);
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dataTransfer,
      bubbles: true,
      cancelable: true
    });
    element.dispatchEvent(pasteEvent);
    console.log('[Gemini Content] DataTransfer paste 尝试');
    await sleep(100);
    if (element.innerText.length > 10) return true;
  } catch (e) {
    console.log('[Gemini Content] DataTransfer 不可用');
  }
  
  // 方法3: 直接设置 + input 事件
  element.innerText = text;
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  console.log('[Gemini Content] 直接设置 innerText');
  
  await sleep(200);
  
  // 触发 change 事件
  element.dispatchEvent(new Event('change', { bubbles: true }));
  
  return element.innerText.length > 10;
}

// 查找发送按钮
function findSendButton() {
  const selectors = [
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    'button[aria-label*="发送"]',
    'button[aria-label*="Submit"]',
    'button[mattooltip*="Send"]',
    'button[data-test-id="send-button"]',
    // 查找包含发送图标的按钮
    'button svg[viewBox="0 0 24 24"]',
  ];
  
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      // 如果找到的是 svg，返回父按钮
      return el.closest('button') || el;
    }
  }
  
  // 备用：查找底部区域的按钮
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    const rect = btn.getBoundingClientRect();
    // 在页面底部的按钮
    if (rect.bottom > window.innerHeight - 200 && !btn.disabled) {
      const text = btn.textContent.toLowerCase();
      if (text.includes('send') || text.includes('发送') || btn.querySelector('svg')) {
        return btn;
      }
    }
  }
  
  return null;
}

// 获取所有对话消息
function getAllMessages() {
  // Gemini 的消息容器选择器
  const selectors = [
    // 模型响应
    '[data-message-author-role="model"]',
    '.model-response-text',
    '.response-container-content',
    // 更通用的选择器 - 查找对话区域的消息
    'message-content',
    '.conversation-container > div',
    // 2024 新版 Gemini
    '[class*="response"]',
    '[class*="message"]',
  ];
  
  let messages = [];
  
  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      messages = Array.from(elements);
      break;
    }
  }
  
  return messages;
}

// 提取最后一条 AI 响应的文本（排除旧响应）
function extractLastResponse(excludeOld = false) {
  console.log('[Gemini Content] 尝试提取响应...');
  
  // 辅助函数：检查是否为新响应
  const isNewResponse = (text) => {
    if (!excludeOld || !previousResponseText) return true;
    // 如果文本与之前的响应相同，则不是新响应
    return text !== previousResponseText && !previousResponseText.includes(text) && !text.includes(previousResponseText.substring(0, 20));
  };
  
  // 方法1: 直接查找模型响应
  const modelResponses = document.querySelectorAll('[data-message-author-role="model"]');
  console.log('[Gemini Content] model 响应数量:', modelResponses.length);
  if (modelResponses.length > 0) {
    // 从后往前找，找到第一个新响应
    for (let i = modelResponses.length - 1; i >= 0; i--) {
      const text = modelResponses[i].textContent.trim();
      if (text.length > 10 && isNewResponse(text)) {
        console.log('[Gemini Content] 方法1 提取:', text.substring(0, 50));
        return text;
      }
    }
  }
  
  // 方法2: 查找 message-content 中的响应文本
  const messageContents = document.querySelectorAll('message-content, .message-content');
  console.log('[Gemini Content] message-content 数量:', messageContents.length);
  if (messageContents.length > 0) {
    // 从后往前找新响应
    for (let i = messageContents.length - 1; i >= 0; i--) {
      const text = messageContents[i].textContent.trim();
      // 排除我们发送的 prompt，且必须是新响应
      if (text.length > 10 && !text.includes('你现在是一个') && !text.includes('你是一个社交媒体达人') && isNewResponse(text)) {
        console.log('[Gemini Content] 方法2 提取:', text.substring(0, 50));
        return text;
      }
    }
  }
  
  // 方法3: 查找 markdown 内容
  const markdownPanels = document.querySelectorAll('.markdown-main-panel, .markdown, [class*="markdown"]');
  console.log('[Gemini Content] markdown 面板数量:', markdownPanels.length);
  if (markdownPanels.length > 0) {
    for (let i = markdownPanels.length - 1; i >= 0; i--) {
      const text = markdownPanels[i].textContent.trim();
      if (text.length > 10 && !text.includes('你现在是一个') && !text.includes('你是一个社交媒体达人') && isNewResponse(text)) {
        console.log('[Gemini Content] 方法3 提取:', text.substring(0, 50));
        return text;
      }
    }
  }
  
  // 方法3: 查找对话气泡中的文本
  const responseDivs = document.querySelectorAll('[class*="response"], [class*="message-content"]');
  for (let i = responseDivs.length - 1; i >= 0; i--) {
    const div = responseDivs[i];
    const text = div.textContent.trim();
    // 排除用户输入（通常较短或包含我们的 prompt 关键词）
    if (text.length > 10 && text.length < 500 && !text.includes('你现在是一个')) {
      return text;
    }
  }
  
  // 方法4: 查找所有 p 标签，找到对话区域的内容
  const mainContent = document.querySelector('main, [role="main"], .main-content');
  if (mainContent) {
    const paragraphs = mainContent.querySelectorAll('p, span');
    for (let i = paragraphs.length - 1; i >= 0; i--) {
      const text = paragraphs[i].textContent.trim();
      if (text.length > 10 && text.length < 300) {
        // 检查是否像是 AI 回复
        if (!text.includes('你现在是一个') && !text.includes('请根据')) {
          return text;
        }
      }
    }
  }
  
  return '';
}

// 检查是否正在生成（有 loading/thinking 指示器）
function isGenerating() {
  // 方法1: 检查停止按钮（最可靠）
  const stopBtn = document.querySelector('button[aria-label*="Stop generating"], button[aria-label*="Stop"]');
  if (stopBtn && stopBtn.offsetParent !== null && !stopBtn.disabled) {
    console.log('[Gemini Content] 检测到停止按钮');
    return true;
  }
  
  // 方法2: 检查特定的 loading 动画
  const loadingDots = document.querySelector('.loading-dots, [class*="thinking-indicator"], mat-spinner');
  if (loadingDots && loadingDots.offsetParent !== null) {
    console.log('[Gemini Content] 检测到 loading 动画');
    return true;
  }
  
  // 方法3: 检查消息是否还在变化（通过比较内容长度）
  const responses = document.querySelectorAll('[data-message-author-role="model"], .model-response-text');
  if (responses.length > 0) {
    const lastResponse = responses[responses.length - 1];
    const text = lastResponse.textContent;
    // 如果文本以省略号或不完整的句子结尾，可能还在生成
    if (text && (text.endsWith('...') || text.endsWith('…'))) {
      console.log('[Gemini Content] 检测到文本还在更新');
      return true;
    }
  }
  
  return false;
}

// ==================== 发送 Prompt ====================
async function sendPrompt(prompt) {
  console.log('[Gemini Content] 准备发送 prompt');
  chrome.runtime.sendMessage({ type: 'GEMINI_STATUS', status: '正在查找输入框...' });
  
  // 记录发送前的消息数量（用于后面验证）
  const messagesBefore = document.querySelectorAll('message-content, .message-content').length;
  console.log('[Gemini Content] 发送前消息数量:', messagesBefore);
  
  // 记录发送前的最后一条响应内容
  lastMessageCount = messagesBefore;
  previousResponseText = extractLastResponse() || '';
  console.log('[Gemini Content] 发送前最后响应:', previousResponseText.substring(0, 30));
  
  // 查找输入框
  const inputBox = findInputBox();
  if (!inputBox) {
    console.error('[Gemini Content] 找不到输入框');
    console.log('[Gemini Content] contenteditable 元素:', document.querySelectorAll('[contenteditable="true"]'));
    chrome.runtime.sendMessage({ 
      type: 'GEMINI_ERROR', 
      error: '找不到 Gemini 输入框' 
    });
    return false;
  }
  
  console.log('[Gemini Content] 找到输入框:', inputBox.tagName, inputBox.className);
  chrome.runtime.sendMessage({ type: 'GEMINI_STATUS', status: '正在输入...' });
  
  // 使用模拟输入
  const inputSuccess = await simulateTyping(inputBox, prompt);
  console.log('[Gemini Content] 输入结果:', inputSuccess);
  console.log('[Gemini Content] 输入框内容:', inputBox.innerText.substring(0, 50));
  
  if (!inputSuccess) {
    // 最后手段: innerHTML
    console.log('[Gemini Content] 尝试最后手段 innerHTML');
    inputBox.innerHTML = `<p>${prompt}</p>`;
    inputBox.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
  
  await sleep(500);
  
  // 查找发送按钮 - 使用更多选择器
  chrome.runtime.sendMessage({ type: 'GEMINI_STATUS', status: '正在发送...' });
  
  // 等待之前的生成完成（如果有的话），但最多等 5 秒
  let waitCount = 0;
  while (isGenerating() && waitCount < 5) {
    console.log('[Gemini Content] 等待上一次生成完成...', waitCount);
    await sleep(1000);
    waitCount++;
  }
  
  // 如果还在生成，强制继续（不要等太久）
  if (isGenerating()) {
    console.log('[Gemini Content] 上一次生成仍在进行，强制继续发送新请求');
  }
  
  const allButtons = document.querySelectorAll('button');
  console.log('[Gemini Content] 页面按钮数量:', allButtons.length);
  
  let sendButton = null;
  
  // 方法1: 直接查找 submit 类的发送按钮（最准确）
  sendButton = document.querySelector('button.send-button.submit:not(.stop)');
  if (sendButton) {
    console.log('[Gemini Content] 方法1 找到 submit 按钮');
  }
  
  // 方法2: 通过 aria-label 查找（支持多语言）
  if (!sendButton) {
    sendButton = document.querySelector('button[aria-label*="送信"], button[aria-label*="Send"], button[aria-label*="send"], button[aria-label*="发送"], button[aria-label*="Submit"]');
    if (sendButton && !sendButton.className.includes('stop')) {
      console.log('[Gemini Content] 方法2 通过 aria-label 找到');
    } else {
      sendButton = null;
    }
  }
  
  // 方法3: 查找 send-button 类但排除 stop 类
  if (!sendButton) {
    const sendBtnByClass = document.querySelector('button.send-button:not(.stop)');
    if (sendBtnByClass) {
      sendButton = sendBtnByClass;
      console.log('[Gemini Content] 方法3 通过 class 找到');
    }
  }
  
  // 方法4: 查找底部区域带 SVG 的按钮（排除 stop）
  if (!sendButton) {
    for (const btn of allButtons) {
      if (btn.className.includes('stop')) continue;
      if (btn.disabled) continue;
      
      const rect = btn.getBoundingClientRect();
      if (rect.bottom > window.innerHeight - 200 && btn.querySelector('svg')) {
        const ariaLabel = btn.getAttribute('aria-label') || '';
        if (!ariaLabel.toLowerCase().includes('stop') && !ariaLabel.includes('停止')) {
          console.log('[Gemini Content] 方法4 找到底部按钮:', btn.className);
          sendButton = btn;
          break;
        }
      }
    }
  }
  
  // 方法4: 不再使用右下角按钮查找，容易误选全屏按钮
  
  if (sendButton && !sendButton.disabled && !sendButton.className.includes('stop')) {
    console.log('[Gemini Content] 点击发送按钮:', sendButton.className);
    sendButton.click();
    await sleep(500);
  } else {
    console.log('[Gemini Content] 没找到发送按钮，尝试多种 Enter 方式');
    
    // 确保输入框有焦点
    inputBox.focus();
    await sleep(100);
    
    // 方式1: 在输入框上触发 Enter
    inputBox.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
    }));
    
    await sleep(50);
    
    inputBox.dispatchEvent(new KeyboardEvent('keypress', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }));
    
    await sleep(50);
    
    inputBox.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
    }));
    
    await sleep(200);
    
    // 方式2: 查找表单并提交
    const form = inputBox.closest('form');
    if (form) {
      console.log('[Gemini Content] 找到表单，尝试提交');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    
    await sleep(200);
    
    // 方式3: 最后尝试点击任何看起来像发送的元素
    const submitElements = document.querySelectorAll('[type="submit"], [aria-label*="Send"], [aria-label*="发送"], [aria-label*="送信"], button[class*="submit"]');
    for (const el of submitElements) {
      if (!el.disabled && !el.className.includes('stop') && !el.className.includes('fullscreen')) {
        console.log('[Gemini Content] 尝试点击 submit 元素:', el.className);
        el.click();
        break;
      }
    }
  }
  
  // 验证发送是否成功：等待并检查输入框是否清空
  await sleep(1000);
  const inputAfterSend = findInputBox();
  const contentAfterSend = inputAfterSend?.innerText?.trim() || '';
  console.log('[Gemini Content] 发送后输入框内容长度:', contentAfterSend.length);
  
  if (contentAfterSend.length > 50) {
    // 输入框还有内容，说明发送失败，重试
    console.log('[Gemini Content] 发送似乎失败，输入框仍有内容，重试点击发送按钮');
    
    // 再次查找发送按钮
    const retryBtn = document.querySelector('button.send-button.submit:not(.stop)') ||
                     document.querySelector('button[aria-label*="送信"]:not(.stop)') ||
                     document.querySelector('button[aria-label*="Send"]:not(.stop)');
    
    if (retryBtn && !retryBtn.disabled) {
      console.log('[Gemini Content] 重试点击:', retryBtn.className);
      retryBtn.click();
      await sleep(500);
    }
  }
  
  // 最终检查：输入框是否已清空
  const finalCheck = findInputBox();
  const finalContent = finalCheck?.innerText?.trim() || '';
  
  if (finalContent.length > 50) {
    console.error('[Gemini Content] 发送失败！输入框仍有内容');
    chrome.runtime.sendMessage({ 
      type: 'GEMINI_ERROR', 
      error: 'Prompt 发送失败，请检查 Gemini 页面' 
    });
    return false;
  }
  
  console.log('[Gemini Content] Prompt 已发送，开始监听响应');
  
  // 开始监听响应
  chrome.runtime.sendMessage({ type: 'GEMINI_STATUS', status: '等待 AI 响应...' });
  isWaitingForResponse = true;
  stableCount = 0;
  lastResponseText = '';
  
  startPolling();
  
  return true;
}

// ==================== 轮询检测响应 ====================
function startPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
  }
  
  let timeoutCounter = 0;
  const maxTimeout = 90; // 90秒超时
  
  pollInterval = setInterval(() => {
    if (!isWaitingForResponse) {
      clearInterval(pollInterval);
      return;
    }
    
    timeoutCounter++;
    
    // 检查消息数量是否增加
    const currentMessageCount = document.querySelectorAll('message-content, .message-content').length;
    const hasNewMessage = currentMessageCount > lastMessageCount;
    
    console.log(`[Gemini Content] Polling #${timeoutCounter}, 消息数: ${lastMessageCount} -> ${currentMessageCount}, 有新消息: ${hasNewMessage}`);
    
    // 检查超时
    if (timeoutCounter > maxTimeout) {
      console.log('[Gemini Content] 响应超时');
      isWaitingForResponse = false;
      clearInterval(pollInterval);
      chrome.runtime.sendMessage({ 
        type: 'GEMINI_ERROR', 
        error: 'Gemini 响应超时' 
      });
      return;
    }
    
    // 如果消息数量没有增加，说明新响应还没出现
    if (!hasNewMessage) {
      // 检查是否还在生成
      if (isGenerating()) {
        console.log('[Gemini Content] AI 正在生成...');
      }
      return;
    }
    
    // 消息数量增加了，检查是否还在生成
    const generating = isGenerating();
    if (generating) {
      console.log('[Gemini Content] 新消息出现，但还在生成中...');
      stableCount = 0;
      return;
    }
    
    // 提取最新的响应（最后一条消息）
    const messageContents = document.querySelectorAll('message-content, .message-content');
    if (messageContents.length === 0) return;
    
    const lastMessage = messageContents[messageContents.length - 1];
    const currentText = lastMessage.textContent.trim();
    
    // 排除 prompt（包含我们的关键词）
    if (currentText.includes('你是一个社交媒体达人') || currentText.includes('推文内容')) {
      console.log('[Gemini Content] 最后一条是 prompt，继续等待');
      return;
    }
    
    console.log('[Gemini Content] 提取到新响应，长度:', currentText.length);
    
    // 特殊处理：如果响应是 "false"（内容过滤），直接发送
    if (currentText.toLowerCase() === 'false') {
      console.log('[Gemini Content] 检测到内容过滤响应 (false)，直接发送');
      isWaitingForResponse = false;
      clearInterval(pollInterval);
      sendResponse(currentText);
      return;
    }
    
    if (currentText && currentText.length > 5) {
      // 检查文本是否稳定（连续2次相同）
      if (currentText === lastResponseText) {
        stableCount++;
        console.log(`[Gemini Content] 响应稳定检测: ${stableCount}/2`);
        
        if (stableCount >= 2) {
          // 响应已稳定，发送结果
          console.log('[Gemini Content] 响应已稳定，准备发送');
          isWaitingForResponse = false;
          clearInterval(pollInterval);
          sendResponse(currentText);
        }
      } else {
        console.log('[Gemini Content] 新响应内容:', currentText.substring(0, 50));
        lastResponseText = currentText;
        stableCount = 1;
      }
    }
  }, 1000);
}

function sendResponse(text) {
  // 清理文本
  let cleanText = text
    .replace(/^["'「」『』]|["'「」『』]$/g, '') // 移除引号
    .replace(/^(回复|Reply)[：:]\s*/i, '') // 移除前缀
    .replace(/^\*\*.*?\*\*\s*/, '') // 移除 markdown 粗体标题
    .split('\n')[0] // 只取第一行
    .trim();
  
  // 限制长度
  if (cleanText.length > 150) {
    cleanText = cleanText.substring(0, 150);
  }
  
  console.log('[Gemini Content] 发送响应:', cleanText);
  
  chrome.runtime.sendMessage({
    type: 'GEMINI_RESPONSE',
    text: cleanText,
  });
}

// ==================== 消息监听 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Gemini Content] ★★★ 收到消息:', message.type);
  
  if (message.type === 'SEND_PROMPT') {
    console.log('[Gemini Content] 开始处理 SEND_PROMPT');
    console.log('[Gemini Content] Prompt 长度:', message.prompt?.length);
    
    sendPrompt(message.prompt).then(success => {
      console.log('[Gemini Content] sendPrompt 完成, success:', success);
      sendResponse({ success });
    }).catch(err => {
      console.error('[Gemini Content] sendPrompt 错误:', err);
      sendResponse({ success: false, error: err.message });
    });
    
    return true; // 保持 sendResponse 有效
  }
  
  if (message.type === 'CHECK_READY') {
    const inputBox = findInputBox();
    console.log('[Gemini Content] CHECK_READY, 输入框存在:', !!inputBox);
    sendResponse({ ready: !!inputBox });
    return true;
  }
  
  return false;
});

// ==================== 初始化 ====================
function init() {
  console.log('[Gemini Content] 初始化中...');
  
  const checkReady = setInterval(() => {
    const inputBox = findInputBox();
    if (inputBox) {
      clearInterval(checkReady);
      console.log('[Gemini Content] Gemini 页面已就绪');
      chrome.runtime.sendMessage({ type: 'GEMINI_STATUS', status: 'Gemini 已就绪' });
    }
  }, 1000);
  
  setTimeout(() => clearInterval(checkReady), 30000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

} // 结束防重复注入的 else 块
