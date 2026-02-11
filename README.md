# Twitter AI Bot - Chrome 插件 (Side Panel 模式)

自动识别 X (Twitter) 热门推文，通过 Gemini 网页版生成高质量回帖。

## 架构设计

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Twitter 页面   │     │   Background     │     │   Gemini 页面    │
│  (content.js)    │────▶│  Service Worker  │────▶│ (gemini-content) │
│                  │◀────│   (background)   │◀────│                  │
└──────────────────┘     └────────┬─────────┘     └──────────────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │   Side Panel     │
                         │  (控制中心/日志) │
                         └──────────────────┘
```

## 功能特性

- **Side Panel 控制中心**：实时查看状态、日志、统计
- **无需 API Key**：直接使用 Gemini 网页版（需登录 Google 账号）
- **智能语言识别**：自动检测推文语言，回复保持一致
- **热门帖筛选**：只回复点赞/转发超过阈值的推文
- **反检测机制**：
  - 3-7秒随机延迟后再填入回复
  - 模拟键盘逐字输入
  - 每小时回复上限 15 条

## 安装步骤

1. **准备图标文件**（可选）
   ```
   icons/
   ├── icon16.png  (16x16)
   ├── icon48.png  (48x48)
   └── icon128.png (128x128)
   ```

2. **加载插件**
   - 打开 Chrome，访问 `chrome://extensions/`
   - 开启右上角的「开发者模式」
   - 点击「加载已解压的扩展程序」
   - 选择本项目文件夹

3. **使用插件**
   - 访问 twitter.com 或 x.com
   - 点击工具栏上的插件图标，打开侧边栏
   - 在侧边栏中点击「打开 Gemini」
   - 确保在 Gemini 页面已登录
   - 热门推文下方会出现「🤖 AI」按钮

## 文件结构

```
twitter-ai-bot/
├── manifest.json       # Manifest V3 配置
├── background.js       # Service Worker (消息路由)
├── content.js          # Twitter 页面脚本
├── gemini-content.js   # Gemini 页面脚本
├── sidepanel.html      # 侧边栏 UI
├── sidepanel.js        # 侧边栏逻辑
├── styles.css          # Twitter 页面样式
└── icons/              # 扩展图标
```

## 消息流程

1. **用户点击「🤖 AI」按钮**
   - `content.js` 提取推文内容
   - 发送 `GENERATE_REPLY` 到 `background.js`

2. **Background 处理请求**
   - 构建 Prompt
   - 转发到 `gemini-content.js`

3. **Gemini 生成回复**
   - `gemini-content.js` 填入 Prompt
   - 监听 DOM 等待响应完成
   - 发送 `GEMINI_RESPONSE` 到 `background.js`

4. **填入 Twitter**
   - `background.js` 等待 3-7 秒
   - 发送 `FILL_REPLY` 到 `content.js`
   - 模拟键盘输入并发送

## 配置说明

| 选项 | 默认值 | 说明 |
|------|--------|------|
| 启用自动回复 | 关闭 | 开启后自动回复热门帖 |
| 点赞阈值 | 100 | 只处理点赞数大于此值的推文 |
| 转发阈值 | 50 | 只处理转发数大于此值的推文 |
| 每小时上限 | 10 | 防止过于频繁回复 |

## 关于 CSP 限制

Gemini 网页版有 `X-Frame-Options: SAMEORIGIN` 限制，无法通过 iframe 嵌入。

本插件的解决方案：
- Side Panel 作为控制中心（显示状态和日志）
- Gemini 在独立标签页中打开（可以放在后台）
- 通过 Content Script 注入到 Gemini 页面进行 DOM 操作
- 使用 Background Service Worker 作为消息中转站

## 注意事项

- 请合理使用，避免账号受限
- 首次使用请确保 Gemini 已登录
- 如果 Gemini DOM 结构变化，可能需要更新选择器
- 建议在测试账号上先试用

## License

MIT
