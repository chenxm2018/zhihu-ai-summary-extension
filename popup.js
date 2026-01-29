// Popup script for Zhihu AI Summary Extension

// Helper function to get data from chrome.storage
function getStorage(key, defaultValue) {
    return new Promise((resolve) => {
        chrome.storage.sync.get({[key]: defaultValue}, (result) => {
            resolve(result[key]);
        });
    });
}

// Helper function to set data to chrome.storage
function setStorage(key, value) {
    return new Promise((resolve) => {
        chrome.storage.sync.set({[key]: value}, resolve);
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    // Check configuration status
    const accounts = await getStorage('AI_ACCOUNTS', []);
    const currentAccountId = await getStorage('CURRENT_ACCOUNT_ID', '');
    const autoSummarize = await getStorage('AUTO_SUMMARIZE', false);
    const minAnswerLength = await getStorage('MIN_ANSWER_LENGTH', 200);
    const statusContainer = document.getElementById('status-container');

    if (accounts.length > 0) {
        const currentAccount = accounts.find(acc => acc.id === currentAccountId) || accounts[0];
        const autoStatus = autoSummarize ? '已开启' : '未开启';
        statusContainer.innerHTML = `
            <div class="status configured">
                <div style="font-weight: 600; margin-bottom: 6px;">✓ 已配置 API (${accounts.length} 个账号)</div>
                <div class="account-info">
                    <div class="account-name">${currentAccount.name}</div>
                    <div class="account-detail">模型: ${currentAccount.model}</div>
                    <div class="account-detail" style="margin-top: 4px;">自动总结: ${autoStatus} | 最少字数: ${minAnswerLength}</div>
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
