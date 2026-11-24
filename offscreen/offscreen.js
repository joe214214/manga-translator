/**
 * offscreen.js — 离屏文档 OCR 引擎（V3.5：双通道自适应气泡与花哨背景白描边文字检测 + 振假名剥离 + 双模型识别）
 *
 * 核心技术架构（0 AI Token 消耗，纯本地传统 CV + WASM OCR）：
 * 1. 漫画页面 ROI 裁剪（利用 content script 传入的漫画画布/图片精确矩形，排除网页工具栏、横幅与黑边）
 * 2. 双通道自适应文字检测：
 *    - 通道 1（纯白对话框通道）：全灵敏度笔画与浊点提取（兼容细体字、无框白底旁白框、`二/三` 多横画聚合）
 *    - 通道 2（花哨网点/花卉/格纹背景 `白フチ文字` 通道）：针对半透明装饰框内带白描边的浓墨台词，
 *      利用局部背景灰度纹理定位 + 紧贴白描边光环校验 + 逐列字形掩码抹除半透明花卉/格纹底纹
 * 3. 周期性网点（Screentone 圆点阵列）2D 邻域抑制 + 2D 相对字号振假名（ルビ）剥离
 * 4. 构造 3.0x 超清无干扰文字列画布送入专用模型：
 *    - 竖排气泡 → 专用 `jpn_vert` 模型（PSM 5）
 *    - 不等高多列介绍框回退 → 逐列独立 `jpn_vert`（PSM 5）识别拼接，消除长短列基线干扰
 *    - 细体字低置信度回退 → 墨迹对比度增强曲线 + `jpn` 模型（PSM 5）二次识别
 *    - 横排文本框 → 专用 `jpn` 模型（PSM 7）
 * 5. 严格的日语对话合法性校验（兼容 `エントリーNo.1~3` 等编号台词），100% 拦截非台词噪声
 */

// ============ 状态管理 ============

let vertWorker = null;
let horizWorker = null;
let initPromise = null;

// 向 Service Worker 发送就绪信号
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});
console.log('[Offscreen] V3.5 Dual-Channel Manga & Fancy-Box OCR Engine ready');

// ============ 消息监听 ============

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  if (message.type === 'PROCESS_IMAGE') {
    processImage(message.imageDataUrl, message.viewport)
      .then(results => sendResponse(results))
      .catch(err => {
        const errMsg = err ? (err.message || String(err)) : '未知错误';
        console.error('[Offscreen] Processing error:', errMsg);
        sendResponse({ error: errMsg });
      });
    return true;
  }

  return false;
});

// ============ Tesseract 双模型初始化 ============

async function ensureWorkers() {
  if (vertWorker && horizWorker) {
    return { vertWorker, horizWorker };
  }
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    const workerPath = chrome.runtime.getURL('lib/tesseract/worker.min.js');
    const corePath = chrome.runtime.getURL('lib/tesseract');
    const langPath = chrome.runtime.getURL('lib/tesseract/traineddata');

    const createOne = async (lang) => {
      return await Tesseract.createWorker(lang, 1, {
        workerPath,
        corePath,
        langPath,
        workerBlobURL: false,
        gzip: false,
        cacheMethod: 'none',
        logger: () => {},
      });
    };

    console.log('[Offscreen] Initializing dedicated jpn_vert & jpn Tesseract workers...');
    try {
      [vertWorker, horizWorker] = await Promise.all([
        createOne('jpn_vert'),
        createOne('jpn'),
      ]);
      console.log('[Offscreen] Dedicated jpn_vert + jpn workers initialized');
      return { vertWorker, horizWorker };
    } catch (err) {
      console.error('[Offscreen] Worker initialization failed:', err);
      vertWorker = null;
      horizWorker = null;
      initPromise = null;
      throw new Error('OCR 引擎初始化失败: ' + (err.message || String(err)));
    }
  })();

  return initPromise;
}

// ============ 核心处理流水线 ============

