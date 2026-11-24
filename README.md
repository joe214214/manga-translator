# Manga Translator

中文 | [English](./README_EN.md)

一个基于 Manifest V3 的 Chrome / Edge 浏览器扩展，用于在阅读日文网页漫画时自动识别台词并将译文覆盖在原气泡位置。支持常见的图片和 Canvas 阅读器（如少年 Jump+）。

## 工作原理

- **翻页检测**：监听滚动、方向键、点击翻页和页面变化，防抖后截取当前漫画区域，并通过画面指纹跳过重复页面。
- **本地 OCR**：在扩展的 Offscreen Document 中运行离线 Tesseract.js（`jpn_vert` 竖排模型与 `jpn` 横排模型），不消耗大模型 Token。预处理阶段会自动剥离日文旁注振假名（ルビ），同时支持常规白底气泡和带白描边的花纹背景文字。
- **文本翻译**：整页台词合并为单次请求发送，内置本地缓存。支持使用免费的 Gemini API Key 或 Google Cloud Translation API Key（二选一），可将日文译为简体中文、繁体中文、英文或韩文。
- **页面嵌字**：根据原气泡方向自动切换竖排（`vertical-rl`）或横排排版，自动缩放字号。鼠标悬停可查看识别出的日文原文，点击气泡可在译文和原图之间切换。

## 安装与使用

仓库已包含运行所需的 Tesseract WASM 文件和日语语言包，克隆后可直接加载：

```bash
git clone https://github.com/joe214214/manga-translator.git
```

1. 打开 `chrome://extensions/` 或 `edge://extensions/`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本仓库根目录。
3. 点击浏览器工具栏中的扩展图标打开设置面板，填写以下任意一个密钥并保存：
   - **Gemini API Key**：可在 [Google AI Studio](https://aistudio.google.com/apikey) 免费生成。
   - **Google Cloud Translation API Key**：在 [Google Cloud Console](https://console.cloud.google.com/apis/credentials) 创建并启用 Cloud Translation API。
4. 打开日文漫画网页，翻页时会自动触发翻译，也可以在弹窗中点击「立即翻译当前页」。

注：API Key 仅保存在本地浏览器的 `chrome.storage.sync` 中。

## 目录结构

```text
├── manifest.json            # 扩展配置 (Manifest V3)
├── background/              # 截图调度、缓存与翻译请求
├── offscreen/               # 图像预处理与本地 Tesseract OCR
├── content/                 # 翻页监听与页面嵌字渲染
├── popup/                   # 扩展设置面板
├── styles/                  # 覆盖层样式
├── lib/tesseract/           # 离线 WASM 核心与 jpn / jpn_vert 模型
├── test/index.html          # 本地静态漫画测试页
└── setup.js                 # 重新拉取 OCR 依赖与生成图标的脚本
```

## 本地开发与测试

如需重新生成 `lib/tesseract/` 下的依赖文件与图标：

```bash
npm install
npm run setup
```

本地测试可在浏览器中打开 `test/index.html`（需在扩展详情页开启「允许访问文件网址」），翻页或点击扩展弹窗中的翻译按钮查看效果。

## License

MIT
