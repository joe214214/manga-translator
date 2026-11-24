const puppeteer = require('puppeteer-core');
const path = require('path');
const os = require('os');
const fs = require('fs');

async function runLiveTest() {
  const extPath = path.resolve('.');
  console.log('====================================================');
  console.log('   FULL AUTOMATED BROWSER TEST ON SHONEN JUMP+      ');
  console.log('====================================================');
  console.log('Extension path:', extPath);

  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const tmpDir = path.join(os.tmpdir(), 'live_test_' + Date.now());

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: edgePath,
    userDataDir: tmpDir,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,950'
    ]
  });

  console.log('Browser launched. Initializing targets...');
  await new Promise(r => setTimeout(r, 2000));

  for (const t of browser.targets()) {
    if (t.type() === 'service_worker') {
      try {
        const swClient = await t.createCDPSession();
        await swClient.send('Runtime.enable');
        swClient.on('Runtime.consoleAPICalled', p => {
          console.log('[SW LOG]', p.args.map(a => a.value || a.description).join(' '));
        });
      } catch (e) {}
    }
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 850 });

  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[MangaTranslator]') || text.includes('[Offscreen]')) {
      console.log('[BROWSER LOG]', text);
    }
  });

  const jumpUrl = 'https://shonenjumpplus.com/episode/9253191257538010369';
  console.log('Opening manga URL:', jumpUrl);
  await page.goto(jumpUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });

  console.log('Waiting 6s for initial reader render...');
  await new Promise(r => setTimeout(r, 6000));

  // Turn to dialogue page: click left side of reader twice
  console.log('\n>>> Turning page by clicking left side (x: 200, y: 400)...');
  await page.mouse.click(200, 400);
  await new Promise(r => setTimeout(r, 1500));
  await page.mouse.click(200, 400);

  console.log('Waiting 12s for translation pipeline to complete...');
  for (let s = 1; s <= 12; s++) {
    await new Promise(r => setTimeout(r, 1000));
    const status = await page.evaluate(() => {
      const blocks = document.querySelectorAll('.manga-translator-block');
      const toast = document.querySelector('.manga-translator-toast');
      const loading = document.getElementById('manga-translator-loading');
      return {
        blocksCount: blocks.length,
        toast: toast ? toast.innerText : null,
        loadingVisible: loading ? (loading.style.display !== 'none') : false
      };
    });
    if (status.blocksCount > 0 || status.toast || status.loadingVisible) {
      console.log(` [T+${s}s] Overlay Blocks: ${status.blocksCount}, Toast: "${status.toast}", Loading: ${status.loadingVisible}`);
    }
  }

  // Extract all translated text blocks from the real DOM
  const results = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('.manga-translator-block')).map(b => {
      const textEl = b.querySelector('.manga-translator-text');
      const tipEl = b.querySelector('.manga-translator-original');
      return {
        chineseText: textEl ? textEl.innerText.trim() : b.innerText.trim(),
        details: tipEl ? tipEl.innerText.trim() : b.title,
        style: {
          top: b.style.top,
          left: b.style.left,
          width: b.style.width,
          height: b.style.height
        }
      };
    });

    return {
      totalBlocks: blocks.length,
      blocks: blocks
    };
  });

  console.log('\n====================================================');
  console.log('             TRANSLATION VERIFICATION RESULT        ');
  console.log('====================================================');
  console.log(JSON.stringify(results, null, 2));

  // Save screenshot of the manga page with translations rendered
  const scPath = path.join(__dirname, 'live_browser_translated.png');
  await page.screenshot({ path: scPath });
  console.log('\nSaved final screenshot to:', scPath);

  // Now test turning to the next page to verify that:
  // 1. Previous overlays clear immediately without lingering
  // 2. No infinite refreshing or flashing loops occur
  console.log('\n>>> Testing next page turn (Page 3)...');
  await page.mouse.click(200, 400);
  await new Promise(r => setTimeout(r, 1500));
  await page.mouse.click(200, 400);

  console.log('Verifying Page 3 stability over 8s...');
  for (let s = 1; s <= 8; s++) {
    await new Promise(r => setTimeout(r, 1000));
    const status = await page.evaluate(() => {
      const blocks = document.querySelectorAll('.manga-translator-block');
      return blocks.length;
    });
    console.log(` [Page 3 T+${s}s] Active Blocks: ${status}`);
  }

  const p3Path = path.join(__dirname, 'live_browser_page3.png');
  await page.screenshot({ path: p3Path });
  console.log('Saved Page 3 screenshot to:', p3Path);

  await browser.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  console.log('Browser test closed successfully.');
}

runLiveTest().catch(err => {
  console.error('Test run failed:', err);
  process.exit(1);
});