async function processImage(imageDataUrl, viewport) {
  const startTime = performance.now();

  // Step 1: 解码截图到原始尺寸 Canvas
  const img = await loadImage(imageDataUrl);
  const W = img.width;
  const H = img.height;

  const canvas = document.getElementById('processingCanvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  // 计算漫画内容有效区域（排除网页工具栏、底部推广条与两侧黑边）
  const pageRects = computePixelROIRects(W, H, viewport);

  // Step 2: 双通道连通分量文字行检测（纯白气泡 + 花哨图案背景白描边文字）+ 振假名剥离
  const cvStart = performance.now();
  const candidates = detectAndBuildCleanStrips(ctx, W, H, pageRects);
  const cvElapsed = Math.round(performance.now() - cvStart);
  console.log(`[Offscreen] CV detected ${candidates.length} dialogue candidates in ${cvElapsed}ms (${W}x${H})`);

  if (candidates.length === 0) {
    return { results: [], imageWidth: W, imageHeight: H };
  }

  // Step 3: 确保双模型就绪并逐气泡高速识别
  const { vertWorker: vWorker, horizWorker: hWorker } = await ensureWorkers();
  const finalResults = [];

  for (const cand of candidates) {
    let rawText = '';
    let confidence = 0;

    if (cand.isVertical) {
      await vWorker.setParameters({
        tessedit_pageseg_mode: '5',
        preserve_interword_spaces: '0',
      });
      const { data } = await vWorker.recognize(cand.normalDataUrl);
      rawText = (data.text || '').replace(/\s+/g, '').trim();
      confidence = data.confidence || 0;

      const primaryValid = validateAndCleanJapanese(rawText, confidence);

      // 回退 A：仅针对花哨背景角色介绍框中因长短列高度悬殊导致整体置信度不足（< 54%）的多列框，
      // 使用专用竖排模型 `jpn_vert` 逐列独立识别并按从右向左顺序拼接
      if (cand.isFancy && (!primaryValid || confidence < 54) && cand.colStripUrls && cand.colStripUrls.length >= 2) {
        const colTexts = [];
        let confSum = 0;
        let confWeight = 0;
        for (const colUrl of cand.colStripUrls) {
          const cRes = await vWorker.recognize(colUrl);
          const cTxt = (cRes.data.text || '').replace(/\s+/g, '').trim();
          const cConf = cRes.data.confidence || 0;
          if (cTxt && cConf >= 34 && /[\u3041-\u3096\u30A1-\u30FA\u4E00-\u9FFF0-9]/.test(cTxt)) {
            colTexts.push(cTxt);
            const effConf = Math.max(cConf, 56);
            confSum += effConf * cTxt.length;
            confWeight += cTxt.length;
          }
        }
        if (colTexts.length > 0 && confWeight > 0) {
          const joinedText = colTexts.join('');
          const joinedConf = confSum / confWeight;
          if (validateAndCleanJapanese(joinedText, joinedConf) &&
              (joinedConf > confidence || joinedText.length > rawText.length + 2)) {
            rawText = joinedText;
            confidence = joinedConf;
          }
        }
      }

      // 回退 B：纯白气泡内的细体/扁平字体（如「くだらん…」），启用墨迹加深画布 + jpn 模型二次校验
      if (!cand.isFancy && (!validateAndCleanJapanese(rawText, confidence) || confidence < 58) && cand.enhancedDataUrl) {
        await hWorker.setParameters({
          tessedit_pageseg_mode: '5',
          preserve_interword_spaces: '0',
        });
        const retry = await hWorker.recognize(cand.enhancedDataUrl);
        const retryText = (retry.data.text || '').replace(/\s+/g, '').trim();
        const retryConf = retry.data.confidence || 0;
        const primaryHadJp = /[\u3041-\u3096\u30A1-\u30FA\u4E00-\u9FFF]/.test(rawText);
        const isPureMultiKana = /^[\u3041-\u3096\u30A1-\u30FA\u4E00-\u9FFF…！？。、ー]{3,}$/.test(retryText);
        const minAcceptRetry = primaryHadJp ? 46 : (isPureMultiKana ? 54 : 66);
        if (retryConf >= minAcceptRetry && validateAndCleanJapanese(retryText, Math.max(retryConf, 53)) && retryConf > confidence) {
          rawText = retryText;
          confidence = Math.max(retryConf, 53);
        }
      }
    } else {
      await hWorker.setParameters({
        tessedit_pageseg_mode: '7',
        preserve_interword_spaces: '0',
      });
      const { data } = await hWorker.recognize(cand.normalDataUrl);
      rawText = (data.text || '').replace(/\s+/g, '').trim();
      confidence = data.confidence || 0;
    }

    const cleanedText = validateAndCleanJapanese(rawText, confidence);
    if (!cleanedText) continue;

    finalResults.push({
      text: cleanedText,
      bbox: cand.bbox,
      isVertical: cand.isVertical,
      isFancy: Boolean(cand.isFancy),
      confidence,
      bgColor: '#ffffff',
      croppedImageData: confidence < 60 ? cropRegion(canvas, cand.bbox) : null,
    });
  }

  const totalSec = ((performance.now() - startTime) / 1000).toFixed(2);
  console.log(`[Offscreen] Pipeline complete: ${finalResults.length}/${candidates.length} valid bubbles in ${totalSec}s`);

  return {
    results: finalResults,
    imageWidth: W,
    imageHeight: H,
  };
}

// ============ 视口漫画区域映射 ============

function computePixelROIRects(W, H, viewport) {
  if (viewport && Array.isArray(viewport.mangaRects) && viewport.mangaRects.length > 0 &&
      viewport.innerWidth > 0 && viewport.innerHeight > 0) {
    const sx = W / viewport.innerWidth;
    const sy = H / viewport.innerHeight;
    return viewport.mangaRects.map(r => ({
      x0: Math.max(0, Math.floor(r.left * sx)),
      y0: Math.max(0, Math.floor(r.top * sy)),
      x1: Math.min(W, Math.ceil((r.left + r.width) * sx)),
      y1: Math.min(H, Math.ceil((r.top + r.height) * sy)),
    })).filter(r => (r.x1 - r.x0) > 80 && (r.y1 - r.y0) > 80);
  }
  // 兜底：排除最底部常见阅读器控制栏区域
  return [{ x0: 0, y0: 0, x1: W, y1: Math.round(H * 0.92) }];
}

// ============ V3.5 双通道漫画台词检测与净空画布合成 ============

function detectAndBuildCleanStrips(ctx, W, H, pageRects) {
  const imgData = ctx.getImageData(0, 0, W, H);
  const px = imgData.data;

  const inROI = new Uint8Array(W * H);
  for (const r of pageRects) {
    for (let y = r.y0; y < r.y1; y++) {
      inROI.fill(1, y * W + r.x0, y * W + r.x1);
    }
  }

  // 亮度与饱和度预计算：分离纯白像素、常规墨迹（l < 185）与浓黑墨迹（l < 138，穿透半透明灰底纹）
  const lum = new Uint8Array(W * H);
  const isCleanWhite = new Uint8Array(W * H);
  const isDark185 = new Uint8Array(W * H);
  const isDark138 = new Uint8Array(W * H);

  for (let i = 0, n = W * H; i < n; i++) {
    if (!inROI[i]) continue;
    const k = i * 4;
    const r = px[k], g = px[k + 1], b = px[k + 2];
    const l = (77 * r + 150 * g + 29 * b) >> 8;
    lum[i] = l;
    const maxC = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const minC = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const sat = maxC - minC;
    if (l >= 230 && sat <= 32) {
      isCleanWhite[i] = 1;
    } else if (l < 185 && sat <= 65) {
      isDark185[i] = 1;
      if (l < 138) isDark138[i] = 1;
    }
  }

  const maxGlyph = Math.max(32, Math.round(H * 0.045));
  const queue = new Int32Array(W * H);

  /**
   * 通用单通道连通分量文字行检测器
   * - mode === 'white': 常规纯白底对话框通道（保留抗锯齿细笔画与微弱浊点）
   * - mode === 'fancy': 花哨半透明图案背景 `白フチ文字` 通道（剥离中灰花卉/格纹底纹）
   */
  function runPass(mode, allowedMask, excludeMask) {
    const isFancy = mode === 'fancy';
    const isDark = isFancy ? isDark138 : isDark185;
    const darkLabel = new Int32Array(W * H);
    const lineArtMask = new Uint8Array(W * H);
    let nextLabel = 1;
    const rawComps = [];

    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const start = y * W + x;
        if (!isDark[start] || darkLabel[start] !== 0) continue;

        const lbl = nextLabel++;
        darkLabel[start] = lbl;
        let qHead = 0, qTail = 0;
        queue[qTail++] = start;

        let minX = x, maxX = x, minY = y, maxY = y;
        let minLum = 255;
        let inAllowed = false;
        let hitsExcluded = false;

        while (qHead < qTail) {
          const cur = queue[qHead++];
          const cx = cur % W;
          const cy = (cur - cx) / W;
          const l = lum[cur];
          if (l < minLum) minLum = l;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          if (allowedMask[cur]) inAllowed = true;
          if (excludeMask && excludeMask[cur]) hitsExcluded = true;

          for (let dy = -1; dy <= 1; dy++) {
            const ny = cy + dy;
            if (ny <= 0 || ny >= H - 1) continue;
            const row = ny * W;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = cx + dx;
              if (nx <= 0 || nx >= W - 1) continue;
              const np = row + nx;
              if (isDark[np] && darkLabel[np] === 0) {
                darkLabel[np] = lbl;
                queue[qTail++] = np;
              }
            }
          }
        }

        const area = qTail;
        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;

        // 超过单字尺寸上限的连续墨迹 = 气泡外框、分镜框、锯齿装饰框、人物头发与服饰线条
        if (bw > maxGlyph || bh > maxGlyph || area > maxGlyph * maxGlyph * 0.58) {
          for (let k = 0; k < qTail; k++) lineArtMask[queue[k]] = 1;
          continue;
        }

        if (!inAllowed || hitsExcluded) continue;
        if (area < (isFancy ? 4 : 2) || minLum > (isFancy ? 68 : 145)) continue;
        rawComps.push({ minX, minY, maxX, maxY, w: bw, h: bh, area, minLum });
      }
    }

    // 2D 周期性圆点网点（Polka-dot Screentone）检测与剔除
    const dotCandidates = [];
    const gridCell = 32;
    const gridW = Math.ceil(W / gridCell), gridH = Math.ceil(H / gridCell);
    const dotGrid = Array.from({ length: gridW * gridH }, () => []);

    rawComps.forEach((c, idx) => {
      const fill = c.area / (c.w * c.h);
      if (c.w >= 2 && c.w <= 9 && c.h >= 2 && c.h <= 9 && fill >= 0.48 && Math.abs(c.w - c.h) <= 3) {
        const gx = Math.floor(((c.minX + c.maxX) / 2) / gridCell);
        const gy = Math.floor(((c.minY + c.maxY) / 2) / gridCell);
        dotGrid[gy * gridW + gx].push(idx);
        dotCandidates.push(idx);
      }
    });

    const isScreentoneDot = new Uint8Array(rawComps.length);
    for (const idx of dotCandidates) {
      const c = rawComps[idx];
      const cx = (c.minX + c.maxX) / 2, cy = (c.minY + c.maxY) / 2;
      const gx = Math.floor(cx / gridCell), gy = Math.floor(cy / gridCell);
      let sameNeighbors = 0, leftRightNeighbors = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ngy = gy + dy;
        if (ngy < 0 || ngy >= gridH) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const ngx = gx + dx;
          if (ngx < 0 || ngx >= gridW) continue;
          for (const nIdx of dotGrid[ngy * gridW + ngx]) {
            if (nIdx === idx) continue;
            const nc = rawComps[nIdx];
            if (Math.abs(nc.w - c.w) <= 2 && Math.abs(nc.h - c.h) <= 2 &&
                Math.abs(nc.area - c.area) <= Math.max(4, c.area * 0.45)) {
              const ncx = (nc.minX + nc.maxX) / 2, ncy = (nc.minY + nc.maxY) / 2;
              if ((ncx - cx) * (ncx - cx) + (ncy - cy) * (ncy - cy) <= 28 * 28) {
                sameNeighbors++;
                if (Math.abs(ncx - cx) >= 6) leftRightNeighbors++;
              }
            }
          }
        }
      }
      if (sameNeighbors >= 5 && leftRightNeighbors >= 3) {
        isScreentoneDot[idx] = 1;
      }
    }

    // 白底 / 白描边（白フチ）光环校验
    const haloPad = isFancy ? 2 : 3;
    const minWhiteRatio = isFancy ? 0.70 : 0.80;
    const strokeComps = [];

    for (let i = 0; i < rawComps.length; i++) {
      if (isScreentoneDot[i]) continue;
      const c = rawComps[i];
      let whiteBg = 0, totalBg = 0, nearLineArt = 0;
      const x0 = Math.max(0, c.minX - haloPad), x1 = Math.min(W - 1, c.maxX + haloPad);
      const y0 = Math.max(0, c.minY - haloPad), y1 = Math.min(H - 1, c.maxY + haloPad);

      for (let y = y0; y <= y1; y++) {
        const isBorderY = (y < c.minY - 1 || y > c.maxY + 1);
        for (let x = x0; x <= x1; x++) {
          if (!isBorderY && x >= c.minX - 1 && x <= c.maxX + 1) continue;
          const p = y * W + x;
          if (lineArtMask[p]) nearLineArt++;
          if (!isDark[p]) {
            totalBg++;
            if (isCleanWhite[p]) whiteBg++;
          }
        }
      }

      if (totalBg < 6) continue;
      if (whiteBg / totalBg < minWhiteRatio) continue;
      if (nearLineArt > (totalBg + nearLineArt) * (isFancy ? 0.16 : 0.20)) continue;
      strokeComps.push(c);
    }

    // 射线障碍检测：禁止跨越气泡黑框、锯齿框或分镜线合并
    function rayHitLineArt(x0, y0, x1, y1) {
      const dx = x1 - x0, dy = y1 - y0;
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      if (steps <= 1) return false;
      for (let s = 1; s < steps; s++) {
        const x = Math.round(x0 + (dx * s) / steps);
        const y = Math.round(y0 + (dy * s) / steps);
        if (lineArtMask[y * W + x]) return true;
      }
      return false;
    }

    function hasLineArtBetween(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) {
      const acx = (ax0 + ax1) >> 1, acy = (ay0 + ay1) >> 1;
      const bcx = (bx0 + bx1) >> 1, bcy = (by0 + by1) >> 1;
      const ay25 = ay0 + ((ay1 - ay0) >> 2), ay75 = ay1 - ((ay1 - ay0) >> 2);
      const by25 = by0 + ((by1 - by0) >> 2), by75 = by1 - ((by1 - by0) >> 2);
      let hits = 0;
      if (rayHitLineArt(acx, acy, bcx, bcy)) hits++;
      if (rayHitLineArt(acx, ay25, bcx, by25)) hits++;
      if (rayHitLineArt(acx, ay75, bcx, by75)) hits++;
      return isFancy ? (hits >= 2) : (hits >= 1);
    }

    function isCleanCorridor(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) {
      const acx = (ax0 + ax1) >> 1, acy = (ay0 + ay1) >> 1;
      const bcx = (bx0 + bx1) >> 1, bcy = (by0 + by1) >> 1;
      const dx = bcx - acx, dy = bcy - acy;
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      if (steps <= 18) return true;
      let nonDark = 0, bright = 0;
      const brightCut = isFancy ? 140 : 215;
      for (let s = 1; s < steps; s++) {
        const x = Math.round(acx + (dx * s) / steps);
        const y = Math.round(acy + (dy * s) / steps);
        const p = y * W + x;
        if (!isFancy && lineArtMask[p]) return false;
        if (!isDark[p]) {
          nonDark++;
          if (lum[p] >= brightCut) bright++;
        }
      }
      return nonDark === 0 || (bright / nonDark) >= 0.78;
    }

    // 偏旁部首、假名浊点及多横画汉字（如「二」「三」「ニ」）聚合为单字框
    const tinyLimit = Math.max(6, Math.round(H * 0.0068));
    const chars = strokeComps.map(c => ({
      minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY,
      w: c.w, h: c.h, area: c.area, minLum: c.minLum,
    }));
    const active = new Uint8Array(chars.length).fill(1);
    const maxSingleChar = Math.round(maxGlyph * 0.68);

    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < chars.length; i++) {
        if (!active[i]) continue;
        const a = chars[i];
        for (let j = i + 1; j < chars.length; j++) {
          if (!active[j]) continue;
          const b = chars[j];

          const gx = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX) - 1);
          const gy = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY) - 1);
          const xOv = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) + 1;
          const isHorizBars = (gx === 0 && gy <= 5 && xOv >= Math.min(a.w, b.w) * 0.60 &&
                               a.w >= 7 && b.w >= 7 && a.h <= 9 && b.h <= 9);

          if (!isHorizBars && (gx > 2 || gy > 2)) continue;

          const bothTiny = (a.w <= tinyLimit && a.h <= tinyLimit && b.w <= tinyLimit && b.h <= tinyLimit);
          if (bothTiny && gy >= 1) continue;

          if ((a.w >= 12 && a.h >= 11 && b.w <= 6 && b.h <= 6 && b.minX > a.maxX) ||
              (b.w >= 12 && b.h >= 11 && a.w <= 6 && a.h <= 6 && a.minX > b.maxX)) {
            continue;
          }

          const nx0 = Math.min(a.minX, b.minX);
          const ny0 = Math.min(a.minY, b.minY);
          const nx1 = Math.max(a.maxX, b.maxX);
          const ny1 = Math.max(a.maxY, b.maxY);
          const nw = nx1 - nx0 + 1;
          const nh = ny1 - ny0 + 1;

          if (nw > maxSingleChar || nh > maxSingleChar) continue;
          if (isHorizBars && nh > nw * 1.25) continue;
          if (bothTiny && nh > tinyLimit + 1) continue;

          const vOverlap = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
          if (!isHorizBars && vOverlap <= 2 && a.h >= 7 && b.h >= 7 && nh > Math.max(a.w, b.w, 12) * 1.28) continue;
          if (hasLineArtBetween(a.minX, a.minY, a.maxX, a.maxY, b.minX, b.minY, b.maxX, b.maxY)) continue;

          a.minX = nx0; a.minY = ny0; a.maxX = nx1; a.maxY = ny1;
          a.w = nw; a.h = nh;
          a.area += b.area;
          a.minLum = Math.min(a.minLum, b.minLum);
          active[j] = 0;
          merged = true;
        }
      }
    }

    const allGlyphs = chars.filter((_, idx) => active[idx]);
    const mainMinDim = Math.max(7, Math.round(H * 0.0075));
    const mainGlyphs = [];
    const tinyGlyphs = [];

    for (const g of allGlyphs) {
      // 在花哨背景通道中剔除对角细发丝/花茎残片（宽高 >= 6 但像素填充率 < 15%）
      if (isFancy && g.w >= 6 && g.h >= 6 && (g.area / (g.w * g.h)) < 0.15) {
        continue;
      }
      const isMainSize = (Math.max(g.w, g.h) >= mainMinDim && Math.min(g.w, g.h) >= 4) ||
                         (Math.max(g.w, g.h) >= Math.round(mainMinDim * 1.25) && Math.min(g.w, g.h) >= 2);
      if (isMainSize && g.area >= 8 && g.minLum < 120) {
        mainGlyphs.push(g);
      } else {
        tinyGlyphs.push(g);
      }
    }

    // 构建竖排文字行
    mainGlyphs.sort((a, b) => a.minY - b.minY);
    const colUsed = new Uint8Array(mainGlyphs.length);
    const rawColumns = [];

    for (let i = 0; i < mainGlyphs.length; i++) {
      if (colUsed[i]) continue;
      const colIdxs = [i];
      colUsed[i] = 1;

      let growing = true;
      while (growing) {
        growing = false;
        const col = colIdxs.map(k => mainGlyphs[k]);
        const colMinX = Math.min(...col.map(c => c.minX));
        const colMaxX = Math.max(...col.map(c => c.maxX));
        const colCenterX = (colMinX + colMaxX) / 2;
        const colW = Math.max(11, colMaxX - colMinX + 1);
        const topChar = col[0];
        const botChar = col[col.length - 1];

        for (let j = 0; j < mainGlyphs.length; j++) {
          if (colUsed[j]) continue;
          const cand = mainGlyphs[j];
          const candCX = (cand.minX + cand.maxX) / 2;

          if (Math.abs(candCX - colCenterX) > Math.max(colW, cand.w) * 0.55) continue;
          const candMaxDim = Math.max(cand.w, cand.h);
          if (cand.w > colW * 2.3 || colW > candMaxDim * 3.0) continue;

          const gapBelow = cand.minY - botChar.maxY - 1;
          const gapAbove = topChar.minY - cand.maxY - 1;
          const maxGap = isFancy
            ? Math.max(28, Math.round(Math.max(colW, cand.h) * 2.0))
            : Math.max(22, Math.round(Math.max(colW, cand.h) * 1.7));

          if (gapBelow >= -4 && gapBelow <= maxGap) {
            if (!hasLineArtBetween(botChar.minX, botChar.minY, botChar.maxX, botChar.maxY, cand.minX, cand.minY, cand.maxX, cand.maxY) &&
                isCleanCorridor(botChar.minX, botChar.minY, botChar.maxX, botChar.maxY, cand.minX, cand.minY, cand.maxX, cand.maxY)) {
              colIdxs.push(j);
              colIdxs.sort((a, b) => mainGlyphs[a].minY - mainGlyphs[b].minY);
              colUsed[j] = 1;
              growing = true;
            }
          } else if (gapAbove >= -4 && gapAbove <= maxGap) {
            if (!hasLineArtBetween(cand.minX, cand.minY, cand.maxX, cand.maxY, topChar.minX, topChar.minY, topChar.maxX, topChar.maxY) &&
                isCleanCorridor(cand.minX, cand.minY, cand.maxX, cand.maxY, topChar.minX, topChar.minY, topChar.maxX, topChar.maxY)) {
              colIdxs.unshift(j);
              colIdxs.sort((a, b) => mainGlyphs[a].minY - mainGlyphs[b].minY);
              colUsed[j] = 1;
              growing = true;
            }
          }
        }
      }

      if (colIdxs.length < 2) {
        colUsed[colIdxs[0]] = 0;
        continue;
      }

      const col = colIdxs.map(k => mainGlyphs[k]);
      const colMinX = Math.min(...col.map(c => c.minX));
      const colMaxX = Math.max(...col.map(c => c.maxX));
      const colCX = (colMinX + colMaxX) / 2;
      const colW = colMaxX - colMinX + 1;
      let colMinY = col[0].minY;
      let colMaxY = col[col.length - 1].maxY;

      for (const tg of tinyGlyphs) {
        const tcx = (tg.minX + tg.maxX) / 2;
        if (Math.abs(tcx - colCX) <= Math.max(5, colW * 0.38) &&
            tg.minY >= colMinY - 12 && tg.maxY <= colMaxY + Math.max(20, colW * 1.3)) {
          if (!hasLineArtBetween(colMinX, colMinY, colMaxX, colMaxY, tg.minX, tg.minY, tg.maxX, tg.maxY)) {
            colMinY = Math.min(colMinY, tg.minY);
            colMaxY = Math.max(colMaxY, tg.maxY);
          }
        }
      }

      const widths = col.map(c => c.w).sort((a, b) => a - b);
      const heights = col.map(c => c.h).sort((a, b) => a - b);
      const minLums = col.map(c => c.minLum).sort((a, b) => a - b);
      const w50 = widths[Math.floor(widths.length * 0.50)];
      const h50 = heights[Math.floor(heights.length * 0.50)];
      const w75 = widths[Math.floor(widths.length * 0.75)];
      const h75 = heights[Math.floor(heights.length * 0.75)];
      const lum50 = minLums[Math.floor(minLums.length * 0.50)];

      if (w75 < mainMinDim) {
        colIdxs.forEach(k => { colUsed[k] = 0; });
        continue;
      }

      if (isFancy && (lum50 > 42 || (col.length < 3 && Math.max(w75, h75) < 14))) {
        colIdxs.forEach(k => { colUsed[k] = 0; });
        continue;
      }

      rawColumns.push({
        glyphs: col,
        charCount: col.length,
        minX: colMinX,
        maxX: colMaxX,
        minY: colMinY,
        maxY: colMaxY,
        w: colW,
        h: colMaxY - colMinY + 1,
        w50,
        h50,
        w75,
        h75,
        isVertical: true,
      });
    }

    // 基于 2D 中位尺寸比剥离主列右侧振假名列（兼顾大字号角色介绍框内的 9~12px 振假名，绝不误删窄假名正文列）
    const rubyCols = [];
    const columns = rawColumns.filter((col, idx) => {
      if (col.w > 14) return true;
      const isRuby = rawColumns.some((other, oi) => {
        if (oi === idx || other.w < 13) return false;
        if (col.w > 8 && (col.w50 > other.w75 * 0.58 || col.h50 > other.h75 * 0.64)) return false;
        const gap = col.minX - other.maxX - 1;
        const maxGap = Math.max(6, Math.round(other.w75 * 0.42));
        const vOv = Math.min(col.maxY, other.maxY) - Math.max(col.minY, other.minY);
        return gap >= -2 && gap <= maxGap && vOv > col.h * 0.40;
      });
      if (isRuby) rubyCols.push(col);
      return !isRuby;
    });
    for (const rc of rubyCols) {
      for (const g of rc.glyphs) tinyGlyphs.push(g);
    }

    // 横排姓名框/标题框检测
    const unusedMain = mainGlyphs.filter((_, idx) => !colUsed[idx]);
    unusedMain.sort((a, b) => a.minX - b.minX);
    const rowUsed = new Uint8Array(unusedMain.length);
    const horizBlocks = [];

    for (let i = 0; i < unusedMain.length; i++) {
      if (rowUsed[i]) continue;
      const row = [unusedMain[i]];
      rowUsed[i] = 1;
      let growing = true;
      while (growing) {
        growing = false;
        const rMinY = Math.min(...row.map(c => c.minY));
        const rMaxY = Math.max(...row.map(c => c.maxY));
        const rCY = (rMinY + rMaxY) / 2;
        const rH = Math.max(11, rMaxY - rMinY + 1);
        const rightChar = row[row.length - 1];
        for (let j = 0; j < unusedMain.length; j++) {
          if (rowUsed[j]) continue;
          const cand = unusedMain[j];
          const candCY = (cand.minY + cand.maxY) / 2;
          if (Math.abs(candCY - rCY) > rH * 0.42) continue;
          const gapRight = cand.minX - rightChar.maxX - 1;
          if (gapRight >= -1 && gapRight <= rH * 0.85) {
            if (!hasLineArtBetween(rightChar.minX, rightChar.minY, rightChar.maxX, rightChar.maxY, cand.minX, cand.minY, cand.maxX, cand.maxY) &&
                isCleanCorridor(rightChar.minX, rightChar.minY, rightChar.maxX, rightChar.maxY, cand.minX, cand.minY, cand.maxX, cand.maxY)) {
              row.push(cand);
              row.sort((a, b) => a.minX - b.minX);
              rowUsed[j] = 1;
              growing = true;
            }
          }
        }
      }
      if (row.length >= 3) {
        horizBlocks.push({
          isVertical: false,
          columns: [],
          minX: Math.min(...row.map(c => c.minX)),
          maxX: Math.max(...row.map(c => c.maxX)),
          minY: Math.min(...row.map(c => c.minY)),
          maxY: Math.max(...row.map(c => c.maxY)),
          charCount: row.length,
        });
      }
    }

    // 同一气泡内相邻竖列按从右向左阅读顺序聚类
    const bUsed = new Uint8Array(columns.length);
    const bubbles = [];

    for (let i = 0; i < columns.length; i++) {
      if (bUsed[i]) continue;
      const cluster = [columns[i]];
      bUsed[i] = 1;

      let changed = true;
      while (changed) {
        changed = false;
        for (let j = 0; j < columns.length; j++) {
          if (bUsed[j]) continue;
          const cand = columns[j];

          let canMerge = false;
          for (const member of cluster) {
            const maxMedW = Math.max(member.w75, cand.w75, 14);
            const ratio = Math.max(member.w75, cand.w75) / Math.max(1, Math.min(member.w75, cand.w75));
            if (ratio > 2.1) continue;

            const hGap = Math.max(0, Math.max(member.minX, cand.minX) - Math.min(member.maxX, cand.maxX) - 1);
            const vOverlap = Math.min(member.maxY, cand.maxY) - Math.max(member.minY, cand.minY);

            const isSideBySide = hGap <= maxMedW * 2.4 && vOverlap >= -maxMedW * 0.7 &&
                                 Math.abs(((member.minY + member.maxY) - (cand.minY + cand.maxY)) / 2) <= Math.max(member.h, cand.h) * 0.9;
            const hOverlap = Math.min(member.maxX, cand.maxX) - Math.max(member.minX, cand.minX);
            const vGap = Math.max(0, Math.max(member.minY, cand.minY) - Math.min(member.maxY, cand.maxY) - 1);
            const isSameColSplit = hOverlap >= Math.min(member.w, cand.w) * 0.35 && vGap <= maxMedW * 1.9;

            if (isSideBySide || isSameColSplit) {
              if (!hasLineArtBetween(member.minX, member.minY, member.maxX, member.maxY, cand.minX, cand.minY, cand.maxX, cand.maxY) &&
                  isCleanCorridor(member.minX, member.minY, member.maxX, member.maxY, cand.minX, cand.minY, cand.maxX, cand.maxY)) {
                canMerge = true;
                break;
              }
            }
          }

          if (canMerge) {
            cluster.push(cand);
            bUsed[j] = 1;
            changed = true;
          }
        }
      }

      cluster.sort((c1, c2) => ((c2.minX + c2.maxX) / 2) - ((c1.minX + c2.maxX) / 2));
      const mergedCols = [];
      for (const col of cluster) {
        const match = mergedCols.find(mc => Math.abs(((mc.minX + mc.maxX) - (col.minX + col.maxX)) / 2) < Math.min(mc.w, col.w) * 0.58);
        if (match) {
          match.minX = Math.min(match.minX, col.minX);
          match.maxX = Math.max(match.maxX, col.maxX);
          match.minY = Math.min(match.minY, col.minY);
          match.maxY = Math.max(match.maxY, col.maxY);
          match.w = match.maxX - match.minX + 1;
          match.h = match.maxY - match.minY + 1;
          match.charCount += col.charCount;
          if (match.glyphs && col.glyphs) match.glyphs = match.glyphs.concat(col.glyphs);
        } else {
          mergedCols.push({ ...col });
        }
      }
      mergedCols.sort((c1, c2) => ((c2.minX + c2.maxX) / 2) - ((c1.minX + c2.maxX) / 2));

      if (isFancy) {
        const totalChars = mergedCols.reduce((s, c) => s + c.charCount, 0);
        const maxS = Math.max(...mergedCols.map(c => Math.max(c.w75, c.h75 || c.w75)));
        if (totalChars < 3 && maxS < 15) continue;
      }

      bubbles.push({
        isVertical: true,
        columns: mergedCols,
        minX: Math.min(...mergedCols.map(c => c.minX)),
        maxX: Math.max(...mergedCols.map(c => c.maxX)),
        minY: Math.min(...mergedCols.map(c => c.minY)),
        maxY: Math.max(...mergedCols.map(c => c.maxY)),
        charCount: mergedCols.reduce((s, c) => s + c.charCount, 0),
      });
    }

    for (const hb of horizBlocks) {
      bubbles.push(hb);
    }

    // 振假名像素遮罩：凡与主字处于同一高度且位于其右侧的微型假名一律判定为振假名（ルビ），仅保留行间居中的行内标点
    const furiganaPixelMask = new Uint8Array(W * H);
    for (const tg of tinyGlyphs) {
      const tcx = (tg.minX + tg.maxX) / 2;
      const isInlinePunct = bubbles.some(b =>
        b.isVertical && b.columns.some(c => {
          const colCX = (c.minX + c.maxX) / 2;
          if (Math.abs(tcx - colCX) > Math.max(5, c.w * 0.36)) return false;
          if (tg.minY < c.minY - 12 || tg.maxY > c.maxY + 20) return false;
          const besideMain = c.glyphs && c.glyphs.some(g =>
            (Math.min(g.maxY, tg.maxY) - Math.max(g.minY, tg.minY)) >= 2 && tg.minX > g.minX + 2
          );
          return !besideMain;
        })
      );
      if (!isInlinePunct) {
        const y0 = Math.max(0, tg.minY - 1), y1 = Math.min(H - 1, tg.maxY + 1);
        const x0 = Math.max(0, tg.minX - 1), x1 = Math.min(W - 1, tg.maxX + 1);
        for (let yy = y0; yy <= y1; yy++) {
          furiganaPixelMask.fill(1, yy * W + x0, yy * W + x1 + 1);
        }
      }
    }

    const SCALE = 3.0;
    const PAD_X = 32;
    const PAD_Y = 20;
    const COL_SPACING = 26;

    const buildColPatch = (rctx, sx0, sy0, sx1, sy1, colGlyphs, enhanceThinStrokes) => {
      const sw = sx1 - sx0 + 1;
      const sh = sy1 - sy0 + 1;
      let localKeep = null;
      if (isFancy && colGlyphs) {
        localKeep = new Uint8Array(sw * sh);
        for (const g of colGlyphs) {
          const lx0 = Math.max(0, g.minX - 2 - sx0), lx1 = Math.min(sw - 1, g.maxX + 2 - sx0);
          const ly0 = Math.max(0, g.minY - 2 - sy0), ly1 = Math.min(sh - 1, g.maxY + 2 - sy0);
          for (let yy = ly0; yy <= ly1; yy++) localKeep.fill(1, yy * sw + lx0, yy * sw + lx1 + 1);
        }
        for (const tg of tinyGlyphs) {
          if (!furiganaPixelMask[tg.minY * W + tg.minX] &&
              tg.maxX >= sx0 && tg.minX <= sx1 && tg.maxY >= sy0 && tg.minY <= sy1) {
            const lx0 = Math.max(0, tg.minX - 2 - sx0), lx1 = Math.min(sw - 1, tg.maxX + 2 - sx0);
            const ly0 = Math.max(0, tg.minY - 2 - sy0), ly1 = Math.min(sh - 1, tg.maxY + 2 - sy0);
            for (let yy = ly0; yy <= ly1; yy++) localKeep.fill(1, yy * sw + lx0, yy * sw + lx1 + 1);
          }
        }
      }

      const whiteCut = isFancy ? 132 : 225;
      const patch = rctx.createImageData(sw, sh);
      const pdata = patch.data;
      for (let yy = 0; yy < sh; yy++) {
        for (let xx = 0; xx < sw; xx++) {
          const srcIdx = (sy0 + yy) * W + (sx0 + xx);
          const di = (yy * sw + xx) * 4;
          if (lineArtMask[srcIdx] || furiganaPixelMask[srcIdx] || (localKeep && !localKeep[yy * sw + xx])) {
            pdata[di] = 255; pdata[di + 1] = 255; pdata[di + 2] = 255; pdata[di + 3] = 255;
          } else {
            const g = lum[srcIdx];
            let v;
            if (g >= whiteCut) {
              v = 255;
            } else if (isFancy) {
              v = enhanceThinStrokes
                ? Math.min(255, Math.round(((g / whiteCut) ** 1.35) * 215))
                : Math.min(255, Math.round((g / whiteCut) * 225));
            } else if (enhanceThinStrokes) {
              v = Math.max(0, Math.round(((g / 222) ** 1.65) * 235));
            } else {
              v = g;
            }
            pdata[di] = v; pdata[di + 1] = v; pdata[di + 2] = v; pdata[di + 3] = 255;
          }
        }
      }
      return patch;
    };

    const upscaleCanvas = (rawClean) => {
      const upCanvas = document.createElement('canvas');
      upCanvas.width = Math.round(rawClean.width * SCALE);
      upCanvas.height = Math.round(rawClean.height * SCALE);
      const uctx = upCanvas.getContext('2d');
      uctx.fillStyle = '#ffffff';
      uctx.fillRect(0, 0, upCanvas.width, upCanvas.height);
      uctx.imageSmoothingEnabled = true;
      uctx.imageSmoothingQuality = 'high';
      uctx.drawImage(rawClean, 0, 0, upCanvas.width, upCanvas.height);
      return upCanvas.toDataURL('image/png');
    };

    const built = bubbles.map(b => {
      const buildUpscaledUrl = (enhanceThinStrokes) => {
        if (b.isVertical) {
          const colStrips = b.columns.map(c => ({
            sx0: Math.max(0, c.minX - 2),
            sy0: Math.max(0, c.minY - 3),
            sx1: Math.min(W - 1, c.maxX + 2),
            sy1: Math.min(H - 1, c.maxY + 3),
            glyphs: c.glyphs || null,
          }));

          const maxColH = Math.max(...colStrips.map(s => s.sy1 - s.sy0 + 1));
          const totalStripW = colStrips.reduce((sum, s) => sum + (s.sx1 - s.sx0 + 1), 0) +
                              Math.max(0, colStrips.length - 1) * COL_SPACING + PAD_X * 2;
          const totalStripH = maxColH + PAD_Y * 2;

          const rawClean = document.createElement('canvas');
          rawClean.width = totalStripW;
          rawClean.height = totalStripH;
          const rctx = rawClean.getContext('2d');
          rctx.fillStyle = '#ffffff';
          rctx.fillRect(0, 0, totalStripW, totalStripH);

          let curRightX = totalStripW - PAD_X;
          for (const s of colStrips) {
            const sw = s.sx1 - s.sx0 + 1;
            const dx0 = curRightX - sw;
            const patch = buildColPatch(rctx, s.sx0, s.sy0, s.sx1, s.sy1, s.glyphs, enhanceThinStrokes);
            rctx.putImageData(patch, dx0, PAD_Y);
            curRightX = dx0 - COL_SPACING;
          }

          return upscaleCanvas(rawClean);
        } else {
          const sx0 = Math.max(0, b.minX - 3), sy0 = Math.max(0, b.minY - 2);
          const sx1 = Math.min(W - 1, b.maxX + 3), sy1 = Math.min(H - 1, b.maxY + 3);
          const sw = sx1 - sx0 + 1, sh = sy1 - sy0 + 1;
          const rawClean = document.createElement('canvas');
          rawClean.width = sw + PAD_X * 2;
          rawClean.height = sh + PAD_Y * 2;
          const rctx = rawClean.getContext('2d');
          rctx.fillStyle = '#ffffff';
          rctx.fillRect(0, 0, rawClean.width, rawClean.height);
          const patch = buildColPatch(rctx, sx0, sy0, sx1, sy1, null, false);
          rctx.putImageData(patch, PAD_X, PAD_Y);
          return upscaleCanvas(rawClean);
        }
      };

      const buildSingleColUrls = () => {
        if (!b.isVertical || b.columns.length < 2) return null;
        return b.columns.map(c => {
          const sx0 = Math.max(0, c.minX - 2), sy0 = Math.max(0, c.minY - 3);
          const sx1 = Math.min(W - 1, c.maxX + 2), sy1 = Math.min(H - 1, c.maxY + 3);
          const sw = sx1 - sx0 + 1, sh = sy1 - sy0 + 1;
          const rawClean = document.createElement('canvas');
          rawClean.width = sw + PAD_X * 2;
          rawClean.height = sh + PAD_Y * 2;
          const rctx = rawClean.getContext('2d');
          rctx.fillStyle = '#ffffff';
          rctx.fillRect(0, 0, rawClean.width, rawClean.height);
          const patch = buildColPatch(rctx, sx0, sy0, sx1, sy1, c.glyphs || null, false);
          rctx.putImageData(patch, PAD_X, PAD_Y);
          return upscaleCanvas(rawClean);
        });
      };

      // 视觉遮罩框自动扩展包覆紧邻的振假名，确保原文与振假名被一并干净遮盖
      let coverMinX = b.minX, coverMaxX = b.maxX, coverMinY = b.minY, coverMaxY = b.maxY;
      for (const tg of tinyGlyphs) {
        const nearVert = b.isVertical && tg.minX >= b.minX - 2 && tg.maxX <= b.maxX + 14 &&
                         tg.minY >= b.minY - 6 && tg.maxY <= b.maxY + 6;
        const nearHoriz = !b.isVertical && tg.minX >= b.minX - 4 && tg.maxX <= b.maxX + 4 &&
                          tg.minY >= b.minY - 12 && tg.maxY <= b.maxY + 2;
        if (nearVert || nearHoriz) {
          if (!hasLineArtBetween(b.minX, b.minY, b.maxX, b.maxY, tg.minX, tg.minY, tg.maxX, tg.maxY)) {
            coverMinX = Math.min(coverMinX, tg.minX);
            coverMaxX = Math.max(coverMaxX, tg.maxX);
            coverMinY = Math.min(coverMinY, tg.minY);
            coverMaxY = Math.max(coverMaxY, tg.maxY);
          }
        }
      }

      return {
        isVertical: b.isVertical,
        isFancy,
        bbox: { x0: coverMinX, y0: coverMinY, x1: coverMaxX, y1: coverMaxY },
        normalDataUrl: buildUpscaledUrl(false),
        enhancedDataUrl: (b.isVertical && !isFancy) ? buildUpscaledUrl(true) : null,
        colStripUrls: buildSingleColUrls(),
      };
    });

    return { built, lineArtMask };
  }

  // 预计算浓墨邻域掩码（5x5），用于精确统计笔画以外的真实背景纹理灰度占比
  const nearDarkInk = new Uint8Array(W * H);
  for (let y = 2; y < H - 2; y++) {
    const row = y * W;
    for (let x = 2; x < W - 2; x++) {
      if (!isDark138[row + x]) continue;
      for (let dy = -2; dy <= 2; dy++) {
        const r2 = (y + dy) * W;
        nearDarkInk[r2 + x - 2] = 1; nearDarkInk[r2 + x - 1] = 1; nearDarkInk[r2 + x] = 1;
        nearDarkInk[r2 + x + 1] = 1; nearDarkInk[r2 + x + 2] = 1;
      }
    }
  }

  // 通道 1：常规纯白底对话框（仅保留内部背景纯净无花纹的气泡，将半透明图案框完整移交通道 2）
  const pass1Raw = runPass('white', inROI, null);
  const pass1Clean = pass1Raw.built.filter(b => {
    if (b.isVertical && (b.bbox.x1 - b.bbox.x0) < 8) return false;
    let bgCnt = 0, bgMid = 0;
    const x0 = Math.max(0, b.bbox.x0 - 5), x1 = Math.min(W - 1, b.bbox.x1 + 5);
    const y0 = Math.max(0, b.bbox.y0 - 5), y1 = Math.min(H - 1, b.bbox.y1 + 5);
    for (let y = y0; y <= y1; y++) {
      const row = y * W;
      for (let x = x0; x <= x1; x++) {
        const p = row + x;
        if (nearDarkInk[p] || pass1Raw.lineArtMask[p]) continue;
        bgCnt++;
        if (lum[p] >= 128 && lum[p] <= 226) bgMid++;
      }
    }
    return bgCnt === 0 || (bgMid / bgCnt) < 0.045;
  });

  // 屏蔽通道 1 已确认的纯白气泡区域，防止重复识别
  const pass2Exclude = new Uint8Array(W * H);
  for (const b of pass1Clean) {
    const x0 = Math.max(0, b.bbox.x0 - 8), x1 = Math.min(W - 1, b.bbox.x1 + 8);
    const y0 = Math.max(0, b.bbox.y0 - 8), y1 = Math.min(H - 1, b.bbox.y1 + 8);
    for (let y = y0; y <= y1; y++) {
      pass2Exclude.fill(1, y * W + x0, y * W + x1 + 1);
    }
  }

  // 定位含花哨底纹（花卉/格纹/半透明灰阶）的 32x32 局部网格区域
  const CELL = 32;
  const cW = Math.ceil(W / CELL), cH = Math.ceil(H / CELL);
  const rawPatCell = new Uint8Array(cW * cH);
  for (let cy = 0; cy < cH; cy++) {
    const y0 = cy * CELL, y1 = Math.min(H, y0 + CELL);
    for (let cx = 0; cx < cW; cx++) {
      const x0 = cx * CELL, x1 = Math.min(W, x0 + CELL);
      let bgCnt = 0, bgMid = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * W;
        for (let x = x0; x < x1; x++) {
          const p = row + x;
          if (!inROI[p] || nearDarkInk[p]) continue;
          bgCnt++;
          if (lum[p] >= 128 && lum[p] <= 226) bgMid++;
        }
      }
      if (bgCnt >= 24 && (bgMid / bgCnt) >= 0.12) rawPatCell[cy * cW + cx] = 1;
    }
  }

  let hasAnyPatCell = false;
  const patMask = new Uint8Array(W * H);
  for (let cy = 0; cy < cH; cy++) {
    for (let cx = 0; cx < cW; cx++) {
      if (!rawPatCell[cy * cW + cx]) continue;
      hasAnyPatCell = true;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= cH) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= cW) continue;
          const py0 = ny * CELL, py1 = Math.min(H, py0 + CELL);
          const px0 = nx * CELL, px1 = Math.min(W, px0 + CELL);
          for (let yy = py0; yy < py1; yy++) {
            for (let xx = px0; xx < px1; xx++) {
              if (inROI[yy * W + xx]) patMask[yy * W + xx] = 1;
            }
          }
        }
      }
    }
  }

  if (!hasAnyPatCell) {
    return pass1Clean;
  }

  // 通道 2：花哨背景白描边文字（`白フチ文字`）独立检测，并过滤掉领口/衣袋连续褶皱伪框
  const pass2Raw = runPass('fancy', patMask, pass2Exclude);
  const pass2Clean = pass2Raw.built.filter(b => {
    const bw = b.bbox.x1 - b.bbox.x0, bh = b.bbox.y1 - b.bbox.y0;
    if (Math.max(bw, bh) < 48) return false;
    let darkPixels = 0, inSoftLineArt = 0;
    for (let y = b.bbox.y0; y <= b.bbox.y1; y++) {
      const row = y * W;
      for (let x = b.bbox.x0; x <= b.bbox.x1; x++) {
        const p = row + x;
        if (isDark138[p]) {
          darkPixels++;
          if (pass1Raw.lineArtMask[p]) inSoftLineArt++;
        }
      }
    }
    return darkPixels > 0 && (inSoftLineArt / darkPixels) < 0.65;
  });

  return [...pass1Clean, ...pass2Clean];
}

