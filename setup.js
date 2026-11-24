/**
 * setup.js — 漫画翻译器插件初始化脚本
 * 
 * 功能：
 * 1. 从 node_modules 复制 Tesseract.js 相关文件
 * 2. 下载日语 OCR 训练数据（tessdata_fast）
 * 3. 生成插件图标
 * 
 * 使用方法：
 *   npm install
 *   node setup.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

// ============ 路径配置 ============
const ROOT = __dirname;
const LIB_DIR = path.join(ROOT, 'lib', 'tesseract');
const TRAINEDDATA_DIR = path.join(LIB_DIR, 'traineddata');
const ICONS_DIR = path.join(ROOT, 'icons');

// Tesseract.js 文件映射：目标文件名 → 可能的源路径列表
const TESSERACT_FILES = {
  'tesseract.min.js': [
    'node_modules/tesseract.js/dist/tesseract.min.js',
    'node_modules/tesseract.js/dist/tesseract.js',
  ],
  'worker.min.js': [
    'node_modules/tesseract.js/dist/worker.min.js',
    'node_modules/tesseract.js/dist/worker.js',
  ],
  'tesseract-core-simd-lstm.wasm.js': [
    'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  ],
  'tesseract-core-simd-lstm.wasm': [
    'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm',
  ],
  'tesseract-core-lstm.wasm.js': [
    'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js',
  ],
  'tesseract-core-lstm.wasm': [
    'node_modules/tesseract.js-core/tesseract-core-lstm.wasm',
  ],
  'tesseract-core-simd.wasm.js': [
    'node_modules/tesseract.js-core/tesseract-core-simd.wasm.js',
  ],
  'tesseract-core-simd.wasm': [
    'node_modules/tesseract.js-core/tesseract-core-simd.wasm',
  ],
  'tesseract-core.wasm.js': [
    'node_modules/tesseract.js-core/tesseract-core.wasm.js',
  ],
  'tesseract-core.wasm': [
    'node_modules/tesseract.js-core/tesseract-core.wasm',
  ],
};

// 训练数据下载 URL（使用 tessdata_fast，体积小、速度快）
const TRAINEDDATA_URLS = {
  'jpn.traineddata': 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/jpn.traineddata',
  'jpn_vert.traineddata': 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/jpn_vert.traineddata',
};

// ============ 主流程 ============
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   🎌 漫画翻译器 — 插件初始化脚本     ║');
  console.log('╚══════════════════════════════════════╝\n');

  // 检查 node_modules
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    console.log('⚠️  未找到 node_modules，正在运行 npm install...\n');
    const { execSync } = require('child_process');
    execSync('npm install', { stdio: 'inherit', cwd: ROOT });
    console.log('');
  }

  // 创建目录
  ensureDir(LIB_DIR);
  ensureDir(TRAINEDDATA_DIR);
  ensureDir(ICONS_DIR);

  // Step 1: 复制 Tesseract.js 文件
  console.log('📦 Step 1: 复制 Tesseract.js 文件...');
  let allCopied = true;
  for (const [target, sources] of Object.entries(TESSERACT_FILES)) {
    let copied = false;
    for (const src of sources) {
      const fullPath = path.join(ROOT, src);
      if (fs.existsSync(fullPath)) {
        fs.copyFileSync(fullPath, path.join(LIB_DIR, target));
        const size = (fs.statSync(fullPath).size / 1024).toFixed(1);
        console.log(`   ✅ ${target} (${size} KB)`);
        copied = true;
        break;
      }
    }
    if (!copied) {
      console.log(`   ❌ ${target} — 未找到源文件`);
      allCopied = false;
    }
  }

  if (!allCopied) {
    console.log('\n⚠️  部分 Tesseract 文件未找到，请确认 npm install 已成功执行。');
    console.log('   可尝试运行: npm install tesseract.js@5\n');
  }

  // Step 2: 下载训练数据
  console.log('\n📥 Step 2: 下载日语 OCR 训练数据...');
  console.log('   （文件较大，约 5MB/个，请耐心等待）\n');

  for (const [filename, url] of Object.entries(TRAINEDDATA_URLS)) {
    const dest = path.join(TRAINEDDATA_DIR, filename);
    if (fs.existsSync(dest)) {
      const size = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
      console.log(`   ⏭️  ${filename} 已存在 (${size} MB)，跳过`);
      continue;
    }
    try {
      process.stdout.write(`   ⏳ 正在下载 ${filename}...`);
      await downloadFile(url, dest);
      const size = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
      console.log(` ✅ (${size} MB)`);
    } catch (err) {
      console.log(` ❌ 下载失败: ${err.message}`);
      console.log(`      请手动下载: ${url}`);
      console.log(`      放置到: ${dest}\n`);
    }
  }

  // Step 3: 生成图标
  console.log('\n🎨 Step 3: 生成插件图标...');
  generateIcons();

  // 完成
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║          ✅ 初始化完成！              ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('\n📌 加载插件到 Chrome:');
  console.log('   1. 打开 chrome://extensions/');
  console.log('   2. 开启右上角「开发者模式」');
  console.log('   3. 点击「加载已解压的扩展程序」');
  console.log(`   4. 选择此文件夹: ${ROOT}`);
  console.log('\n📌 使用方法:');
  console.log('   1. 点击插件图标，填入 Google Translate API Key');
  console.log('   2. 打开任意漫画网站');
  console.log('   3. 启用翻译后，滚动/翻页即可自动翻译');
}

// ============ 工具函数 ============

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 下载文件（支持 HTTP 重定向）
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    function doRequest(requestUrl, redirectCount) {
      if (redirectCount > 5) {
        reject(new Error('重定向次数过多'));
        return;
      }

      const protocol = requestUrl.startsWith('https') ? https : http;
      protocol.get(requestUrl, (response) => {
        // 处理重定向
        if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            doRequest(redirectUrl, redirectCount + 1);
            return;
          }
        }

        if (response.statusCode !== 200) {
          fs.unlinkSync(dest);
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        response.pipe(file);
        file.on('finish', () => {
          file.close(resolve);
        });
        file.on('error', (err) => {
          fs.unlinkSync(dest);
          reject(err);
        });
      }).on('error', (err) => {
        fs.unlinkSync(dest);
        reject(err);
      });
    }

    doRequest(url, 0);
  });
}

// ============ 图标生成 ============

/**
 * CRC32 计算（PNG 格式需要）
 */
