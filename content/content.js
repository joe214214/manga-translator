/**
 * content.js — 漫画翻译内容脚本（V3：世代序号防串页 + 50ms 瞬时净屏截帧 + 视口画布定位 + 原生竖横排嵌字）
 */

(() => {
  'use strict';

  if (window.top !== window) {
    return;
  }

  if (typeof window.__mangaTranslatorCleanup === 'function') {
    try {
      window.__mangaTranslatorCleanup();
    } catch (_) {}
  }

  // ============ 配置 ============

  const CONFIG = {
    debounceDelay: 750,
    minScrollDelta: 100,
    maxFontSize: 22,
    minFontSize: 10,
    loadingHideDelay: 200,
    toastDuration: 3500,
  };

  // ============ 状态 ============

  let enabled = false;
  let debounceTimer = null;
  let overlayContainer = null;
  let loadingElement = null;
  let isProcessing = false;
  let pendingRecapture = false;
  let currentGen = 0; // 翻页世代序号：彻底阻止上一页延迟返回的译文串入当前页
  let lastScrollY = 0;
  let lastScrollX = 0;
  let listenersAttached = false;
  let mutationObserver = null;

  // ============ 初始化 ============

  async function init() {
    try {
      const settings = await chrome.storage.sync.get({
        enabled: true,
        debounceDelay: 750,
      });

      enabled = settings.enabled !== false;
      CONFIG.debounceDelay = settings.debounceDelay || 750;

      if (enabled) {
        attachListeners();
        setTimeout(() => {
          if (enabled && !document.hidden) {
            scheduleCapture(400);
          }
        }, 1800);
      }

      console.log('[MangaTranslator] V3 Content script initialized, enabled:', enabled);
    } catch (err) {
      console.error('[MangaTranslator] Init error:', err);
    }
  }

  // ============ 事件监听 ============

  function attachListeners() {
    if (listenersAttached) return;
    listenersAttached = true;

    lastScrollY = window.scrollY;
    lastScrollX = window.scrollX;

    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('click', onPageInteraction, { capture: true });
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('hashchange', onNavigation);
    window.addEventListener('popstate', onNavigation);
    document.addEventListener('visibilitychange', onVisibilityChange);

    mutationObserver = new MutationObserver(onMutation);
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });

    ensureOverlayContainer();
    console.log('[MangaTranslator] Event listeners attached');
  }

  function detachListeners() {
    if (!listenersAttached) return;

    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('click', onPageInteraction, { capture: true });
    document.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('hashchange', onNavigation);
    window.removeEventListener('popstate', onNavigation);
    document.removeEventListener('visibilitychange', onVisibilityChange);

    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }

    clearTimeout(debounceTimer);
    listenersAttached = false;
    console.log('[MangaTranslator] Event listeners detached');
  }

  window.__mangaTranslatorCleanup = detachListeners;

  // ============ 页面交互与翻页感知 ============

  function invalidateAndSchedule(delay) {
    currentGen++;
    clearOverlay();
    scheduleCapture(delay);
  }

  function onScroll() {
    if (!enabled) return;
    const deltaY = Math.abs(window.scrollY - lastScrollY);
    const deltaX = Math.abs(window.scrollX - lastScrollX);
    if (deltaY < CONFIG.minScrollDelta && deltaX < CONFIG.minScrollDelta) return;

    lastScrollY = window.scrollY;
    lastScrollX = window.scrollX;
    invalidateAndSchedule(CONFIG.debounceDelay);
  }

  function onPageInteraction(e) {
    if (!enabled) return;
    // 点击翻译气泡自身切换原文/译文时，绝不清屏重抓！
    if (e.target && e.target.closest && e.target.closest('#manga-translator-overlay')) {
      return;
    }
    invalidateAndSchedule(700);
  }

  function onKeyUp(e) {
    if (!enabled) return;
    const triggerKeys = [
      'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
      'Space', 'PageUp', 'PageDown', 'Home', 'End',
    ];
    if (triggerKeys.includes(e.code)) {
      invalidateAndSchedule(700);
    }
  }

  function onResize() {
    if (!enabled) return;
    invalidateAndSchedule(600);
  }

  function onNavigation() {
    if (!enabled) return;
    invalidateAndSchedule(800);
  }

  function onVisibilityChange() {
    if (document.hidden || document.visibilityState !== 'visible') {
      clearTimeout(debounceTimer);
      return;
    }
    if (enabled && !isProcessing && (!overlayContainer || overlayContainer.childElementCount === 0)) {
      scheduleCapture(500);
    }
  }

  /**
   * 仅当当前视口可见区域内的大尺寸漫画图片发生变化时才触发，忽略后台轮播预加载图片！
   */
  function isVisibleMangaImage(el) {
    if (!el || el.tagName !== 'IMG' || el.classList.contains('manga-translator-patch')) return false;
    const r = el.getBoundingClientRect();
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;
    const vw = Math.min(r.right, vpW) - Math.max(r.left, 0);
    const vh = Math.min(r.bottom, vpH) - Math.max(r.top, 0);
    return vw >= 160 && vh >= 160;
  }

  function onMutation(mutations) {
    if (!enabled) return;

    let shouldTrigger = false;
    for (const mutation of mutations) {
      const target = mutation.target;
      if (!target || target.nodeType !== Node.ELEMENT_NODE) continue;

      if (target.id === 'manga-translator-overlay' ||
          target.id === 'manga-translator-loading' ||
          target.closest?.('#manga-translator-overlay') ||
          target.closest?.('#manga-translator-loading') ||
          (typeof target.className === 'string' && target.className.includes('manga-translator'))) {
        continue;
      }

      if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
        if (isVisibleMangaImage(target)) {
          shouldTrigger = true;
          break;
        }
      } else if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.id?.startsWith('manga-translator') ||
              (typeof node.className === 'string' && node.className.includes('manga-translator'))) {
            continue;
          }
          if (isVisibleMangaImage(node)) {
            shouldTrigger = true;
            break;
          }
          if (node.querySelectorAll) {
            const imgs = node.querySelectorAll('img:not(.manga-translator-patch)');
            for (const img of imgs) {
              if (isVisibleMangaImage(img)) {
                shouldTrigger = true;
                break;
              }
            }
          }
          if (shouldTrigger) break;
        }
        if (shouldTrigger) break;
      }
    }

    if (shouldTrigger) {
      scheduleCapture(CONFIG.debounceDelay);
    }
  }

  // ============ 漫画画布/图片视口定位 ============

  /**
   * 提取当前视口中实际可见的漫画页面矩形（不调用 toDataURL，100% 兼容跨域受保护 Canvas）
   */
  function getMangaRegions() {
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;
    const regions = [];

    document.querySelectorAll('canvas, img:not(.manga-translator-patch)').forEach(el => {
      if (el.closest?.('#manga-translator-overlay')) return;
      const r = el.getBoundingClientRect();
      const left = Math.max(0, r.left);
      const top = Math.max(0, r.top);
      const right = Math.min(vpW, r.right);
      const bottom = Math.min(vpH, r.bottom);
      const width = right - left;
      const height = bottom - top;

      // 漫画主画面通常尺寸较大
      if (width >= 180 && height >= 220) {
        regions.push({ left, top, width, height });
      }
    });

    return regions;
  }

  // ============ 截图与翻译调度 ============

  function scheduleCapture(customDelay, forceRefresh = false) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      triggerCapture(forceRefresh);
    }, customDelay ?? CONFIG.debounceDelay);
  }

  async function triggerCapture(forceRefresh = false) {
    if (document.hidden || document.visibilityState !== 'visible') {
      return;
    }

    if (!chrome.runtime?.id) {
      detachListeners();
      return;
    }

    // 如果上一轮 OCR 仍在进行，标记挂起，待其结束后立即抓取最新画面，绝不丢弃翻页请求！
    if (isProcessing) {
      pendingRecapture = true;
      return;
    }

    isProcessing = true;
    const genAtStart = currentGen;
    showLoading();

    // 截屏前瞬时隐藏覆盖层与加载角标，等待两帧确保合成器输出 100% 纯净原图
    if (overlayContainer) {
      overlayContainer.classList.add('manga-translator-hidden');
    }
    if (loadingElement) {
      loadingElement.style.visibility = 'hidden';
    }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    try {
      const mangaRects = getMangaRegions();
      const response = await chrome.runtime.sendMessage({
        type: 'CAPTURE_AND_TRANSLATE',
        viewport: {
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
          mangaRects,
          forceRefresh: Boolean(forceRefresh),
        },
      });

      // 若在等待 OCR 期间用户已翻到下一页，立即丢弃过期的旧页译文，严防串页！
      if (genAtStart !== currentGen) {
        console.log('[MangaTranslator] Discarding stale OCR response from previous page');
        return;
      }

      if (!response) return;

      if (response.success) {
        const results = response.results || [];
        if (results.length > 0) {
          renderOverlay(results, response.viewport, response.imageWidth, response.imageHeight);
        } else {
          clearOverlay();
        }
      } else if (response.error) {
        showToast('翻译失败: ' + response.error, 'error');
      }
    } catch (err) {
      const errMsg = err?.message || String(err);
      if (errMsg.includes('Extension context invalidated') || errMsg.includes('上下文无效')) {
        detachListeners();
      } else {
        console.warn('[MangaTranslator] Capture request warning:', errMsg);
      }
    } finally {
      if (overlayContainer) {
        overlayContainer.classList.remove('manga-translator-hidden');
      }
      if (loadingElement) {
        loadingElement.style.visibility = 'visible';
      }
      isProcessing = false;
      hideLoading();

      if (pendingRecapture && enabled && !document.hidden) {
        pendingRecapture = false;
        scheduleCapture(280);
      }
    }
  }

  // ============ 消息监听 ============

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target === 'offscreen') return false;

    switch (message.type) {
      case 'SCREENSHOT_TAKEN':
        // Service Worker 已在 ~50ms 内完成截屏，立即恢复界面显示，消除等待 OCR 期间的空白闪烁
        if (overlayContainer) {
          overlayContainer.classList.remove('manga-translator-hidden');
        }
        if (loadingElement) {
          loadingElement.style.visibility = 'visible';
        }
        break;

      case 'REQUEST_IMMEDIATE_CAPTURE':
        enabled = true;
        attachListeners();
        currentGen++;
        clearOverlay();
        scheduleCapture(50, true);
        sendResponse?.({ success: true });
        break;

      case 'RENDER_OVERLAY':
        if (Array.isArray(message.results) && message.results.length > 0) {
          renderOverlay(message.results, message.viewport, message.imageWidth, message.imageHeight);
        } else {
          clearOverlay();
        }
        isProcessing = false;
        hideLoading();
        break;

      case 'NO_TEXT_FOUND':
        clearOverlay();
        isProcessing = false;
        hideLoading();
        break;

      case 'SETTINGS_UPDATED':
        handleSettingsUpdate(message.settings);
        break;
    }

    return false;
  });

  function handleSettingsUpdate(settings) {
    if (!settings) return;
    const wasEnabled = enabled;
    enabled = settings.enabled !== false;
    CONFIG.debounceDelay = settings.debounceDelay || 750;

    if (enabled && !wasEnabled) {
      attachListeners();
      scheduleCapture(200, true);
    } else if (!enabled && wasEnabled) {
      currentGen++;
      detachListeners();
      clearOverlay();
      hideLoading();
      isProcessing = false;
    }
  }

  // ============ 原生嵌字级覆盖层渲染 ============

  function ensureOverlayContainer() {
    if (overlayContainer && document.body.contains(overlayContainer)) return;
    overlayContainer = document.createElement('div');
    overlayContainer.id = 'manga-translator-overlay';
    overlayContainer.className = 'manga-translator-container notranslate';
    // 禁止浏览器自带「翻译此页」/第三方整页翻译插件二次翻译嵌字译文与原文浮窗
    overlayContainer.setAttribute('translate', 'no');
    document.body.appendChild(overlayContainer);
  }

  function clearOverlay() {
    if (overlayContainer) {
      overlayContainer.innerHTML = '';
    }
  }

  function renderOverlay(results, viewport, imageWidth, imageHeight) {
    clearOverlay();
    ensureOverlayContainer();

    if (!results || results.length === 0) return;

    const dpr = viewport?.devicePixelRatio || window.devicePixelRatio || 1;
    const innerW = viewport?.innerWidth || window.innerWidth || 1;
    const innerH = viewport?.innerHeight || window.innerHeight || 1;

    const scaleX = (imageWidth && innerW) ? (imageWidth / innerW) : dpr;
    const scaleY = (imageHeight && innerH) ? (imageHeight / innerH) : dpr;

    console.log(`[MangaTranslator] Rendering ${results.length} translated bubbles (scale: ${scaleX.toFixed(2)}x${scaleY.toFixed(2)})`);

    const fitTasks = [];

    results.forEach((result, index) => {
      const { bbox, translatedText, originalText, confidence, source, isVertical } = result;
      if (!translatedText) return;

      let left = bbox.x0 / scaleX;
      let top = bbox.y0 / scaleY;
      let width = (bbox.x1 - bbox.x0) / scaleX;
      let height = (bbox.y1 - bbox.y0) / scaleY;

      if (width < 8 || height < 8) return;

      const useVertical = isVertical !== undefined ? Boolean(isVertical) : (height >= width * 1.15);

      // 单列窄气泡适度左右拓宽（气泡内部两侧原本留白充足），让中文单列字号饱满清晰
      if (useVertical && width < 26) {
        const expand = Math.min(8, (26 - width) / 2);
        left -= expand;
        width += expand * 2;
      } else if (!useVertical && height < 22) {
        const expandY = Math.min(5, (22 - height) / 2);
        top -= expandY;
        height += expandY * 2;
      }

      const block = document.createElement('div');
      block.className = 'manga-translator-block';
      block.style.left = `${left.toFixed(1)}px`;
      block.style.top = `${top.toFixed(1)}px`;
      block.style.width = `${width.toFixed(1)}px`;
      block.style.height = `${height.toFixed(1)}px`;
      block.style.animationDelay = `${Math.min(index * 18, 180)}ms`;

      // 无痕白底羽化层（常规白底气泡无缝羽化融合；花哨底纹框采用柔和白底卡片完整遮盖白描边原字）
      const bgEl = document.createElement('div');
      bgEl.className = result.isFancy ? 'manga-translator-bg fancy' : 'manga-translator-bg';
      if (result.bgColor && !result.isFancy) {
        bgEl.style.backgroundColor = result.bgColor;
      }
      block.appendChild(bgEl);

      // 译文排版节点
      const textEl = document.createElement('span');
      textEl.className = `manga-translator-text notranslate ${useVertical ? 'vertical' : 'horizontal'}`;
      textEl.setAttribute('translate', 'no');
      textEl.lang = 'zh-CN';
      textEl.textContent = translatedText;
      block.appendChild(textEl);

      // 悬停原文浮窗
      const originalTip = document.createElement('div');
      originalTip.className = 'manga-translator-original notranslate';
      originalTip.setAttribute('translate', 'no');
      originalTip.lang = 'ja';
      originalTip.textContent = `原文：${originalText} (${Math.round(confidence)}%)`;
      block.appendChild(originalTip);

      // 点击单个气泡切换查看原图日文 / 中文嵌字
      block.addEventListener('click', (e) => {
        e.stopPropagation();
        const showingOriginal = block.dataset.showingOriginal === 'true';
        if (showingOriginal) {
          block.dataset.showingOriginal = 'false';
          bgEl.style.display = 'block';
          textEl.style.visibility = 'visible';
        } else {
          block.dataset.showingOriginal = 'true';
          bgEl.style.display = 'none';
          textEl.style.visibility = 'hidden';
        }
      });

      overlayContainer.appendChild(block);
      fitTasks.push({ textEl, width, height, useVertical });
    });

    // 批量精确测量排版边界，二分搜索最佳漫画嵌字字号
    requestAnimationFrame(() => {
      for (const task of fitTasks) {
        autoFitBubbleFont(task.textEl, task.width, task.height, task.useVertical);
      }
    });
  }

  /**
   * 精确自适应气泡字号（基于真实 BoundingClientRect 二分搜索，完美支持 vertical-rl 多列折行）
   */
  function autoFitBubbleFont(textEl, boxW, boxH, isVertical) {
    const safeW = Math.max(12, boxW + 2);
    const safeH = Math.max(12, boxH + 2);

    if (isVertical) {
      textEl.style.maxHeight = `${safeH}px`;
      textEl.style.maxWidth = 'none';
    } else {
      textEl.style.maxWidth = `${safeW}px`;
      textEl.style.maxHeight = 'none';
    }

    let low = CONFIG.minFontSize;
    let high = Math.min(CONFIG.maxFontSize, Math.floor(Math.max(safeW, safeH) * 0.65));
    if (high < low) high = low;
    let best = low;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      textEl.style.fontSize = `${mid}px`;
      const rect = textEl.getBoundingClientRect();
      if (rect.width <= safeW + 1 && rect.height <= safeH + 1) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    textEl.style.fontSize = `${best}px`;
  }

  // ============ 加载状态与提示 ============

  function showLoading() {
    if (loadingElement && document.body.contains(loadingElement)) {
      loadingElement.classList.remove('manga-translator-loading-hidden');
      return;
    }
    loadingElement = document.createElement('div');
    loadingElement.id = 'manga-translator-loading';
    loadingElement.className = 'manga-translator-loading notranslate';
    loadingElement.setAttribute('translate', 'no');
    loadingElement.innerHTML = `
      <div class="manga-translator-spinner"></div>
      <span>漫画嵌字翻译中...</span>
    `;
    document.body.appendChild(loadingElement);
  }

  function hideLoading() {
    if (!loadingElement) return;
    setTimeout(() => {
      if (loadingElement && !isProcessing) {
        loadingElement.classList.add('manga-translator-loading-hidden');
      }
    }, CONFIG.loadingHideDelay);
  }

  function showToast(message, type = 'info') {
    document.querySelectorAll('.manga-translator-toast').forEach(el => el.remove());
    const toast = document.createElement('div');
    toast.className = `manga-translator-toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'manga-translator-fadeout 0.25s ease-out forwards';
      setTimeout(() => toast.remove(), 260);
    }, CONFIG.toastDuration);
  }

  // ============ 启动 ============

  init();
})();