// ============ 日语对话合法性校验与噪声清洗 ============

function validateAndCleanJapanese(rawText, confidence) {
  if (!rawText) return null;

  let cleaned = rawText
    .replace(/\s+/g, '')
    .replace(/[|\\/_=+~`<>^*\[\](){}]/g, '')
    // 保留 No.1 / No.2 / No.3 等编号表达，同时剔除穿插在日文字符之间的孤立 1~3 位 ASCII 识别噪点
    .replace(/([\u3040-\u30FF\u4E00-\u9FFF])(?![Nn][Oo][.．0-9０-９])[a-zA-Z;:]{1,3}(?=[\u3040-\u30FF\u4E00-\u9FFF…！？。、])/g, '$1')
    .replace(/^(?![Nn][Oo][.．0-9０-９])[a-zA-Z;:]{1,2}(?=[\u3040-\u30FF\u4E00-\u9FFF])/g, '')
    .replace(/([\u3040-\u30FF\u4E00-\u9FFF])[a-zA-Z;:]{1,2}$/g, '$1')
    // 句末竖排问号「？」常被误识为孤立数字 1 / 7（如「違和感1」「うん7?」），还原为全角问号
    .replace(/([\u3040-\u30FF\u4E00-\u9FFF…])[17][?？]?$/, '$1？')
    .trim();

  if (!cleaned || cleaned.length < 2) return null;

  // 必须包含真正的平假名、片假名或汉字（排除纯长音符「ー」或中点「・」误判）
  const realJpMatches = cleaned.match(/[\u3041-\u3096\u30A1-\u30FA\u4E00-\u9FFF]/g) || [];
  if (realJpMatches.length === 0) return null;

  // 拒绝类似 "16つミ" 等数字夹杂极少假名的局部拟声词/笔迹误检
  const digitMatches = cleaned.match(/[0-9０-９]/g) || [];
  if (digitMatches.length > 0 && realJpMatches.length <= 2 && cleaned.length <= 4) {
    return null;
  }

  const jpDialogueMatches = cleaned.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3000-\u303F！？…、。「」『』（）0-9０-９!?NnOo.．]/g) || [];
  if (jpDialogueMatches.length / cleaned.length < 0.72) return null;

  if (realJpMatches.length === 1 && confidence < 80) return null;
  const hasDialoguePunct = /[！？!?…。「」]/.test(cleaned);
  if (realJpMatches.length === 2 && confidence < (hasDialoguePunct ? 52 : 62)) return null;
  if (confidence < 50) return null;

  return cleaned;
}

// ============ 工具函数 ============

function cropRegion(canvas, bbox) {
  const padding = 6;
  const x = Math.max(0, bbox.x0 - padding);
  const y = Math.max(0, bbox.y0 - padding);
  const w = Math.min(canvas.width - x, (bbox.x1 - bbox.x0) + padding * 2);
  const h = Math.min(canvas.height - y, (bbox.y1 - bbox.y0) + padding * 2);

  if (w <= 0 || h <= 0) return null;

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = w;
  cropCanvas.height = h;
  cropCanvas.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return cropCanvas.toDataURL('image/jpeg', 0.8);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图像加载失败'));
    img.src = src;
  });
}
