/**
 * popup.js — 插件设置弹出窗口逻辑
 * 
 * 负责：
 * - 加载/保存设置到 chrome.storage.sync
 * - 管理 UI 交互（开关、滑块、密码显示等）
 * - 通知 service worker 和 content script 设置更新
 */

// 默认设置
const DEFAULT_SETTINGS = {
  enabled: true,
  googleApiKey: '',
  geminiApiKey: '',
  ocrThreshold: 60,
  targetLang: 'zh-CN',
  debounceDelay: 800,
};

// ============ 初始化 ============

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  setupEventListeners();
});

/**
 * 从 chrome.storage 加载设置并填充 UI
 */
function loadSettings() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    // 填充表单
    document.getElementById('enableToggle').checked = settings.enabled;
    document.getElementById('googleApiKey').value = settings.googleApiKey;
    document.getElementById('geminiApiKey').value = settings.geminiApiKey;
    document.getElementById('ocrThreshold').value = settings.ocrThreshold;
    document.getElementById('thresholdValue').textContent = settings.ocrThreshold;
    document.getElementById('targetLang').value = settings.targetLang;
    document.getElementById('debounceDelay').value = settings.debounceDelay;
    document.getElementById('debounceValue').textContent = settings.debounceDelay;

    // 更新状态提示
    updateStatusHint(settings.enabled);
  });
}

/**
 * 设置所有事件监听器
 */
function setupEventListeners() {
  // 开关 — 立即保存并通知
  document.getElementById('enableToggle').addEventListener('change', (e) => {
    const enabled = e.target.checked;
    updateStatusHint(enabled);
    chrome.storage.sync.set({ enabled }, () => {
      notifySettingsUpdated();
      showStatus(enabled ? '✅ 翻译已启用' : '⏸️ 翻译已暂停', enabled ? 'success' : 'info');
    });
  });

  // OCR 阈值滑块
  document.getElementById('ocrThreshold').addEventListener('input', (e) => {
    document.getElementById('thresholdValue').textContent = e.target.value;
  });

  // 延迟滑块
  document.getElementById('debounceDelay').addEventListener('input', (e) => {
    document.getElementById('debounceValue').textContent = e.target.value;
  });

  // 密码显示/隐藏按钮
  document.querySelectorAll('.toggle-visibility').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const input = document.getElementById(targetId);
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = '🔒';
      } else {
        input.type = 'password';
        btn.textContent = '👁️';
      }
    });
  });

  // 保存按钮
  document.getElementById('saveBtn').addEventListener('click', saveSettings);

  // 立即翻译按钮
  document.getElementById('translateNowBtn').addEventListener('click', translateNow);
}

/**
 * 保存所有设置
 */
function saveSettings() {
  const googleApiKey = document.getElementById('googleApiKey').value.trim();
  const geminiApiKey = document.getElementById('geminiApiKey').value.trim();

  // 验证：两者至少填一个
  if (!googleApiKey && !geminiApiKey) {
    showStatus('❌ 请至少填写一个 API Key（推荐免费的 Gemini Key）', 'error');
    document.getElementById('geminiApiKey').focus();
    return;
  }

  const settings = {
    enabled: document.getElementById('enableToggle').checked,
    googleApiKey: googleApiKey,
    geminiApiKey: geminiApiKey,
    ocrThreshold: parseInt(document.getElementById('ocrThreshold').value),
    targetLang: document.getElementById('targetLang').value,
    debounceDelay: parseInt(document.getElementById('debounceDelay').value),
  };

  chrome.storage.sync.set(settings, () => {
    if (chrome.runtime.lastError) {
      showStatus('❌ 保存失败: ' + chrome.runtime.lastError.message, 'error');
    } else {
      showStatus('✅ 设置已保存', 'success');
      notifySettingsUpdated();
    }
  });
}

/**
 * 立即翻译当前页面
 */
async function translateNow() {
  try {
    // 获取当前活动标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      showStatus('❌ 未找到活动标签页', 'error');
      return;
    }

    // 检查 API Key
    const settings = await chrome.storage.sync.get(['googleApiKey', 'geminiApiKey']);
    if (!settings.googleApiKey && !settings.geminiApiKey) {
      showStatus('❌ 请先填写 API Key（推荐免费的 Gemini Key）', 'error');
      return;
    }

    // 发送翻译指令到 service worker
    chrome.runtime.sendMessage({
      type: 'TRANSLATE_NOW',
      tabId: tab.id,
    });

    showStatus('🔄 正在翻译...', 'info');

    // 3 秒后关闭弹窗，让用户查看翻译结果
    setTimeout(() => window.close(), 1500);
  } catch (err) {
    showStatus('❌ ' + err.message, 'error');
  }
}

// ============ 工具函数 ============

/**
 * 通知 content script 和 service worker 设置已更新
 */
function notifySettingsUpdated() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    chrome.runtime.sendMessage({
      type: 'SETTINGS_UPDATED',
      settings,
    });
  });
}

/**
 * 更新启用状态提示文字
 */
function updateStatusHint(enabled) {
  const hint = document.getElementById('statusHint');
  hint.textContent = enabled ? '运行中' : '已关闭';
  hint.classList.toggle('active', enabled);
}

/**
 * 显示状态消息
 */
function showStatus(text, type) {
  const bar = document.getElementById('statusBar');
  const textEl = document.getElementById('statusText');

  textEl.textContent = text;
  bar.className = `status-bar ${type}`;

  // 3 秒后自动隐藏
  clearTimeout(showStatus._timer);
  showStatus._timer = setTimeout(() => {
    bar.className = 'status-bar hidden';
  }, 3000);
}
