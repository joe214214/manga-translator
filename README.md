# 🎌 漫画翻译器 (Manga Translator)

基于 **Chrome / Edge Extension Manifest V3** 开发的实时日文漫画嵌字翻译扩展。支持在少年 Jump+（`shonenjumpplus.com`）等在线漫画阅读器（兼容 `<canvas>` 与 `<img>` 渲染）中边翻页边自动检测日文台词、离线 OCR 识别、批量机器翻译，并以自适应横竖排嵌字的方式直接覆盖在原漫画气泡位置。

---

## ✨ 核心特性

- **📸 自动翻页感知与防抖调度**
  - 自动监听滚轮滚动、方向键翻页、点击翻页及 SPA 页面 DOM 变化，结合画面像素指纹去重缓存，避免重复识别与闪烁。
- **🧠 零 AI Token 本地双通道 OCR 引擎（V3.5）**
  - 全程运行于扩展 Offscreen Document（`Tesseract.js` WebAssembly 离线双模型：竖排专用 `jpn_vert` + 横排/细体回退 `jpn`），**日常识别消耗 0 AI Token**：
  - **通道一（纯白对话框通道）**：高精度连通域笔画与浊点聚合、多横画汉字（如 `二`、`三`）结构合并，并通过二维中值字号比自动剥离日文旁注振假名（ルビ），大幅提升汉字识别准确率。
  - **通道二（花哨图案背景 `白フチ` 文字通道）**：针对花卉、向日葵、格纹、网点等半透明装饰框内带白色描边的黑色台词，利用局部背景灰度纹理与紧贴白描边光环定位文字，并自动掩码抹除图案底纹干扰。
  - **多重回退校验**：针对长短列悬殊的角色介绍框支持逐列独立 `jpn_vert` 识别拼接；针对细体假名支持对比度增强二次校验。
- **🌐 双翻译通道（二选一即可）**
  - **Google Gemini API（推荐 · 免费免绑卡）**：通过 Google AI Studio 免费申请 API Key，支持整页台词单次 JSON 批量上下文翻译，并可在低置信度时可选启用 Gemini Vision 视觉兜底。
  - **Google Cloud Translation API v2（可选 · 传统 NMT）**：按字符计费（每月前 50 万字符免费），内置 HTTP 5xx 自动重试、单页批量合并请求与本地 LRU 翻译缓存。
  - 支持将日文漫画翻译为 **简体中文**、**繁體中文**、**English**、**한국어**。
- **✏️ 原生级漫画嵌字与交互体验**
  - 自动区分竖排（CSS `writing-mode: vertical-rl`）与横排气泡，采用真实渲染边界二分搜索算法自适应缩放字号，确保译文饱满且不溢出对话框。
  - 常规气泡采用边缘羽化白底无痕遮罩，花哨装饰框采用圆角白底卡片遮罩，完整保留漫画分镜线与气泡尖角。
  - **悬停查看原文**：鼠标悬停在任意已翻译气泡上即可查看识别出的日文原文与 OCR 置信度。
  - **点击切换原图**：左键点击任意气泡可在「中文嵌字」与「原始日文画面」之间即时切换。
  - **防浏览器二次翻译保护**：嵌字覆盖层内置 `translate="no"` 与 `notranslate` 标记，防止 Chrome / Edge 自带「整页翻译」把已译好的中文当成日文汉字再次错误翻译。

---

## 📁 项目结构

```text
manga-translator/
├── manifest.json              # Chrome / Edge 扩展清单 (Manifest V3)
├── package.json               # 开发与初始化脚本配置
├── setup.js                   # 离线 OCR WASM 核心、训练模型与图标一键部署脚本
├── background/
│   └── service-worker.js      # 后台服务：截图调度、画面指纹缓存、翻译与 AI 兜底 API
├── offscreen/
│   ├── offscreen.html         # Offscreen 离屏文档容器
│   └── offscreen.js           # V3.5 双通道漫画文字检测、振假名剥离与 Tesseract 双模型 OCR
├── content/
│   └── content.js             # 阅读器视口检测、翻页防抖捕捉、自适应嵌字渲染与交互
├── styles/
│   └── overlay.css            # 嵌字排版样式、羽化遮罩、悬停原文浮窗与加载动效
├── popup/
│   ├── popup.html             # 扩展设置弹窗界面
│   ├── popup.css              # 设置弹窗样式
│   └── popup.js               # API Key 与识别参数持久化（chrome.storage.sync）
├── lib/
│   └── tesseract/             # 离线 Tesseract.js WASM 核心及 jpn / jpn_vert 语言模型
├── icons/                     # 扩展图标 (16 / 48 / 128 px)
├── test/
│   └── index.html             # 本地模拟日本漫画分镜翻页测试页
└── run-live-browser-test.js   # 基于 Puppeteer + Edge 的自动化实机测试脚本
```

---

## 🚀 安装与使用指南

### 1. 获取项目代码

仓库已内置 `lib/tesseract/` 离线 WASM 引擎与日语横竖排模型（`jpn` / `jpn_vert`），克隆后**无需编译即可直接加载使用**：

```bash
git clone https://github.com/joe214214/manga-translator.git
```

> 如需重新从 `node_modules` 与官方源拉取最新 WASM 核心和训练数据，可在项目根目录执行：
> ```bash
> npm install
> npm run setup
> ```

### 2. 加载扩展到 Chrome 或 Edge 浏览器

1. 打开浏览器扩展管理页：
   - **Chrome**：地址栏输入 `chrome://extensions/`
   - **Edge**：地址栏输入 `edge://extensions/`
2. 开启页面右上角（或左侧栏）的 **「开发者模式 (Developer mode)」**。
3. 点击 **「加载已解压的扩展程序 (Load unpacked)」**。
4. 选择克隆下来的项目根目录（包含 `manifest.json` 的文件夹）。

### 3. 配置 API Key（安全存储在本地浏览器）

> 🔒 **安全说明**：本项目源码中不包含任何硬编码密钥。你填写的 API Key 仅通过浏览器官方 `chrome.storage.sync` 保存在你自己的浏览器本地配置中，不会上传至任何第三方服务器。

1. 点击浏览器工具栏右上角的扩展图标，打开 **「漫画翻译器」** 设置面板。
2. 在 **API 密钥（二选一即可）** 中填写其中一个：
   - **方式 A（推荐）：Gemini API Key** —— 前往 [Google AI Studio](https://aistudio.google.com/apikey) 登录账号即可免费生成（无需绑定信用卡）。
   - **方式 B：Google Cloud Translation API Key** —— 前往 [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials) 创建并启用 Cloud Translation API。
3. 选择目标语言（默认 `简体中文`），确认 **「启用翻译」** 开关处于开启状态，点击 **「💾 保存设置」**。
4. 打开任意在线日文漫画页面（或点击面板中的 **「▶️ 立即翻译当前页」**），滚动或翻页即可自动完成嵌字翻译！

---

## 🧪 本地快速测试

项目附带一个离线漫画分镜测试页 `test/index.html`：

1. 在扩展管理页确认如要在本地 `file://` 页面测试，已勾选扩展详情里的 **「允许访问文件网址 (Allow access to file URLs)」**。
2. 使用浏览器打开项目内的 `test/index.html`。
3. 点击页面下方的 **「下一页 ▶」** 或扩展弹窗中的 **「▶️ 立即翻译当前页」**，即可验证横排/竖排对话框识别、嵌字缩放与点击切换原图效果。

---

## 📄 License

MIT License
