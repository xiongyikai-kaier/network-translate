# 隐私政策 — AI 网页翻译

最后更新：2026-04-25

「AI 网页翻译」（以下简称"本扩展"）尊重并保护用户的隐私。本文档说明本扩展如何处理用户数据。

## 我们不收集任何个人数据

本扩展**不会**向开发者的任何服务器发送数据。开发者无法访问、读取或存储用户的任何信息。本扩展不包含任何第三方追踪、统计或分析代码。

## 数据如何被使用

1. **用户设置（API Key、目标语言、显示方式等）**：仅保存在 Chrome 提供的本地（`chrome.storage.local`）和同步（`chrome.storage.sync`）存储中，作用范围仅限本机以及用户登录的同一 Chrome 账号同步范围内。
2. **网页文本翻译请求**：用户主动触发翻译时，被翻译的网页文本由浏览器**直接**发送至用户在设置中自行配置的第三方大语言模型（LLM）服务商 API 端点（例如 OpenAI、智谱 AI、DeepSeek、Anthropic 等），该过程不经过开发者的任何服务器或中转。
3. **翻译缓存**：为了避免重复请求 API、节省 Token 与提升速度，已翻译的"原文 ↔ 译文"键值会缓存在 Chrome 本地存储（`chrome.storage.local`）中。用户可在扩展设置页面随时清空缓存或调整缓存上限。
4. **划词 / 选区翻译**：用户主动选中文本并触发翻译时，仅将该选中文本作为翻译请求发送给用户已配置的 LLM API。

## 权限说明

- `storage`：用于持久化保存用户设置与翻译缓存。
- `activeTab` + `scripting`：仅在用户主动触发翻译时，向当前活动标签页注入脚本以提取与替换文本。
- `host_permissions: <all_urls>`：允许用户在任意网站上使用翻译功能；扩展不会主动后台访问任意站点，仅在用户点击翻译、划词或访问已加入"自动翻译白名单"的页面时才会执行翻译流程。

## 第三方服务

本扩展会按用户配置将文本发送至用户自行选择的 LLM 服务商 API。请阅读你所配置的服务商的隐私政策，以了解他们如何处理你发送的文本。常见服务商隐私政策：

- OpenAI: https://openai.com/policies/privacy-policy
- Anthropic: https://www.anthropic.com/privacy
- 智谱 AI: https://www.bigmodel.cn/static/legal/Privacy-Policy.html
- DeepSeek: https://www.deepseek.com/privacy
- Moonshot: https://www.moonshot.cn/privacy

（如使用其它服务商，请参阅对应官方隐私政策。）

## 数据出售或转让

本扩展开发者**不会**出售、转让或以任何形式向第三方共享用户数据，因为开发者本身从未接收任何用户数据。

## 联系方式

如有任何隐私相关问题，请通过 Chrome Web Store 商品页面的"开发者反馈"渠道，或本项目 GitHub 仓库的 Issues 联系。

项目主页：https://github.com/xiongyikai-kaier/network-translate
