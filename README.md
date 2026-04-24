# LLM 网页翻译（Chrome 扩展）

使用大模型翻译网页内容的 Chrome 浏览器扩展，支持：

- **OpenAI 协议**：OpenAI、DeepSeek、Moonshot、智谱、SiliconFlow、OpenRouter 等所有 OpenAI 兼容服务
- **Anthropic 协议**：Claude（Opus / Sonnet / Haiku 等）

## 功能

- 整页翻译 / 划词翻译
- 双语对照 或 替换原文 两种显示方式
- 右键菜单 + 快捷键（`Alt+T` 翻译整页，`Alt+S` 翻译选区）
- 批量打包请求 + 并发控制，提升大段文本翻译速度
- API Key、Base URL、模型名、System Prompt、Temperature 全可配置

## 安装

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本目录
4. 点击工具栏中的扩展图标 → 「设置」，填入 API Key 与 Base URL（可选预设服务商）

## 使用

- 点击工具栏图标 → 「翻译当前页面」
- 在页面上选中一段文本 → 右键「翻译选中文本」，或按 `Alt+S`
- 按 `Alt+T` 一键翻译整页
- 「恢复原文」按钮可还原页面

## 项目结构

```
manifest.json     扩展清单（MV3）
background.js     Service Worker：菜单、快捷键、调用 LLM API
content.js        内容脚本：抽取文本、注入译文、UI 弹窗
content.css       内容脚本样式
popup.html/.js/.css   工具栏弹窗（快速控制）
options.html/.js/.css 设置页
icons/            扩展图标
```

## 注意

- `chrome://`、Chrome 网上应用店等内部页面无法注入内容脚本，无法翻译。
- 本扩展通过 Service Worker 调用 API 以避免页面级 CORS 限制。
- 翻译以 JSON 数组形式批量请求，要求模型严格输出同长度数组；如使用自有模型，请确保其能稳定遵循该指令（见 System Prompt）。