function crc32(buf) {
  // 预计算 CRC32 查找表
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }

  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * 创建 PNG chunk
 */
function createPNGChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length);
  const combined = Buffer.concat([typeBytes, data]);
  const crcValue = crc32(combined);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcValue);
  return Buffer.concat([lengthBuf, combined, crcBuf]);
}

/**
 * 生成插件图标 PNG
 * 蓝底白色 "T" 字样（代表 Translate）
 */
function createIconPNG(size) {
  // PNG 文件头
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);   // width
  ihdr.writeUInt32BE(size, 4);   // height
  ihdr[8] = 8;                   // bit depth
  ihdr[9] = 6;                   // color type: RGBA
  ihdr[10] = 0;                  // compression
  ihdr[11] = 0;                  // filter
  ihdr[12] = 0;                  // interlace
  const ihdrChunk = createPNGChunk('IHDR', ihdr);

  // 图像数据
  const rowBytes = 1 + size * 4; // 滤波字节 + RGBA
  const rawData = Buffer.alloc(rowBytes * size);

  // 颜色定义
  const bg = { r: 66, g: 133, b: 244 };     // Google Blue
  const border = { r: 45, g: 98, b: 198 };   // 深蓝边框
  const fg = { r: 255, g: 255, b: 255 };     // 白色文字

  const borderWidth = Math.max(1, Math.floor(size / 16));
  const radius = Math.floor(size * 0.18); // 圆角

  for (let y = 0; y < size; y++) {
    rawData[y * rowBytes] = 0; // 滤波: None
    for (let x = 0; x < size; x++) {
      const i = y * rowBytes + 1 + x * 4;

      // 圆角矩形检测
      const inCorner = isInCornerRegion(x, y, size, radius);

      // 边框检测
      const isBorder = x < borderWidth || x >= size - borderWidth ||
                        y < borderWidth || y >= size - borderWidth;

      // "T" 字形检测（居中）
      const cx = size / 2;
      const tBarTop = size * 0.25;
      const tBarHeight = size * 0.1;
      const tBarHalfWidth = size * 0.3;
      const tStemHalfWidth = size * 0.08;
      const tStemBottom = size * 0.78;

      const isT = (
        // T 的横杠
        (y >= tBarTop && y < tBarTop + tBarHeight &&
         x >= cx - tBarHalfWidth && x < cx + tBarHalfWidth) ||
        // T 的竖杠
        (y >= tBarTop + tBarHeight && y < tStemBottom &&
         x >= cx - tStemHalfWidth && x < cx + tStemHalfWidth)
      );

      let r, g, b, a;
      if (inCorner) {
        r = g = b = a = 0; // 透明
      } else if (isBorder) {
        r = border.r; g = border.g; b = border.b; a = 255;
      } else if (isT) {
        r = fg.r; g = fg.g; b = fg.b; a = 255;
      } else {
        r = bg.r; g = bg.g; b = bg.b; a = 255;
      }

      rawData[i] = r;
      rawData[i + 1] = g;
      rawData[i + 2] = b;
      rawData[i + 3] = a;
    }
  }

  const compressed = zlib.deflateSync(rawData);
  const idatChunk = createPNGChunk('IDAT', compressed);
  const iendChunk = createPNGChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

/**
 * 检测是否在圆角区域外（需要透明处理）
 */
function isInCornerRegion(x, y, size, radius) {
  const corners = [
    { cx: radius, cy: radius },                       // 左上
    { cx: size - radius - 1, cy: radius },             // 右上
    { cx: radius, cy: size - radius - 1 },             // 左下
    { cx: size - radius - 1, cy: size - radius - 1 },  // 右下
  ];

  for (const corner of corners) {
    const inCornerSquare = (
      (x <= corner.cx && y <= corner.cy && corner === corners[0]) ||
      (x >= corner.cx && y <= corner.cy && corner === corners[1]) ||
      (x <= corner.cx && y >= corner.cy && corner === corners[2]) ||
      (x >= corner.cx && y >= corner.cy && corner === corners[3])
    );

    if (inCornerSquare) {
      const dx = x - corner.cx;
      const dy = y - corner.cy;
      if (dx * dx + dy * dy > radius * radius) {
        return true; // 在圆角外
      }
    }
  }
  return false;
}

function generateIcons() {
  const sizes = [16, 48, 128];
  for (const size of sizes) {
    const png = createIconPNG(size);
    const dest = path.join(ICONS_DIR, `icon${size}.png`);
    fs.writeFileSync(dest, png);
    console.log(`   ✅ icon${size}.png (${png.length} bytes)`);
  }
}

// ============ 运行 ============
main().catch((err) => {
  console.error('\n❌ 初始化失败:', err.message);
  process.exit(1);
});
