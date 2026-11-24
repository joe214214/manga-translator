/**
 * service-worker.js — Chrome 插件后台 Service Worker
 * 
 * 职责：
 * 1. 接收 content script 的截图/翻译请求
 * 2. 调用 chrome.tabs.captureVisibleTab 截取屏幕
 * 3. 管理 offscreen document（用于 OCR 处理）
 * 4. 调用 Google Translate API 进行翻译
 * 5. 调用 Gemini Vision API 进行 AI 兜底 OCR
 * 6. 将翻译结果发回 content script
 */

// ============ 状态管理 ============

let offscreenReady = false;
let translationCache = new Map(); // 简单内存缓存: 日文 → 中文
const activeTabsProcessing = new Set(); // 并发锁，防止同一标签页重复触发 OCR 管道
const lastCapturedFingerprint = new Map(); // 画面指纹缓存: tabId → { hash, response }

/**
 * 计算图像高区分度指纹（跳过 PNG 头部固定字节，对主体均匀采样 256 点计算 FNV-1a 哈希）
 */
function computeFingerprint(dataUrl) {
  if (!dataUrl) return '';
  const len = dataUrl.length;
  const start = Math.min(200, Math.floor(len * 0.05));
  const end = Math.max(start + 1, Math.floor(len * 0.95));
  const step = Math.max(1, Math.floor((end - start) / 256));
  let hash = 2166136261 >>> 0;
  hash = Math.imul(hash ^ len, 16777619) >>> 0;
  for (let i = start; i < end; i += step) {
    hash ^= dataUrl.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${len}:${hash.toString(16)}`;
}

// ============ 消息路由 ============

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 不处理发给 offscreen 的消息
  if (message.target === 'offscreen') return false;

  switch (message.type) {
    case 'CAPTURE_AND_TRANSLATE': {
      const tabId = sender.tab ? sender.tab.id : null;
      const windowId = sender.tab ? sender.tab.windowId : null;
      if (!tabId) {
        sendResponse({ success: false, error: '未找到有效漫画标签页' });
        return false;
      }

      handleCaptureAndTranslate(tabId, message.viewport, windowId, message.canvasDataUrl)
        .then(responseObj => {
          if (!responseObj) {
            sendResponse({ success: true, results: [], viewport: message.viewport });
            return;
          }
          sendResponse({
            success: true,
            results: responseObj.results || [],
            viewport: responseObj.viewport || message.viewport,
            imageWidth: responseObj.imageWidth,
            imageHeight: responseObj.imageHeight,
          });
        })
        .catch(err => {
          console.warn('[MangaTranslator] Pipeline handled with error:', err.message || err);
          sendResponse({ success: false, error: err.message || String(err) });
        });
      return true; // 保持长连接通道，等待直接回复 content script
    }

    case 'TRANSLATE_NOW':
      handleTranslateNow(message.tabId);
      sendResponse({ success: true });
      return false;

    case 'SETTINGS_UPDATED':
      broadcastToContentScripts(message);
      sendResponse({ success: true });
      return false;

    case 'OFFSCREEN_READY':
      offscreenReady = true;
      sendResponse({ success: true });
      return false;

    default:
      return false;
  }
});

// ============ 核心翻译流水线 ============

/**
 * 主流程：截图 → OCR → 翻译 → 渲染
 */
async function handleCaptureAndTranslate(tabId, viewport, windowId = null, directImageDataUrl = null) {
  if (!tabId || activeTabsProcessing.has(tabId)) {
    console.log('[MangaTranslator] Already processing for tab', tabId);
    return;
  }
  activeTabsProcessing.add(tabId);

  try {
    console.log('[MangaTranslator] Starting capture & translate pipeline for tab:', tabId);

    // 验证标签页有效性
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      console.log('[MangaTranslator] Tab query error or tab closed:', tabId);
      return null;
    }

    if (!tab || !tab.active) {
      console.log('[MangaTranslator] Tab is not active (tabId:', tabId, '), skipping capture.');
      return null;
    }

    // 检查 URL 是否为受限页面
    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://'))) {
      console.log('[MangaTranslator] Skipping unsupported browser page:', tab.url);
      return null;
    }

    windowId = tab.windowId;

    // Step 1: 截取当前可见区域（50ms 完成，随后立即通知前端恢复覆盖层可见性，杜绝长达数秒的闪烁空白）
    let imageDataUrl = directImageDataUrl;
    if (!imageDataUrl) {
      try {
        imageDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
          format: 'png',
          quality: 100,
        });
      } catch (err) {
        console.warn('[MangaTranslator] Screenshot skipped or failed:', err.message);
        return null;
      } finally {
        chrome.tabs.sendMessage(tabId, { type: 'SCREENSHOT_TAKEN' }).catch(() => {});
      }
    }

    if (!imageDataUrl) {
      console.warn('[MangaTranslator] Empty image captured or provided');
      return null;
    }
    console.log('[MangaTranslator] Screenshot captured successfully');

    // 画面内容去重检查（若用户强制重翻 forceRefresh 则跳过指纹缓存）
    const currentFingerprint = computeFingerprint(imageDataUrl);
    const cachedRecord = lastCapturedFingerprint.get(tabId);
    if (!viewport?.forceRefresh && cachedRecord && cachedRecord.hash === currentFingerprint) {
      console.log('[MangaTranslator] Screen content unchanged, returning cached translation');
      return cachedRecord.response;
    }

    // Step 2: 创建/确认 offscreen document
    await ensureOffscreenDocument();

    // Step 3: 发送图像与视口漫画区域到 offscreen 进行 V3 OCR
    let ocrResults;
    try {
      ocrResults = await sendToOffscreen({
        type: 'PROCESS_IMAGE',
        target: 'offscreen',
        imageDataUrl: imageDataUrl,
        viewport: viewport,
      });
    } catch (err) {
      throw new Error('OCR 处理失败: ' + err.message);
    }

  // 检查 OCR 错误
  if (ocrResults && ocrResults.error) {
    throw new Error('OCR 错误: ' + ocrResults.error);
  }

  const rawBlocks = Array.isArray(ocrResults) ? ocrResults : (ocrResults?.results || []);
  const imageWidth = ocrResults?.imageWidth || null;
  const imageHeight = ocrResults?.imageHeight || null;

  console.log(`[MangaTranslator] OCR found ${rawBlocks.length} text blocks (Image: ${imageWidth}x${imageHeight})`);

  // 没有检测到文字
  if (rawBlocks.length === 0) {
    return { results: [], viewport, imageWidth, imageHeight };
  }

  // Step 4: 获取设置
  const settings = await chrome.storage.sync.get({
    googleApiKey: '',
    geminiApiKey: '',
    ocrThreshold: 60,
    targetLang: 'zh-CN',
  });

  // Step 5: AI 兜底 — 对低置信度的结果使用 Gemini Vision 重新识别
  if (settings.geminiApiKey) {
    const lowConfResults = rawBlocks.filter(r => r.confidence < settings.ocrThreshold);
    console.log(`[MangaTranslator] ${lowConfResults.length} blocks below confidence threshold`);

    // 限制每页最多 5 次 AI 调用，控制 token 消耗
    const maxAICalls = 5;
    let aiCallCount = 0;

    for (const result of lowConfResults) {
      if (aiCallCount >= maxAICalls) break;
      if (!result.croppedImageData) continue;

      try {
        const aiText = await geminiVisionOCR(settings.geminiApiKey, result.croppedImageData);
        if (aiText && aiText.length > 0) {
          result.text = aiText;
          result.source = 'gemini';
          aiCallCount++;
          console.log(`[MangaTranslator] AI OCR fallback: "${aiText}"`);
        }
      } catch (err) {
        console.warn('[MangaTranslator] Gemini OCR failed:', err.message);
      }
    }
  }

  // Step 6: 批量翻译（合并为单次 API 调用，节省费用）
  const validResults = rawBlocks.filter(r => r.text && r.text.trim().length > 0);

  if (validResults.length === 0) {
    return { results: [], viewport, imageWidth, imageHeight };
  }

  const textsToTranslate = validResults.map(r => r.text.trim());
  let translations;

  try {
    translations = await batchTranslate(
      textsToTranslate,
      settings.googleApiKey,
      settings.geminiApiKey,
      settings.targetLang
    );
  } catch (err) {
    throw new Error('翻译失败: ' + err.message);
  }

  // Step 7: 组装最终结果
  const finalResults = validResults.map((r, i) => ({
    bbox: r.bbox,
    isVertical: Boolean(r.isVertical),
    isFancy: Boolean(r.isFancy),
    originalText: r.text.trim(),
    translatedText: translations[i] || r.text.trim(),
    confidence: r.confidence,
    source: r.source || 'tesseract',
    bgColor: r.bgColor || '#ffffff',
  }));

  console.log(`[MangaTranslator] Returning ${finalResults.length} translated blocks to content script`);

  const finalResponse = {
    results: finalResults,
    viewport: viewport,
    imageWidth: imageWidth,
    imageHeight: imageHeight,
  };

  // 记录成功识别并翻译的画面指纹
  lastCapturedFingerprint.set(tabId, {
    hash: currentFingerprint,
    response: finalResponse,
  });

  return finalResponse;
  } finally {
    activeTabsProcessing.delete(tabId);
  }
}

/**
 * 立即翻译（来自 popup 的手动触发请求）
 */
async function handleTranslateNow(tabId) {
  try {
    if (!tabId) return;
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'REQUEST_IMMEDIATE_CAPTURE' });
      return;
    } catch (_) {
      // 若标签页在安装插件前已打开，动态注入样式与内容脚本后再触发
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['styles/overlay.css'],
      }).catch(() => {});
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js'],
      }).catch(() => {});
      await sleep(200);
      await chrome.tabs.sendMessage(tabId, { type: 'REQUEST_IMMEDIATE_CAPTURE' }).catch(() => {});
    }
  } catch (err) {
    console.warn('[MangaTranslator] TranslateNow error:', err);
  }
}

// ============ Offscreen Document 管理 ============

async function ensureOffscreenDocument() {
  // 检查是否已存在
  if ('hasDocument' in chrome.offscreen) {
    if (await chrome.offscreen.hasDocument()) return;
  } else if ('getContexts' in chrome.runtime) {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existingContexts && existingContexts.length > 0) return;
  }

  // 创建新的 offscreen document
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Tesseract.js OCR processing for manga text recognition',
    });
    console.log('[MangaTranslator] Offscreen document created');
  } catch (err) {
    if (!err.message.includes('already exists') && !err.message.includes('Only a single offscreen')) {
      throw err;
    }
  }

  // 等待 offscreen document 就绪
  const maxWait = 10000; // 最多等 10 秒
  const startTime = Date.now();
  while (!offscreenReady && (Date.now() - startTime) < maxWait) {
    await sleep(100);
  }
  offscreenReady = true;
}

/**
 * 发送消息到 offscreen document 并等待响应
 */
async function sendToOffscreen(message) {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (response !== undefined) return response;
    } catch (err) {
      console.warn(`[MangaTranslator] Offscreen message attempt ${attempt + 1} failed:`, err.message);
      if (attempt < maxRetries - 1) {
        await sleep(300 * (attempt + 1));
        // 尝试重新创建 offscreen document
        offscreenReady = false;
        await ensureOffscreenDocument();
      }
    }
  }
  throw new Error('Offscreen document not responding after retries');
}

// ============ Google Translate API ============

/**
 * 批量翻译 — 优先使用 Google Cloud API，无 Key 时无缝使用 Gemini API (免费免绑卡)
 * @param {string[]} texts - 要翻译的文本数组
 * @param {string} googleApiKey - Google Cloud Translation API Key
 * @param {string} geminiApiKey - Gemini API Key (可选免信用卡)
 * @param {string} targetLang - 目标语言代码（如 zh-CN）
 * @returns {string[]} 翻译结果数组
 */
async function batchTranslate(texts, googleApiKey, geminiApiKey, targetLang) {
  if (!texts || texts.length === 0) return [];

  if (!googleApiKey && !geminiApiKey) {
    return texts.map(() => '[请配置 API Key]');
  }

  // 从本地缓存中获取已翻译文本
  const results = new Array(texts.length);
  const uncachedIndices = [];
  const uncachedTexts = [];

  for (let i = 0; i < texts.length; i++) {
    const cacheKey = `${targetLang}:${texts[i]}`;
    if (translationCache.has(cacheKey)) {
      results[i] = translationCache.get(cacheKey);
    } else {
      uncachedIndices.push(i);
      uncachedTexts.push(texts[i]);
    }
  }

  console.log(`[MangaTranslator] Translation: ${texts.length} total, ${uncachedTexts.length} uncached`);

  // 没有需要翻译的新文本
  if (uncachedTexts.length === 0) return results;

  let newTranslations = [];

  // 通道 1: 如果配置了 Google Cloud Translation API Key
  if (googleApiKey) {
    let response = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch(
        `https://translation.googleapis.com/language/translate/v2?key=${googleApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            q: uncachedTexts,
            source: 'ja',
            target: targetLang,
            format: 'text',
          }),
        }
      );
      if (response.ok || response.status < 500 || attempt === 1) break;
      await sleep(350);
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData?.error?.message || `HTTP ${response.status}`;
      throw new Error(errorMsg);
    }

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    newTranslations = (data.data?.translations || []).map(t => t.translatedText);
  }
  // 通道 2: 如果配置了免绑卡的免费 Gemini API Key
  else if (geminiApiKey) {
    newTranslations = await geminiBatchTranslate(uncachedTexts, geminiApiKey, targetLang);
  }

  // 填充结果并更新缓存
  for (let i = 0; i < uncachedIndices.length; i++) {
    const translated = newTranslations[i] || uncachedTexts[i];
    const originalIndex = uncachedIndices[i];
    results[originalIndex] = translated;

    const cacheKey = `${targetLang}:${uncachedTexts[i]}`;
    translationCache.set(cacheKey, translated);
  }

  // LRU 缓存上限保护
  if (translationCache.size > 500) {
    const keysToDelete = [...translationCache.keys()].slice(0, 100);
    keysToDelete.forEach(k => translationCache.delete(k));
  }

  return results;
}

