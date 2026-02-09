// Popup script for Zhihu AI Summary Extension

// Helper function to get data from chrome.storage
function getStorage(key, defaultValue) {
    return new Promise((resolve) => {
        chrome.storage.local.get({ [key]: defaultValue }, (result) => {
            resolve(result[key]);
        });
    });
}

// Helper function to set data to chrome.storage
function setStorage(key, value) {
    return new Promise((resolve) => {
        chrome.storage.local.set({ [key]: value }, resolve);
    });
}


// Helper function to get data from chrome.storage.local (memory)
function getLocal(key, defaultValue) {
    return new Promise((resolve) => {
        chrome.storage.local.get({ [key]: defaultValue }, (result) => resolve(result[key]));
    });
}

function removeLocal(keys) {
    return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

function toDateKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function escapeHtml(value = '') {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function normalizeApiUrl(url = '') {
    return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

function detectProvider(account = {}) {
    const provider = String(account?.provider || '').trim().toLowerCase();
    if (provider) return provider;
    if (normalizeApiUrl(account?.apiUrl || '').includes('api.longcat.chat')) return 'longcat';
    return 'custom';
}

function providerLabel(provider = 'custom') {
    return provider === 'longcat' ? 'LongCat' : '自定义';
}


document.addEventListener('DOMContentLoaded', async () => {
    // Check configuration status
    const accounts = await getStorage('AI_ACCOUNTS', []);
    const currentAccountId = await getStorage('CURRENT_ACCOUNT_ID', '');
    const autoSummarize = await getStorage('AUTO_SUMMARIZE', false);
    const minAnswerLength = await getStorage('MIN_ANSWER_LENGTH', 200);
    const safeMinAnswerLength = Number.isFinite(Number(minAnswerLength)) ? Number(minAnswerLength) : 200;
    const statusContainer = document.getElementById('status-container');

    if (accounts.length > 0) {
        const currentAccount = accounts.find(acc => acc.id === currentAccountId) || accounts[0];
        const autoStatus = autoSummarize ? '已开启' : '未开启';
        const currentName = escapeHtml(currentAccount?.name || '');
        const currentModel = escapeHtml(currentAccount?.model || '');
        const currentProvider = detectProvider(currentAccount);
        const currentProviderLabel = escapeHtml(providerLabel(currentProvider));
        const longCatStatusLine = currentProvider === 'longcat'
            ? '<div class="account-detail" style="margin-top: 4px; color: #52c41a;">已启用 LongCat 直连</div>'
            : '';
        statusContainer.innerHTML = `
            <div class="status configured">
                <div style="font-weight: 600; margin-bottom: 6px;">✓ 已配置 API (${accounts.length} 个账号)</div>
                <div class="account-info">
                    <div class="account-name">${currentName}</div>
                    <div class="account-detail">模型: ${currentModel}</div>
                    <div class="account-detail">提供商: ${currentProviderLabel}</div>
                    <div class="account-detail" style="margin-top: 4px;">自动总结: ${autoStatus} | 最少字数: ${safeMinAnswerLength}</div>
                    ${longCatStatusLine}
                </div>
            </div>
        `;
    } else {
        statusContainer.innerHTML = `
            <div class="status not-configured">
                <div style="font-weight: 600; margin-bottom: 4px;">⚠ 未配置 API</div>
                <div style="font-size: 12px;">请访问知乎页面，点击右下角⚙️按钮进行配置</div>
            </div>
        `;
    }

    // Memory status (OpenClaw-style)
    const memoryStatusEl = document.getElementById('memory-status');
    if (memoryStatusEl) {
        const memEnabled = await getStorage('MEMORY_ENABLED', true);
        const memAuto = await getStorage('MEMORY_AUTO_EXTRACT', true);
        const memDays = await getStorage('MEMORY_WINDOW_DAYS', 2);

        const memoryMd = await getLocal('ZHIHU_AI_MEMORY_MD', '');
        const todayKey = toDateKey();
        const todayDaily = await getLocal('ZHIHU_AI_DAILY_' + todayKey, '');

        const memSize = (memoryMd || '').length;
        const dailySize = (todayDaily || '').length;
        const safeMemDays = Number.isFinite(Number(memDays)) ? Number(memDays) : 0;

        memoryStatusEl.innerHTML = `
            <span class="info-label">启用：</span>${memEnabled ? '是' : '否'}<br>
            <span class="info-label">自动沉淀：</span>${memAuto ? '是' : '否'}<br>
            <span class="info-label">流水窗口：</span>${safeMemDays} 天<br>
            <span class="info-label">MEMORY.md：</span>${memSize} 字符<br>
            <span class="info-label">今日流水：</span>${dailySize} 字符
        `;
    }

    // Clear memory button
    const clearBtn = document.getElementById('clear-memory');
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            const ok = confirm('确定要清空两层记忆吗？（会删除 MEMORY.md 与最近7天 Daily Notes）');
            if (!ok) return;

            const keys = [
                'ZHIHU_AI_MEMORY_MD',
                'ZHIHU_AI_MEMORY_VERSIONS',
                'ZHIHU_AI_MEMORY_LAST_EXTRACT_TS'
            ];
            // recent 7 days daily notes
            for (let i = 0; i < 7; i++) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                keys.push('ZHIHU_AI_DAILY_' + toDateKey(d));
            }
            await removeLocal(keys);
            alert('已清空记忆。');
            window.close();
        });
    }


    // Open settings button
    document.getElementById('open-settings').addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (tab.url && tab.url.includes('zhihu.com')) {
            // If on Zhihu page, send message to content script to open settings
            chrome.tabs.sendMessage(tab.id, { action: 'openSettings' }, (response) => {
                // Handle potential errors (e.g., tab not loaded yet)
                if (chrome.runtime.lastError) {
                    console.error('Error sending message:', chrome.runtime.lastError);
                    // Reload the page and try again
                    chrome.tabs.reload(tab.id, {}, () => {
                        setTimeout(() => {
                            chrome.tabs.sendMessage(tab.id, { action: 'openSettings' });
                        }, 1000);
                    });
                }
            });
            window.close();
        } else {
            // If not on Zhihu page, open Zhihu in new tab
            chrome.tabs.create({ url: 'https://www.zhihu.com' }, (newTab) => {
                // Wait for the tab to load, then send message
                chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
                    if (tabId === newTab.id && info.status === 'complete') {
                        chrome.tabs.onUpdated.removeListener(listener);
                        setTimeout(() => {
                            chrome.tabs.sendMessage(newTab.id, { action: 'openSettings' });
                        }, 500);
                    }
                });
            });
            window.close();
        }
    });
});
