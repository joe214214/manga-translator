# Manga Translator

[中文](./README.md) | English

A Chrome / Edge extension (Manifest V3) that translates Japanese web manga in real time and overlays the translated text onto the original speech bubbles. Works with both `<img>` and `<canvas>` readers such as Shonen Jump+.

## How It Works

- **Page detection**: Listens for scrolling, keyboard navigation, clicks, and DOM updates with debouncing, and skips unchanged views using frame fingerprinting.
- **Local OCR**: Runs offline Tesseract.js (`jpn_vert` for vertical text and `jpn` for horizontal text) inside an Offscreen Document without spending LLM tokens. Preprocessing strips Japanese furigana (ruby text) and handles both standard white speech bubbles and white-outlined text over patterned backgrounds.
- **Batch translation**: Sends all detected lines on a page in a single request with an in-memory cache. Supports either the Gemini API or Google Cloud Translation API v2, translating into Simplified Chinese, Traditional Chinese, English, or Korean.
- **In-place typesetting**: Renders vertical (`vertical-rl`) or horizontal overlays with binary-searched font sizing. Hover over a bubble to inspect the recognized Japanese text, or click a bubble to toggle between the translation and the original image.

## Setup

The repository already includes the required Tesseract WASM binaries and `jpn` / `jpn_vert` traineddata files, so no build step is needed after cloning:

```bash
git clone https://github.com/joe214214/manga-translator.git
```

1. Open `chrome://extensions/` or `edge://extensions/` and turn on **Developer mode**.
2. Click **Load unpacked** and select the project root directory.
3. Click the extension icon in the toolbar and enter either key, then save:
   - **Gemini API Key**: Generate one for free in [Google AI Studio](https://aistudio.google.com/apikey).
   - **Google Cloud Translation API Key**: Create one in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) with Cloud Translation API enabled.
4. Open a Japanese manga page and turn pages normally, or click the manual translate button in the popup.

API keys are stored locally in your browser via `chrome.storage.sync`.

## Project Structure

```text
├── manifest.json            # Extension manifest (Manifest V3)
├── background/              # Tab capture, caching, and translation requests
├── offscreen/               # Image preprocessing and local Tesseract OCR
├── content/                 # Page-turn detection and overlay rendering
├── popup/                   # Settings popup UI
├── styles/                  # Overlay stylesheet
├── lib/tesseract/           # Offline WASM core and jpn / jpn_vert models
├── test/index.html          # Local test page with sample manga panels
└── setup.js                 # Helper script to refresh OCR assets and icons
```

## Development

To re-copy the Tesseract runtime and re-download language data from scratch:

```bash
npm install
npm run setup
```

To test offline, enable **Allow access to file URLs** on the extension details page and open `test/index.html` in your browser.

## License

MIT