/**
 * 使用 Gemini 2.0 Flash Lite 进行免费批量翻译（免信用卡，支持 JSON 数组返回）
 */
async function geminiBatchTranslate(texts, apiKey, targetLang) {
  const langNames = {
    'zh-CN': 'Simplified Chinese (简体中文)',
    'zh-TW': 'Traditional Chinese (繁體中文)',
    'en': 'English',
    'ko': 'Korean',
  };
  const targetName = langNames[targetLang] || targetLang;

  const prompt = `You are a professional manga translator.
Translate the following array of Japanese phrases into natural, contextual ${targetName}.
Return ONLY a valid JSON array of strings in the exact same array order. Do not include markdown codeblocks or explanation.

Input array:
${JSON.stringify(texts)}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `Gemini API HTTP ${response.status}`);
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) return texts;

  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      return parsed.map((item, idx) => String(item || texts[idx]));
    }
  } catch (e) {
    console.warn('[MangaTranslator] Failed to parse Gemini translation JSON:', e);
  }

  return texts;
}

// ============ Gemini Vision API（AI 兜底） ============

/**
 * 使用 Gemini Vision 识别图片中的日文文字
 * 仅在 Tesseract OCR 置信度低于阈值时调用
 * 
 * @param {string} apiKey - Gemini API Key
 * @param {string} imageDataUrl - 裁剪后的小图片 data URL
 * @returns {string|null} 识别的文字，或 null
 */
async function geminiVisionOCR(apiKey, imageDataUrl) {
  // 提取 base64 数据
  const parts = imageDataUrl.split(',');
  if (parts.length < 2) return null;

  const mimeMatch = imageDataUrl.match(/data:([^;]+);/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
  const base64Data = parts[1];

  // 使用 Gemini 2.0 Flash Lite（最便宜最快的模型）
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              text: '这是日本漫画中的一段文字。请读取图片中的所有日文文字，只返回文字内容，不要返回其他任何内容。',
            },
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Data,
              },
            },
          ],
        }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 200,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `Gemini API HTTP ${response.status}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  return text ? text.trim() : null;
}

// ============ 工具函数 ============

/**
 * 广播消息到所有 content script
 */
function broadcastToContentScripts(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ 插件图标点击事件 ============
// 当用户点击插件图标时（不通过 popup），可以直接切换启用状态
// 注意：已设置 default_popup，所以此事件不会触发
// 如果需要，可以移除 popup 改用此事件
