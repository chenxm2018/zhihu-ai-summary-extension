(function () {
    'use strict';
    console.log('Zhihu AI Context Script Loaded - 记忆功能版 v1.0');

    // Storage wrapper for chrome.storage.local (Switched from sync for reliability)
    const storage = {
        async get(key, defaultValue) {
            return new Promise((resolve) => {
                chrome.storage.local.get({ [key]: defaultValue }, (result) => {
                    resolve(result[key]);
                });
            });
        },
        async set(key, value) {
            return new Promise((resolve) => {
                chrome.storage.local.set({ [key]: value }, resolve);
            });
        }
    };

    // Storage wrapper for chrome.storage.local (for OpenClaw-style memory; large & editable, not synced)
    const localStore = {
        async get(key, defaultValue) {
            return new Promise((resolve) => {
                chrome.storage.local.get({ [key]: defaultValue }, (result) => resolve(result[key]));
            });
        },
        async set(key, value) {
            return new Promise((resolve) => chrome.storage.local.set({ [key]: value }, resolve));
        },
        async remove(key) {
            return new Promise((resolve) => chrome.storage.local.remove(key, resolve));
        }
    };

    const MEMORY_KEYS = {
        longTerm: 'ZHIHU_AI_MEMORY_MD',
        versions: 'ZHIHU_AI_MEMORY_VERSIONS', // array of { ts, content }
        dailyPrefix: 'ZHIHU_AI_DAILY_' // + YYYY-MM-DD
    };
    const LONGCAT_PRESET_URL = 'https://api.longcat.chat/openai/v1/chat/completions';
    const LONGCAT_PRESET_MODEL = 'LongCat-Flash-Chat';
    const LONGCAT_PRESET_KEY = 'ak_2EI0IS1KB2pz84D4hk2Yg2527H03C';

    function toDateKey(date = new Date()) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function clampTail(text, maxChars) {
        if (!maxChars || maxChars <= 0) return text || '';
        const t = text || '';
        if (t.length <= maxChars) return t;
        return t.slice(t.length - maxChars);
    }

    function nowTime() {
        const dt = new Date();
        return dt.toTimeString().slice(0, 5);
    }

    function escapeHtml(value = '') {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function escapeAttr(value = '') {
        return escapeHtml(value).replace(/`/g, '&#96;');
    }

    function normalizeApiUrl(url = '') {
        return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
    }

    function isLongCatApiUrl(url = '') {
        return normalizeApiUrl(url).includes('api.longcat.chat');
    }

    function detectProvider(account = {}) {
        const rawProvider = String(account?.provider || '').trim().toLowerCase();
        if (rawProvider) return rawProvider;
        if (isLongCatApiUrl(account?.apiUrl || '')) return 'longcat';
        return 'custom';
    }

    function providerLabel(provider = 'custom') {
        if (provider === 'longcat') return 'LongCat';
        return '自定义';
    }

    
    // =========================
    // Topic Memory (per Zhihu question/article) — used for progressive de-duplication
    // =========================
    const TOPIC_MEM_PREFIX = 'TOPIC_MEMORY::';
    const TOPIC_DELTA_START = 2; // After reading 2 items of the same topic, switch to delta mode
    const TOPIC_MAX_POINTS = 30;
    const TOPIC_POINT_MAX_LEN = 80;

    function normalizeUrl(url = '') {
        try {
            const u = new URL(url, location.href);
            u.hash = '';
            u.search = '';
            return u.toString();
        } catch (e) {
            return (url || '').split('#')[0].split('?')[0];
        }
    }

    function extractQuestionIdFromUrl(url = '') {
        const m = (url || '').match(/\/question\/(\d+)/);
        return m ? m[1] : '';
    }

    function fnv1a32(str = '') {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return ('00000000' + h.toString(16)).slice(-8);
    }

    function normalizePoint(s = '') {
        return (s || '')
            .toLowerCase()
            .replace(/[，。；：、！？“”‘’（）()【】\[\]{}<>]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function jaccardTokens(a, b) {
        const A = new Set(normalizePoint(a).split(' ').filter(Boolean));
        const B = new Set(normalizePoint(b).split(' ').filter(Boolean));
        if (!A.size || !B.size) return 0;
        let inter = 0;
        for (const t of A) if (B.has(t)) inter++;
        const union = A.size + B.size - inter;
        return union ? inter / union : 0;
    }

    function isSimilarPoint(a, b) {
        const na = normalizePoint(a);
        const nb = normalizePoint(b);
        if (!na || !nb) return false;
        if (na === nb) return true;
        if (na.includes(nb) || nb.includes(na)) return true;
        return jaccardTokens(na, nb) >= 0.85;
    }

    function dedupPoints(points = []) {
        const out = [];
        for (const p of (points || [])) {
            const s = (p || '').trim();
            if (!s) continue;
            const clipped = s.length > TOPIC_POINT_MAX_LEN ? s.slice(0, TOPIC_POINT_MAX_LEN) : s;
            if (!out.some(x => isSimilarPoint(x, clipped))) out.push(clipped);
        }
        return out.slice(0, TOPIC_MAX_POINTS);
    }

    function deltaBudget(seenCount) {
        // seenCount is how many items already summarized under this topic (BEFORE current one)
        const k = Math.max(0, (seenCount || 0) - TOPIC_DELTA_START);
        let b = 4 - Math.floor(k / 2); // 2->4, 4->3, 6->2, 8->1...
        if (b < 1) b = 1;
        return b;
    }

    const TopicMemory = {
        async getTopicId(content, type) {
            const urlCandidate = content?.sourceUrl || (typeof location !== 'undefined' ? location.href : '');
            if (type === 'answer' || type === 'question') {
                const qid = extractQuestionIdFromUrl(urlCandidate);
                if (qid) return `q_${qid}`;
                const title = content?.questionTitle || content?.title || document.title || urlCandidate;
                return `q_hash_${fnv1a32(title)}`;
            }
            if (type === 'article') {
                const u = normalizeUrl(urlCandidate);
                return `a_${fnv1a32(u)}`;
            }
            return `misc_${fnv1a32(urlCandidate || JSON.stringify(content || {}))}`;
        },

        async load(topicId) {
            const key = TOPIC_MEM_PREFIX + topicId;
            const state = await storage.get(key, null);
            if (state && typeof state === 'object') return state;
            return { topicId, topicTitle: '', seenCount: 0, keyPoints: [], updatedAt: 0 };
        },

        async save(topicId, state) {
            const key = TOPIC_MEM_PREFIX + topicId;
            await storage.set(key, state);
        },

        async getContext(content, type) {
            const topicId = await this.getTopicId(content, type);
            const state = await this.load(topicId);
            const seenCount = Number(state.seenCount || 0);
            const mode = (type === 'answer' || type === 'question') && seenCount >= TOPIC_DELTA_START ? 'delta' : 'full';
            const budget = mode === 'delta' ? deltaBudget(seenCount) : 7;
            const points = Array.isArray(state.keyPoints) ? state.keyPoints : [];
            return { topicId, mode, seenCount, budget, points: points.slice(0, TOPIC_MAX_POINTS), state };
        },

        async applyUpdate(update) {
            if (!update || typeof update !== 'object') return;
            const topicId = update.topicId || update.topic_id;
            if (!topicId) return;
            const state = await this.load(topicId);
            const seenCount = Number(state.seenCount || 0) + 1;
            const oldPoints = Array.isArray(state.keyPoints) ? state.keyPoints : [];
            const newPoints = Array.isArray(update.new_points) ? update.new_points : (Array.isArray(update.newPoints) ? update.newPoints : []);
            const merged = dedupPoints([...oldPoints, ...newPoints]);
            const topicTitle = (update.topicTitle || state.topicTitle || '').toString().slice(0, 120);
            const next = {
                ...state,
                topicId,
                topicTitle,
                seenCount,
                keyPoints: merged,
                updatedAt: Date.now()
            };
            await this.save(topicId, next);
        }
    };


    const STYLES = `
        :root { --zhihu-ai-primary-color: #667eea; --zhihu-ai-secondary-color: #764ba2; }
        .Question-sideColumn--sticky { display: none !important; }
        .zhihu-ai-side-panel { position: absolute; left: 100%; top: 0; margin-left: 20px; width: 350px; z-index: 100; background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15); transition: opacity 0.3s ease; }
        .zhihu-ai-side-panel.short { max-height: unset; }
        .zhihu-ai-side-panel.long { max-height: calc(100vh - 100px); overflow-y: auto; position: fixed; top: 80px; left: auto; margin-left: 0; right: 20px; }
        .zhihu-ai-side-panel.question-fixed { position: fixed; top: 135px; right: 20px; left: auto; margin-left: 0; max-height: calc(100vh - 120px); overflow-y: auto; z-index: 100; }
        .zhihu-ai-summary-btn { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; margin-right: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 20px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.3s ease; box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3); flex-shrink: 0; }
        .zhihu-ai-summary-btn:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4); }
        .zhihu-ai-summary-btn:active { transform: translateY(0); }
        .zhihu-ai-summary-btn.loading { opacity: 0.7; cursor: wait; }
        .zhihu-ai-summary-btn .icon { width: 16px; height: 16px; }
        .zhihu-ai-summary-btn-question { flex-shrink: 0; align-self: flex-start; margin-top: 15px; }
        .zhihu-ai-summary-btn-answer { margin-left: 8px !important; margin-right: 0; padding: 4px 12px; font-size: 13px; border-radius: 16px; display: inline-flex; vertical-align: middle; }
        .zhihu-ai-answer-result { padding: 20px; background: white; overflow-y: auto; max-height: calc(100vh - 150px); }
        .zhihu-ai-answer-result-header { display: flex; align-items: center; gap: 6px; margin-bottom: 14px; padding-bottom: 12px; border-bottom: 2px solid #f0f0f0; font-size: 15px; font-weight: 600; color: #667eea; cursor: move; user-select: none; }
        .zhihu-ai-answer-result-header svg { width: 18px; height: 18px; flex-shrink: 0; }
        .zhihu-ai-answer-result-body { line-height: 1.8; color: #555; font-size: 14px; }
        .zhihu-ai-answer-result-close { margin-left: auto; background: none; border: none; color: #999; cursor: pointer; font-size: 20px; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 50%; transition: all 0.2s; }
        .zhihu-ai-answer-result-close:hover { background: rgba(0, 0, 0, 0.05); color: #666; }
        .zhihu-ai-article-result { margin: 24px 0; padding: 20px 24px; background: linear-gradient(135deg, #667eea12 0%, #764ba212 100%); border-left: 4px solid #667eea; border-radius: 8px; box-shadow: 0 2px 8px rgba(102, 126, 234, 0.1); animation: slideDown 0.3s ease; }
        .zhihu-ai-article-result-header { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; font-size: 16px; font-weight: 600; color: #667eea; }
        .zhihu-ai-article-result-header svg { width: 18px; height: 18px; flex-shrink: 0; }
        .zhihu-ai-article-result-body { line-height: 1.8; color: #444; font-size: 15px; }
        .zhihu-ai-article-result-close { margin-left: auto; background: none; border: none; color: #999; cursor: pointer; font-size: 20px; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; border-radius: 50%; transition: all 0.2s; }
        .zhihu-ai-article-result-close:hover { background: rgba(0, 0, 0, 0.05); color: #666; }
        .zhihu-ai-modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: 1; animation: fadeIn 0.3s ease; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .zhihu-ai-modal-content { background: white; border-radius: 12px; padding: 24px; max-width: 700px; width: 90%; max-height: 80vh; overflow-y: auto; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2); animation: slideUp 0.3s ease; }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        .zhihu-ai-modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 2px solid #f0f0f0; }
        .zhihu-ai-modal-title { font-size: 20px; font-weight: 600; color: #333; display: flex; align-items: center; gap: 8px; }
        .zhihu-ai-modal-close { background: none; border: none; font-size: 24px; color: #999; cursor: pointer; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 50%; transition: all 0.2s; }
        .zhihu-ai-modal-close:hover { background: #f0f0f0; color: #333; }
        .zhihu-ai-modal-body { line-height: 1.8; color: #444; font-size: 15px; }
        .zhihu-ai-loading { text-align: center; padding: 40px 20px; }
        .zhihu-ai-spinner { border: 3px solid #f3f3f3; border-top: 3px solid #667eea; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto 16px; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .zhihu-ai-error { color: #ff4d4f; padding: 16px; background: #fff2f0; border-radius: 8px; border-left: 4px solid #ff4d4f; }
        .zhihu-ai-config-btn { position: fixed; bottom: 60px; right: 10px; width: 40px; height: 40px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 50%; cursor: pointer; font-size: 24px; box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4); z-index: 9999; transition: all 0.3s ease; }
        .zhihu-ai-config-btn:hover { transform: scale(1.1); }
        .zhihu-ai-config-panel { padding: 20px 0; }
        .zhihu-ai-config-item { margin-bottom: 16px; }
        .zhihu-ai-config-label { display: block; margin-bottom: 8px; font-weight: 500; color: #333; }
        .zhihu-ai-config-input { width: 100%; padding: 10px 12px; border: 1px solid #d9d9d9; border-radius: 6px; font-size: 14px; transition: border-color 0.3s; }
        .zhihu-ai-config-input:focus { outline: none; border-color: #667eea; }
        .zhihu-ai-config-save { width: 100%; padding: 10px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 15px; font-weight: 500; transition: all 0.3s; }
        .zhihu-ai-config-save:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4); }
        .zhihu-ai-config-test { width: 100%; padding: 10px; background: linear-gradient(135deg, #52c41a 0%, #389e0d 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 15px; font-weight: 500; transition: all 0.3s; margin-bottom: 12px; }
        .zhihu-ai-config-test:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(82, 196, 26, 0.4); }
        .zhihu-ai-config-test:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
        .zhihu-ai-test-result { padding: 12px; border-radius: 6px; margin-bottom: 12px; font-size: 14px; line-height: 1.6; }
        .zhihu-ai-test-result.success { background: #f6ffed; border: 1px solid #b7eb8f; color: #52c41a; }
        .zhihu-ai-test-result.error { background: #fff2f0; border: 1px solid #ffccc7; color: #ff4d4f; }
        .zhihu-ai-account-list { margin: 16px 0; max-height: 300px; overflow-y: auto; }
        .zhihu-ai-account-item { padding: 12px; margin-bottom: 8px; border: 1px solid #e0e0e0; border-radius: 6px; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: space-between; }
        .zhihu-ai-account-item:hover { background: #f5f5f5; }
        .zhihu-ai-account-item.active { border-color: #667eea; background: linear-gradient(135deg, #667eea10 0%, #764ba210 100%); }
        .zhihu-ai-account-info { flex: 1; }
        .zhihu-ai-account-name { font-weight: 600; color: #333; margin-bottom: 4px; }
        .zhihu-ai-account-detail { font-size: 12px; color: #666; }
        .zhihu-ai-account-actions { display: flex; gap: 8px; }
        .zhihu-ai-account-btn { padding: 4px 8px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; transition: all 0.2s; }
        .zhihu-ai-account-btn-edit { background: #e6f7ff; color: #1890ff; }
        .zhihu-ai-account-btn-edit:hover { background: #bae7ff; }
        .zhihu-ai-account-btn-delete { background: #fff2f0; color: #ff4d4f; }
        .zhihu-ai-account-btn-delete:hover { background: #ffccc7; }
        .zhihu-ai-add-account-btn { width: 100%; padding: 10px; background: white; border: 2px dashed #d9d9d9; border-radius: 6px; cursor: pointer; font-size: 14px; color: #666; transition: all 0.3s; }
        .zhihu-ai-add-account-btn:hover { border-color: #667eea; color: #667eea; }
        .zhihu-ai-tabs { display: flex; gap: 8px; margin-bottom: 16px; border-bottom: 2px solid #f0f0f0; }
        .zhihu-ai-tab { padding: 10px 16px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all 0.3s; color: #666; }
        .zhihu-ai-tab.active { color: #667eea; border-bottom-color: #667eea; font-weight: 600; }
        .zhihu-ai-tab-content { display: none; }
        .zhihu-ai-tab-content.active { display: block; }
        .zhihu-ai-summary-content { white-space: pre-wrap; }
        .zhihu-ai-inline-result { margin: 20px 0; padding: 20px; background: linear-gradient(135deg, #667eea15 0%, #764ba215 100%); border-left: 4px solid #667eea; border-radius: 8px; box-shadow: 0 2px 8px rgba(102, 126, 234, 0.1); animation: slideDown 0.3s ease; }
        @keyframes slideDown { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
        .zhihu-ai-inline-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 16px; font-weight: 600; color: #667eea; }
        .zhihu-ai-inline-header svg { width: 20px; height: 20px; flex-shrink: 0; }
        .zhihu-ai-inline-body { line-height: 1.8; color: #444; font-size: 15px; }
        .zhihu-ai-inline-loading { display: flex; align-items: center; gap: 12px; color: #666; }
        .zhihu-ai-inline-spinner { border: 2px solid #f3f3f3; border-top: 2px solid #667eea; border-radius: 50%; width: 20px; height: 20px; animation: spin 1s linear infinite; }
        .zhihu-ai-inline-error { color: #ff4d4f; padding: 12px; background: #fff2f0; border-radius: 6px; border-left: 3px solid #ff4d4f; }
        .zhihu-ai-inline-close { margin-left: auto; background: none; border: none; color: #999; cursor: pointer; font-size: 20px; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 50%; transition: all 0.2s; }
        .zhihu-ai-inline-close:hover { background: rgba(0, 0, 0, 0.05); color: #666; }
        .zhihu-ai-streaming-cursor { display: inline-block; width: 2px; height: 1em; background: #667eea; margin-left: 2px; animation: blink 1s infinite; vertical-align: text-bottom; }
        @keyframes blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
        .zhihu-ai-answer-result-body h1, .zhihu-ai-article-result-body h1, .zhihu-ai-inline-body h1 { font-size: 18px; font-weight: 600; color: #333; margin: 16px 0 10px 0; padding-bottom: 8px; border-bottom: 2px solid #e0e0e0; }
        .zhihu-ai-answer-result-body h2, .zhihu-ai-article-result-body h2, .zhihu-ai-inline-body h2 { font-size: 16px; font-weight: 600; color: #444; margin: 14px 0 8px 0; padding-bottom: 6px; border-bottom: 1px solid #e8e8e8; }
        .zhihu-ai-answer-result-body h3, .zhihu-ai-article-result-body h3, .zhihu-ai-inline-body h3 { font-size: 15px; font-weight: 600; color: #555; margin: 12px 0 6px 0; }
        .zhihu-ai-answer-result-body p, .zhihu-ai-article-result-body p, .zhihu-ai-inline-body p { margin: 8px 0; line-height: 1.8; }
        .zhihu-ai-answer-result-body strong, .zhihu-ai-article-result-body strong, .zhihu-ai-inline-body strong { font-weight: 600; color: var(--zhihu-ai-primary-color); }
        .zhihu-ai-answer-result-body em, .zhihu-ai-article-result-body em, .zhihu-ai-inline-body em { font-style: italic; color: #666; }
        .zhihu-ai-answer-result-body ul, .zhihu-ai-article-result-body ul, .zhihu-ai-inline-body ul { margin: 10px 0; padding-left: 24px; list-style-type: disc; }
        .zhihu-ai-answer-result-body ol, .zhihu-ai-article-result-body ol, .zhihu-ai-inline-body ol { margin: 10px 0; padding-left: 24px; list-style-type: decimal; }
        .zhihu-ai-answer-result-body li, .zhihu-ai-article-result-body li, .zhihu-ai-inline-body li { margin: 4px 0; line-height: 1.7; }
        .zhihu-ai-answer-result-body pre, .zhihu-ai-article-result-body pre, .zhihu-ai-inline-body pre { background: #f5f5f5; border: 1px solid #e0e0e0; border-radius: 4px; padding: 12px; margin: 10px 0; overflow-x: auto; }
        .zhihu-ai-answer-result-body code, .zhihu-ai-article-result-body code, .zhihu-ai-inline-body code { font-family: 'Consolas', 'Monaco', 'Courier New', monospace; font-size: 13px; color: #d63384; background: #f8f9fa; padding: 2px 6px; border-radius: 3px; }
        .zhihu-ai-answer-result-body pre code, .zhihu-ai-article-result-body pre code, .zhihu-ai-inline-body pre code { background: none; padding: 0; color: #333; }
        .zhihu-ai-answer-result-body a, .zhihu-ai-article-result-body a, .zhihu-ai-inline-body a { color: #667eea; text-decoration: none; border-bottom: 1px solid #667eea50; transition: all 0.2s; }
        .zhihu-ai-answer-result-body a:hover, .zhihu-ai-article-result-body a:hover, .zhihu-ai-inline-body a:hover { color: #764ba2; border-bottom-color: #764ba2; }
        .zhihu-ai-answer-result-body .markdown-table, .zhihu-ai-article-result-body .markdown-table, .zhihu-ai-inline-body .markdown-table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; background: white; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1); border-radius: 4px; overflow: hidden; }
        .zhihu-ai-answer-result-body .markdown-table th, .zhihu-ai-article-result-body .markdown-table th, .zhihu-ai-inline-body .markdown-table th { background: linear-gradient(135deg, #667eea15 0%, #764ba215 100%); color: #333; font-weight: 600; padding: 10px 12px; border-bottom: 2px solid #667eea; }
        .zhihu-ai-answer-result-body .markdown-table td, .zhihu-ai-article-result-body .markdown-table td, .zhihu-ai-inline-body .markdown-table td { padding: 8px 12px; border-bottom: 1px solid #e8e8e8; }
        .zhihu-ai-answer-result-body .markdown-table tr:last-child td, .zhihu-ai-article-result-body .markdown-table tr:last-child td, .zhihu-ai-inline-body .markdown-table tr:last-child td { border-bottom: none; }
        .zhihu-ai-answer-result-body .markdown-table tr:hover, .zhihu-ai-article-result-body .markdown-table tr:hover, .zhihu-ai-inline-body .markdown-table tr:hover { background: #f9f9f9; }
        /* 继续提问功能样式 */
        .zhihu-ai-chat-container { margin-top: 16px; border-top: 1px solid #e8e8e8; padding-top: 12px; }
        .zhihu-ai-chat-messages { max-height: 300px; overflow-y: auto; margin-bottom: 12px; }
        .zhihu-ai-chat-message { margin-bottom: 12px; padding: 10px 14px; border-radius: 12px; line-height: 1.6; font-size: 14px; }
        .zhihu-ai-chat-message.user { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; margin-left: 20%; text-align: right; }
        .zhihu-ai-chat-message.ai { background: #f5f5f5; color: #333; margin-right: 20%; }
        .zhihu-ai-chat-message.ai.streaming { background: #f0f0f0; }
        .zhihu-ai-chat-input-area { display: flex; gap: 8px; align-items: flex-end; }
        .zhihu-ai-chat-input { flex: 1; padding: 10px 14px; border: 1px solid #d9d9d9; border-radius: 20px; font-size: 14px; resize: none; min-height: 20px; max-height: 100px; outline: none; transition: border-color 0.3s; font-family: inherit; }
        .zhihu-ai-chat-input:focus { border-color: #667eea; }
        .zhihu-ai-chat-input::placeholder { color: #999; }
        .zhihu-ai-chat-send-btn { width: 36px; height: 36px; border: none; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.3s; flex-shrink: 0; }
        .zhihu-ai-chat-send-btn:hover { transform: scale(1.1); box-shadow: 0 2px 8px rgba(102, 126, 234, 0.4); }
        .zhihu-ai-chat-send-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
        .zhihu-ai-chat-send-btn svg { width: 18px; height: 18px; }
        /* 模式切换样式 */
        .zhihu-ai-mode-switcher { display: flex; gap: 8px; margin-bottom: 12px; padding: 8px; background: #f5f5f5; border-radius: 8px; }
        .zhihu-ai-mode-btn { flex: 1; padding: 8px 12px; border: 2px solid transparent; border-radius: 6px; background: white; cursor: pointer; font-size: 13px; font-weight: 500; transition: all 0.3s; display: flex; align-items: center; justify-content: center; gap: 4px; }
        .zhihu-ai-mode-btn:hover { transform: translateY(-1px); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1); }
        .zhihu-ai-mode-btn.active.strict { border-color: #667eea; background: linear-gradient(135deg, #667eea15 0%, #764ba215 100%); color: #667eea; }
        .zhihu-ai-mode-btn.active.free { border-color: #52c41a; background: linear-gradient(135deg, #52c41a15 0%, #389e0d15 100%); color: #52c41a; }
        .zhihu-ai-mode-indicator { font-size: 12px; color: #666; padding: 4px 8px; background: #f0f0f0; border-radius: 4px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
        .zhihu-ai-mode-indicator.strict { background: #667eea15; color: #667eea; border-left: 3px solid #667eea; }
        .zhihu-ai-mode-indicator.free { background: #52c41a15; color: #52c41a; border-left: 3px solid #52c41a; }
        .zhihu-ai-chat-container.strict { border-top-color: #667eea; }
        .zhihu-ai-chat-container.free { border-top-color: #52c41a; }
    `;

    // Mode Prompts for chat feature
    const STRICT_MODE_PROMPT = `你是一个严格基于【原文+已生成总结】的问答助手，同时会参考【用户记忆】来减少重复解释。

规则：
- 只依据原文与已给出的总结回答；不确定就说“原文未说明/总结未涉及”。
- 若用户问到 MEMORY.md 中标为“已掌握”的概念：只用 1–2 句指出它在本文中的作用，不做科普。
- 若需要证据：引用原文短句（≤20字）。
- 输出简洁，Markdown。`;

    const FREE_MODE_PROMPT = `你是一个可延伸讲解的知识助手，会参考【用户记忆】做差分解释。

规则：
- 先回答“与这篇文章直接相关”的部分，再补充背景/对比/延伸（标注“补充背景”）。
- 对 MEMORY.md 中“已掌握”的概念不重复科普；只补充更高阶/新的视角。
- 如果用户显式说“懂了/不用解释了”，你要把该概念视为“已掌握”，后续减少出现。
- Markdown 输出，条理清晰。`;



    // OpenClaw-style 2-layer memory for "progressive de-duplication"
    // - Daily Notes: append-only markdown per day
    // - Long-Term Memory: a single editable MEMORY.md (stored in chrome.storage.local)
    class MemoryManager {
        constructor(apiClient) {
            this.apiClient = apiClient;
        }

        async getSettings() {
            return {
                enabled: await storage.get('MEMORY_ENABLED', true),
                autoExtract: await storage.get('MEMORY_AUTO_EXTRACT', true),
                windowDays: Math.max(0, parseInt(await storage.get('MEMORY_WINDOW_DAYS', 2), 10) || 2),
                injectMaxChars: Math.max(1000, parseInt(await storage.get('MEMORY_INJECT_MAX_CHARS', 6000), 10) || 6000),
                memoryMaxChars: Math.max(2000, parseInt(await storage.get('MEMORY_MAX_CHARS', 20000), 10) || 20000),
                dailyMaxChars: Math.max(2000, parseInt(await storage.get('DAILY_MAX_CHARS', 30000), 10) || 30000),
                keepVersions: Math.max(0, parseInt(await storage.get('MEMORY_KEEP_VERSIONS', 10), 10) || 10),
                extractMinIntervalSec: Math.max(10, parseInt(await storage.get('MEMORY_EXTRACT_MIN_INTERVAL_SEC', 120), 10) || 120),
                useServer: await storage.get('MEMORY_USE_SERVER', false),
                serverUrl: await storage.get('MEMORY_SERVER_URL', 'http://127.0.0.1:8899')
            };
        }

        defaultLongTermMemory() {
            return `# 用户偏好与约束
- 输出：少而关键；结论优先；必要时给证据/引用（≤20字）。
- 若信息缺失：写“原文未说明/不确定”，不要猜测。
- 已掌握概念：默认不再解释基础定义，只讲新增/差异/坑（必要时用1句提醒）。

# 已解释概念（默认跳过基础定义）
- （空）

# 已见主题（默认只提醒一句）
- （空）

# 当前进行中的事
- （空）

# 常见坑与红线
- 不要把不确定信息写成确定记忆；宁可不写。
- 记忆必须可审计、可编辑、可回滚（不要黑盒）。
`;
        }

        async isEnabled() {
            const s = await this.getSettings();
            return !!s.enabled;
        }

        async checkServerStatus() {
            const s = await this.getSettings();
            if (!s.useServer) return false;
            try {
                const res = await fetch(`${s.serverUrl}/status`);
                return res.ok;
            } catch (e) {
                return false;
            }
        }

        async getLongTermMemory() {
            const s = await this.getSettings();

            if (s.useServer) {
                try {
                    const res = await fetch(`${s.serverUrl}/memory`);
                    if (res.ok) {
                        const text = await res.text();
                        return text || this.defaultLongTermMemory();
                    }
                } catch (e) {
                    console.error('[Memory] Server fetch failed, falling back to local', e);
                }
            }

            const mem = await localStore.get(MEMORY_KEYS.longTerm, '');
            return mem && mem.trim() ? mem : this.defaultLongTermMemory();
        }

        async setLongTermMemory(newContent, { saveVersion = true } = {}) {
            const s = await this.getSettings();
            const trimmed = clampTail((newContent || '').trim() + '\n', s.memoryMaxChars);

            if (s.useServer) {
                try {
                    await fetch(`${s.serverUrl}/memory`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content: trimmed })
                    });
                    // Also sync to local as backup? Maybe not to avoid confusion.
                    // Let's keep local outdated or sync it? 
                    // Better verify success.
                    return;
                } catch (e) {
                    console.error('[Memory] Server save failed', e);
                    // Fallthrough to local save? No, that might cause desync. 
                    // Use alert?
                }
            }

            if (saveVersion) {
                const prev = await this.getLongTermMemory();
                await this.saveVersion(prev);
            }

            await localStore.set(MEMORY_KEYS.longTerm, trimmed);
        }

        async saveVersion(content) {
            const s = await this.getSettings();
            if (s.keepVersions <= 0) return;

            const versions = await localStore.get(MEMORY_KEYS.versions, []);
            const next = Array.isArray(versions) ? versions.slice() : [];
            next.unshift({ ts: Date.now(), content: clampTail(content || '', 20000) });
            while (next.length > s.keepVersions) next.pop();
            await localStore.set(MEMORY_KEYS.versions, next);
        }

        async getDailyNotes(dateKey = toDateKey()) {
            const s = await this.getSettings();
            if (s.useServer) {
                try {
                    const res = await fetch(`${s.serverUrl}/daily/${dateKey}`);
                    if (res.ok) return await res.text();
                } catch (e) { }
            }
            return await localStore.get(MEMORY_KEYS.dailyPrefix + dateKey, '');
        }

        async setDailyNotes(dateKey, text) {
            const s = await this.getSettings();
            const content = clampTail(text || '', s.dailyMaxChars);

            if (s.useServer) {
                try {
                    const putRes = await fetch(`${s.serverUrl}/daily/${encodeURIComponent(dateKey)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content })
                    });
                    if (putRes.ok) return;
                } catch (e) { }

                try {
                    const postRes = await fetch(`${s.serverUrl}/daily`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            date: dateKey,
                            content,
                            overwrite: true
                        })
                    });
                    if (postRes.ok) return;
                } catch (e) { }

                console.warn('[Memory] Server daily overwrite failed, fallback to local storage');
            }

            await localStore.set(MEMORY_KEYS.dailyPrefix + dateKey, content);
        }

        async appendDaily(entryMarkdown, dateKey = toDateKey()) {
            const s = await this.getSettings();

            if (s.useServer) {
                try {
                    await fetch(`${s.serverUrl}/daily`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            date: dateKey,
                            content: entryMarkdown.trim()
                        })
                    });
                    return;
                } catch (e) {
                    console.error('[Memory] Server append failed', e);
                }
            }

            // Local fallback
            const current = await this.getDailyNotes(dateKey);
            const next = (current ? (current + '\n\n') : '') + entryMarkdown.trim();
            // We manually set locally
            await localStore.set(MEMORY_KEYS.dailyPrefix + dateKey, clampTail(next, s.dailyMaxChars));
        }

        async getRecentDailyNotes(windowDays) {
            const days = Math.max(0, windowDays || 0);
            if (days === 0) return '';
            const parts = [];
            const today = new Date();
            for (let i = 0; i < days; i++) {
                const d = new Date(today);
                d.setDate(today.getDate() - i);
                const key = toDateKey(d);
                const text = await this.getDailyNotes(key);
                if (text && text.trim()) {
                    parts.push(`## ${key}\n${text.trim()}`);
                }
            }
            return parts.join('\n\n');
        }

        async buildSystemPromptForSummary(originalContent, type, authorName) {
            const s = await this.getSettings();
            if (!s.enabled) return '';

            const longTerm = clampTail(await this.getLongTermMemory(), Math.floor(s.injectMaxChars * 0.60));
            const recentDaily = clampTail(await this.getRecentDailyNotes(s.windowDays), Math.floor(s.injectMaxChars * 0.25));

            // Per-topic memory (question-level) for progressive de-duplication
            let topicCtx = null;
            let topicBlock = '';
            try {
                const content = {
                    ...(originalContent || {}),
                    sourceUrl: (originalContent && originalContent.sourceUrl) ? originalContent.sourceUrl : ((typeof location !== 'undefined' && location.href) ? location.href : '')
                };
                topicCtx = await TopicMemory.getContext(content, type);

                if ((type === 'answer' || type === 'question') && topicCtx) {
                    const pts = Array.isArray(topicCtx.points) ? topicCtx.points : [];
                    const head = [
                        `TOPIC_MEMORY (per-topic, for de-dup):`,
                        `- topicId: ${topicCtx.topicId}`,
                        `- seenCount: ${topicCtx.seenCount}`,
                        `- mode: ${topicCtx.mode}`,
                        `- keyPoints:`
                    ].join('\n');
                    const body = pts.length ? pts.map(p => `  - ${p}`).join('\n') : '  - (empty)';
                    topicBlock = `${head}
${body}
`;
                    // keep it short
                    topicBlock = clampTail(topicBlock, Math.floor(s.injectMaxChars * 0.15));
                }
            } catch (e) {
                topicCtx = null;
                topicBlock = '';
            }

            const pageTitle = originalContent?.title || originalContent?.questionTitle || '';
            const url = (typeof location !== 'undefined' && location.href) ? location.href : '';
            const who = (type === 'answer' && authorName) ? `作者：${authorName}` : '';

            const fullSpec = `输出结构（全量模式，尽量短）：
A. 速览（≤120字）：这篇内容解决什么问题/结论是什么
B. 你今天最该关心的点（2–6条）：优先“信息增量”，每条≤2行
C. 你可以直接跳过的点（0–4条）：明确说明“为什么可跳过”（已掌握/与目标无关/重复）
D. 术语/概念补课（0–4个）：仅列你判断用户可能不熟的；每个≤3行
E. 证据摘录（可选 0–5条）：对应 B 的关键点，原文短句≤20字（不要长引用）

额外约束：
- 不要堆砌“3–7 条”这类机械数量；能少就少，但不能漏关键增量。
- 如果内容与主题高度重复：C 部分可以多一点，B 部分可以少到 1–2 条。`;

            const budget = topicCtx && topicCtx.mode === 'delta' ? (topicCtx.budget || 2) : 0;
            const deltaSpec = `输出结构（增量模式：只写“相对已读内容的新东西”）：
A. 新增要点（≤${budget}条，允许 0 条）：只写本段原文里“主题记忆 keyPoints 未覆盖”的信息
B. 重要差异/反例（0–${budget}条）：如果与 keyPoints 有冲突/补充条件，写出来
C. 一句话结论（≤60字）：这条回答值得看吗？为什么（从增量角度）
（不写 D/E，除非原文出现了全新术语且影响理解，最多 1 个术语一句话带过）

判定“无新增”时：
- A 写“无新增要点（高度重复）”
- C 写“可跳过/快速扫一眼”的建议。`;

            const updateLine = (topicCtx && (type === 'answer' || type === 'question')) ? (() => {
                const safeTitle = String(originalContent?.questionTitle || originalContent?.title || pageTitle || '').replace(/"/g, '\"').slice(0, 120);
                const nLimit = (topicCtx.mode === 'delta') ? Math.max(0, (topicCtx.budget || 2)) : 10;
                return `
【主题记忆更新（必须）】
- 你必须在最后一行输出：[[ZH_TOPIC_UPDATE]]{"topicId":"${topicCtx.topicId}","topicTitle":"${safeTitle}","new_points":[...]} 
- new_points：用于更新主题记忆 keyPoints。
  - 全量模式：写“最核心的 5–10 条要点”（便于后续去重）；不要写废话。
  - 增量模式：只写“新增要点”，条数≤${nLimit}；允许空数组。
- JSON 必须严格可解析：双引号；不能换行；不能有多余文字。`;
            })() : '';

            const spec = (topicCtx && topicCtx.mode === 'delta') ? deltaSpec : fullSpec;

            return `你是一个“个性化阅读与问答助手”，服务于同一个用户的长期学习/工作流。

你会收到这些输入（不一定每次都有）：
- 【原文】：用户正在看的文章/问答内容
- 【已有总结】：系统之前生成的总结（若有）
- 【近期流水 Daily Notes】：用户最近几天的日志式记录（可能包含：做过什么、刚学过什么）
- 【长期记忆 MEMORY.md】：沉淀信息（用户偏好、长期项目、已掌握/不需要重复的概念、踩坑点等）
- 【主题记忆 TOPIC_MEMORY】：同一“知乎问题/主题”下已经总结过的要点（用于去重）

你的目标不是“最全面的摘要”，而是“对这个用户最有信息增量的输出”：
1) 优先输出：原文中【用户可能还没掌握/近期需要/与其项目相关】的部分。
2) 对于 MEMORY.md 中标注为【已掌握/不需要重复】的概念：不做科普式解释；最多 1 句提示其在本文中的作用即可。
3) 对于 TOPIC_MEMORY 中已存在的 keyPoints：不要重复；只写增量、差异、反例、限定条件。
4) 如果无法判断用户是否已掌握：先按“小白友好”解释，但保持简短，并把该概念列入“可确认项”，引导用户用一句话确认“我懂/我不懂”。
5) 任何结论必须可追溯到原文；不确定就写“原文未说明/无法从原文确定”。
6) 输出使用 Markdown 标题与列表；避免使用表格；不要堆砌空话。

${spec}${updateLine}

META:
- type: ${type}
- who: ${who}
- 标题: ${pageTitle}
- url: ${url}

${topicBlock}

LONG_TERM_MEMORY (Markdown):
${longTerm}

DAILY_NOTES (Markdown, recent ${s.windowDays} days):
${recentDaily}
`;
        }

        async buildSystemPromptForChat(mode, originalContent, type, initialSummary) {
            const s = await this.getSettings();
            if (!s.enabled) return '';

            const longTerm = clampTail(await this.getLongTermMemory(), Math.floor(s.injectMaxChars * 0.65));
            const recentDaily = clampTail(await this.getRecentDailyNotes(s.windowDays), Math.floor(s.injectMaxChars * 0.35));
            const pageTitle = originalContent?.title || '';
            const url = (typeof location !== 'undefined' && location.href) ? location.href : '';

            return `【两层记忆（OpenClaw风格）】用于本次追问对话的“差分式回答”：
- 用户已掌握/已见过的内容：默认不展开，只讲本页的新信息、差异、坑或证据。
- 若必须依赖某定义：最多1句提醒，然后继续回答。

上下文：
- mode: ${mode}
- type: ${type}
- 标题: ${pageTitle}
- url: ${url}

LONG_TERM_MEMORY (Markdown):
${longTerm}

DAILY_NOTES (Markdown, recent ${s.windowDays} days):
${recentDaily}
`;
        }

        async recordSummaryEvent({ type, url, title, authorName, summaryText }) {
            const s = await this.getSettings();
            if (!s.enabled) return;

            const entry = [
                `## ${toDateKey()} ${nowTime()} 总结`,
                `- type: ${type}`,
                url ? `- url: ${url}` : '',
                title ? `- 标题: ${title}` : '',
                authorName ? `- 作者: ${authorName}` : '',
                `- 摘要(截断):`,
                '',
                clampTail((summaryText || '').trim(), 1500)
            ].filter(Boolean).join('\n');

            await this.appendDaily(entry);

            if (s.autoExtract) {
                await this.maybeExtractLongTerm({ reason: 'summary' });
            }
        }

        async recordChatEvent({ type, url, title, question, answer, mode }) {
            const s = await this.getSettings();
            if (!s.enabled) return;

            const entry = [
                `## ${toDateKey()} ${nowTime()} 追问`,
                `- mode: ${mode}`,
                `- type: ${type}`,
                url ? `- url: ${url}` : '',
                title ? `- 标题: ${title}` : '',
                `- 用户问题: ${clampTail((question || '').trim(), 400)}`,
                `- AI回答(截断):`,
                '',
                clampTail((answer || '').trim(), 1200)
            ].filter(Boolean).join('\n');

            await this.appendDaily(entry);

            if (s.autoExtract) {
                await this.maybeExtractLongTerm({ reason: 'chat' });
            }
        }

        async maybeExtractLongTerm({ reason = 'auto', force = false } = {}) {
            const s = await this.getSettings();
            if (!s.enabled || !s.autoExtract) return;

            const lastTs = await localStore.get('ZHIHU_AI_MEMORY_LAST_EXTRACT_TS', 0);
            const now = Date.now();
            if (!force && lastTs && (now - lastTs) < s.extractMinIntervalSec * 1000) return;

            // If API key missing, skip silently
            if (!this.apiClient || !this.apiClient.apiKey) return;

            const oldMemory = await this.getLongTermMemory();
            const recentDaily = await this.getRecentDailyNotes(Math.max(1, s.windowDays));

            const system = `你是一个“长期记忆整理助手”。你将根据新产生的流水记录，更新一份可审计、可编辑的 MEMORY.md。
输出要求：
- 只输出 Markdown（完整的 MEMORY.md），不要输出任何解释、前后缀或代码块。
- 只保留“稳定/可复用”的信息：用户偏好、已掌握概念、已见主题、长期项目上下文、常见坑。
- 不要写入不确定事实；不确定就不写。
- “已掌握概念”只有当用户明确表达“懂了/不用解释/我会了/别讲了”等强信号，或用户能复述/纠正时才加入。
- 每个 section 控制在 3-12 条；空的用“（空）”占位即可。
- 尽量简短，避免流水细节。`;

            const user = `旧 MEMORY.md:
${oldMemory}

近期 DAILY_NOTES:
${recentDaily}

请更新 MEMORY.md（按原结构即可；可适度补充/删减条目）。`;

            try {
                const updated = await this.apiClient.completeOnce(
                    [
                        { role: 'system', content: system },
                        { role: 'user', content: user }
                    ],
                    { maxTokens: 900, temperature: 0.2 }
                );

                if (updated && updated.trim().length > 200) {
                    await this.setLongTermMemory(updated, { saveVersion: true });
                    await localStore.set('ZHIHU_AI_MEMORY_LAST_EXTRACT_TS', now);
                }
            } catch (e) {
                // swallow errors to avoid breaking UX
            }
        }

        async clearAllMemory() {
            const todayKey = toDateKey();
            // Clear long term
            await localStore.remove(MEMORY_KEYS.longTerm);
            await localStore.remove(MEMORY_KEYS.versions);
            await localStore.remove('ZHIHU_AI_MEMORY_LAST_EXTRACT_TS');
            // Clear recent dailies (7 days) - keep minimal
            for (let i = 0; i < 7; i++) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                await localStore.remove(MEMORY_KEYS.dailyPrefix + toDateKey(d));
            }
        }
    }


    // Markdown Parser Class
    class MarkdownParser {
        static parse(markdown) {
            // MVP Security Fix: Escape HTML characters first to prevent XSS
            let html = markdown
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");

            html = html.replace(/\n{3,}/g, '\n\n');
            html = html.replace(/```[\s\S]*?```/g, match => {
                const codeMatch = match.match(/```(\w+)?\n?([\s\S]*?)```/);
                return codeMatch ? `<pre><code>${codeMatch[2]}</code></pre>` : match;
            });
            html = this.parseTable(html);
            html = html.replace(/^### (.+)$/gim, '<h3>$1</h3>').replace(/^## (.+)$/gim, '<h2>$1</h2>').replace(/^# (.+)$/gim, '<h1>$1</h1>');
            html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
            html = this.parseList(html);
            html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
                const safeUrl = this.sanitizeLink(url);
                return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow">${text}</a>`;
            });
            html = html.split('\n\n').map(block => {
                block = block.trim();
                if (!block) return '';
                if (block.startsWith('<h') || block.startsWith('<ul>') || block.startsWith('<ol>') || block.startsWith('<pre>') || block.startsWith('<table')) {
                    return block;
                }
                return '<p>' + block.replace(/\n/g, ' ') + '</p>';
            }).filter(b => b).join('');
            return this.cleanHTML(html);
        }

        static sanitizeLink(url) {
            const raw = String(url || '').trim();
            if (!raw) return '#';
            if (/^(https?:|mailto:)/i.test(raw)) return escapeAttr(raw);
            if (/^(\/|\.\/|\.\.\/|#)/.test(raw)) return escapeAttr(raw);
            return '#';
        }

        static parseTable(html) {
            const tableRegex = /(\|.+\|[\r\n]+\|[\s\-:]+\|[\r\n]+(?:\|.+\|[\r\n]*)+)/g;
            return html.replace(tableRegex, match => {
                const rows = match.trim().split('\n').filter(row => row.trim());
                if (rows.length < 2) return match;
                const headers = rows[0].split('|').map(h => h.trim()).filter(h => h);
                const alignments = rows[1].split('|').map(s => {
                    s = s.trim();
                    if (s.startsWith(':') && s.endsWith(':')) return 'center';
                    if (s.endsWith(':')) return 'right';
                    return 'left';
                }).filter((_, i) => i < headers.length);
                let tableHTML = '<table class="markdown-table"><thead><tr>';
                headers.forEach((header, i) => tableHTML += `<th style="text-align: ${alignments[i] || 'left'}">${header}</th>`);
                tableHTML += '</tr></thead><tbody>';
                rows.slice(2).forEach(row => {
                    const cells = row.split('|').map(c => c.trim()).filter(c => c);
                    tableHTML += '<tr>';
                    cells.forEach((cell, i) => tableHTML += `<td style="text-align: ${alignments[i] || 'left'}">${cell}</td>`);
                    tableHTML += '</tr>';
                });
                return tableHTML + '</tbody></table>';
            });
        }

        static parseList(html) {
            const lines = html.split('\n');
            let inUnorderedList = false, inOrderedList = false;
            const processedLines = [];
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i], nextLine = lines[i + 1];
                if (/^[\-\*]\s+(.+)/.test(line)) {
                    if (!inUnorderedList) { processedLines.push('<ul>'); inUnorderedList = true; }
                    processedLines.push(line.replace(/^[\-\*]\s+(.+)/, '<li>$1</li>'));
                    if (!nextLine || !/^[\-\*]\s+/.test(nextLine)) { processedLines.push('</ul>'); inUnorderedList = false; }
                } else if (/^\d+\.\s+(.+)/.test(line)) {
                    if (!inOrderedList) { processedLines.push('<ol>'); inOrderedList = true; }
                    processedLines.push(line.replace(/^\d+\.\s+(.+)/, '<li>$1</li>'));
                    if (!nextLine || !/^\d+\.\s+/.test(nextLine)) { processedLines.push('</ol>'); inOrderedList = false; }
                } else {
                    processedLines.push(line);
                }
            }
            return processedLines.join('\n');
        }

        static cleanHTML(html) {
            return html.replace(/<p>\s*<\/p>/g, '')
                .replace(/<p>(<h[123]>)/g, '$1').replace(/(<\/h[123]>)<\/p>/g, '$1')
                .replace(/<p>(<ul>)/g, '$1').replace(/(<\/ul>)<\/p>/g, '$1')
                .replace(/<p>(<ol>)/g, '$1').replace(/(<\/ol>)<\/p>/g, '$1')
                .replace(/<p>(<pre>)/g, '$1').replace(/(<\/pre>)<\/p>/g, '$1')
                .replace(/<p>(<table)/g, '$1').replace(/(<\/table>)<\/p>/g, '$1')
                .replace(/\s{2,}/g, ' ')
                .trim();
        }
    }

    // Content Extractor Class
    class ContentExtractor {
        static extractArticle() {
            const title = document.querySelector('h1.Post-Title, .Post-Title')?.innerText || '';
            const content = document.querySelector('.Post-RichTextContainer, .RichText, .Post-RichText')?.innerText || '';
            return { type: 'article', title: title.trim(), content: content.trim(), sourceUrl: (typeof location !== 'undefined' ? location.href : '') };
        }

        static async extractQuestion() {
            const title = document.querySelector('h1.QuestionHeader-title, .QuestionHeader-title')?.innerText || '';
            const questionRichText = document.querySelector('.QuestionRichText');
            if (questionRichText?.classList.contains('QuestionRichText--collapsed')) {
                const expandButton = questionRichText.querySelector('.QuestionRichText-more');
                if (expandButton) {
                    expandButton.click();
                    await new Promise(resolve => {
                        const check = setInterval(() => {
                            if (!questionRichText.classList.contains('QuestionRichText--collapsed')) {
                                clearInterval(check);
                                resolve();
                            }
                        }, 100);
                        setTimeout(() => { clearInterval(check); resolve(); }, 2000);
                    });
                }
            }
            const description = document.querySelector('.QuestionRichText, .QuestionHeader-detail')?.innerText || '';
            return { type: 'question', title: title.trim(), content: description.trim(), sourceUrl: (typeof location !== 'undefined' ? location.href : '') };
        }

        static async extractAnswer(answerElement) {
            const questionTitle = document.querySelector('h1.QuestionHeader-title, .QuestionHeader-title')?.innerText || '';
            const questionDesc = document.querySelector('.QuestionRichText, .QuestionHeader-detail')?.innerText || '';
            const author = answerElement.querySelector('.AuthorInfo-name, .UserLink-link')?.innerText || '匿名用户';
            const contentElement = answerElement.querySelector('.RichContent-inner, .RichText');

            const selectors = ['button.ContentItem-expandButton', '.ContentItem-expandButton', 'button.ContentItem-rightButton', '.RichContent-inner button[class*="expand"]', 'button[class*="expandButton"]'];
            let expandButton = null;
            for (const selector of selectors) {
                const btn = answerElement.querySelector(selector);
                if (btn && (btn.innerText || btn.textContent || '').includes('展开')) {
                    expandButton = btn;
                    break;
                }
            }

            if (expandButton) {
                expandButton.click();
                await new Promise(resolve => {
                    let checkCount = 0;
                    const check = setInterval(() => {
                        checkCount++;
                        let currentButton = null;
                        for (const selector of selectors) {
                            const btn = answerElement.querySelector(selector);
                            if (btn) { currentButton = btn; break; }
                        }
                        if (!currentButton || currentButton.innerText.includes('收起') || checkCount >= 30) {
                            clearInterval(check);
                            resolve();
                        }
                    }, 100);
                });
                await new Promise(resolve => setTimeout(resolve, 300));
            }

            const content = contentElement?.innerText || '';
            return { type: 'answer', questionTitle: questionTitle.trim(), questionDesc: questionDesc.trim(), author: author.trim(), content: content.trim(), sourceUrl: (typeof location !== 'undefined' ? location.href : '') };
        }
    }

    // API Client Class
    class APIClient {
        constructor() {
            this.loadCurrentAccount();
        }

        async loadCurrentAccount() {
            let accounts = await storage.get('AI_ACCOUNTS', []);
            const currentAccountId = await storage.get('CURRENT_ACCOUNT_ID', '');

            if (!accounts || accounts.length === 0) {
                console.log('[ZhihuAI] No accounts found. Please configure API key in settings.');
                return;
            }

            const currentAccount = accounts.find(acc => acc.id === currentAccountId) || accounts[0];
            if (currentAccount) {
                this.apiKey = currentAccount.apiKey;
                this.apiUrl = currentAccount.apiUrl;
                this.model = currentAccount.model;
                this.provider = detectProvider(currentAccount);
                if (!currentAccountId) {
                    await storage.set('CURRENT_ACCOUNT_ID', currentAccount.id);
                }
            }
            this.maxTokens = 0;
            console.log('[ZhihuAI] Account loaded:', { hasKey: !!this.apiKey, model: this.model, provider: this.provider || 'custom' });
        }

        generatePrompt(content, type) {
            const prompts = {
                article: `请阅读【原文】并按系统要求输出（差分摘要）。\n\n【原文】\n标题：${content.title}\n作者：${content.author || '未知'}\n正文：${content.content.substring(0, 50000)}\n\n注意：\n- “你今天最该关心的点”必须偏向：新信息、关键论据、可行动建议、与你项目/偏好强相关处。\n- “你可以跳过的点”用于减少重复学习成本。\n- 不要引入原文没有的事实。`,
                question: `请阅读【问题页面文本】并按系统要求输出（差分摘要）。\n\n【问题】\n标题：${content.title}\n描述：${content.content.substring(0, 50000)}\n\n额外要求：\n- B 部分（差分重点）侧重：提问者真正卡点、隐藏前提、需要澄清的变量。\n- C 部分（可跳过）可列：重复背景、情绪化段落、与核心疑问无关的信息。`,
                answer: `请阅读【问答】并按系统要求输出（差分摘要）。\n\n【问题】\n标题：${content.questionTitle}\n描述：${content.questionDesc}\n\n【回答】\n作者：${content.author}\n内容：${content.content.substring(0, 50000)}\n\n额外要求：\n- B 部分（差分重点）优先挑：结论、关键论据/数据、可执行步骤、重要限定条件、容易误解处。\n- E 部分（证据）尽量覆盖 B 部分的每一条（原文短句≤20字）。`
            };
            return prompts[type];
        }

        async testConnection(apiKey, apiUrl, model) {
            try {
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({
                        model: model,
                        messages: [{ role: 'user', content: '测试连接' }],
                        max_tokens: 10,
                        stream: false
                    })
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
                }

                await response.json();
                return { success: true, message: '连接成功！API配置正确。' };
            } catch (error) {
                return {
                    success: false,
                    message: error.message.includes('Failed to fetch')
                        ? '连接失败：无法访问API接口，请检查网络连接、接口地址（例如 LongCat 应为 https://api.longcat.chat/openai/v1/chat/completions）'
                        : `连接失败：${error.message}`
                };
            }
        }

        async getDebugInfo() {
            const accounts = await storage.get('AI_ACCOUNTS', []);
            const currentAccountId = await storage.get('CURRENT_ACCOUNT_ID', '');
            const currentAccount = accounts.find(acc => acc.id === currentAccountId) || accounts[0] || null;
            return JSON.stringify({
                accountCount: Array.isArray(accounts) ? accounts.length : 0,
                currentAccountId: currentAccountId || null,
                hasCurrentAccount: !!currentAccount,
                hasApiUrl: !!currentAccount?.apiUrl,
                hasApiKey: !!currentAccount?.apiKey,
                provider: currentAccount ? detectProvider(currentAccount) : null
            });
        }


        // Non-stream completion (used for memory extraction)
        async completeOnce(messages, { maxTokens = 600, temperature = 0.2 } = {}) {
            if (!this.apiKey) {
                await this.loadCurrentAccount();
            }
            if (!this.apiKey) {
                const debug = await this.getDebugInfo();
                throw new Error(`请先配置 OpenAI/LongCat API Key！(Debug: ${debug})`);
            }

            const requestBody = {
                model: this.model,
                messages,
                temperature,
                stream: false
            };

            if (maxTokens && maxTokens > 0) requestBody.max_tokens = maxTokens;
            if (this.maxTokens > 0 && (!maxTokens || maxTokens > this.maxTokens)) {
                requestBody.max_tokens = this.maxTokens;
            }

            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
            }

            const data = await response.json();
            const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
            return (typeof content === 'string') ? content : JSON.stringify(content);
        }

        async streamCall(content, type, onChunk, onComplete, onError, systemPromptAddon = "") {
            if (!this.apiKey) {
                await this.loadCurrentAccount();
            }
            if (!this.apiKey) {
                const debug = await this.getDebugInfo();
                onError(new Error(`请先配置 OpenAI/LongCat API Key！(Debug: ${debug})`));
                return;
            }

            try {
                const requestBody = {
                    model: this.model,
                    messages: [
                        { role: 'system', content: '你是一个专业的内容总结助手，擅长从给定文本中提取关键信息并进行简洁准确的总结。请使用清晰的Markdown格式，优先使用标题、列表和短段落，避免使用表格。\n\n重要约束：\n- 只能基于用户提供的原文内容，不要引入原文未出现的信息或常识扩展。\n- 如信息缺失或无法判断，请明确写“原文未说明/不确定”，不要猜测。\n- 输出控制信息密度：少而关键，避免空话套话。' },
                        ...(systemPromptAddon ? [{ role: 'system', content: systemPromptAddon }] : []),
                        { role: 'user', content: this.generatePrompt(content, type) }
                    ],
                    temperature: 0.7,
                    stream: true
                };

                // Auto budget: if user didn't set maxTokens, keep outputs short (especially in delta mode)
                const autoDelta = (typeof systemPromptAddon === 'string') && systemPromptAddon.includes('输出结构（增量模式');
                if (this.maxTokens > 0) {
                    requestBody.max_tokens = this.maxTokens;
                } else if (autoDelta) {
                    requestBody.max_tokens = 600;
                } else {
                    requestBody.max_tokens = 1400;
                }

                const response = await fetch(this.apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
                    body: JSON.stringify(requestBody)
                });

                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                const processStream = async () => {
                    const { done, value } = await reader.read();
                    if (done) { onComplete(); return; }
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                        if (!line.trim() || line.trim() === 'data: [DONE]') continue;
                        if (line.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(line.substring(6));
                                if (data.choices?.[0]?.delta?.content) onChunk(data.choices[0].delta.content);
                            } catch (e) { }
                        }
                    }
                    return processStream();
                };

                await processStream();
            } catch (error) {
                const errorMessage = error.message.includes('Failed to fetch')
                    ? '请求失败：\n1. 请检查API接口地址是否正确（LongCat: https://api.longcat.chat/openai/v1/chat/completions）\n2. 请检查API服务是否可访问\n3. 请检查网络连接\n4. 请确认API Key有效（LongCat Key需可用）\n5. 如果使用代理，请确保代理配置正确'
                    : error.message;
                onError(new Error(errorMessage));
            }
        }

        // 支持对话历史的流式调用
        async streamCallWithHistory(messages, onChunk, onComplete, onError) {
            if (!this.apiKey) {
                await this.loadCurrentAccount();
            }
            if (!this.apiKey) {
                const debug = await this.getDebugInfo();
                onError(new Error(`请先配置 OpenAI/LongCat API Key！(Debug: ${debug})`));
                return;
            }

            try {
                const requestBody = {
                    model: this.model,
                    messages: messages,
                    temperature: 0.7,
                    stream: true
                };

                if (this.maxTokens > 0) {
                    requestBody.max_tokens = this.maxTokens;
                }

                const response = await fetch(this.apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
                    body: JSON.stringify(requestBody)
                });

                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                const processStream = async () => {
                    const { done, value } = await reader.read();
                    if (done) { onComplete(); return; }
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                        if (!line.trim() || line.trim() === 'data: [DONE]') continue;
                        if (line.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(line.substring(6));
                                if (data.choices?.[0]?.delta?.content) onChunk(data.choices[0].delta.content);
                            } catch (e) { }
                        }
                    }
                    return processStream();
                };

                await processStream();
            } catch (error) {
                const errorMessage = error.message.includes('Failed to fetch')
                    ? '请求失败：请检查网络连接和API配置'
                    : error.message;
                onError(new Error(errorMessage));
            }
        }
    }

    // Drag Manager Class
    class DragManager {
        constructor() {
            this.isDragging = false;
            this.currentPanel = null;
            this.startX = 0;
            this.startY = 0;
            this.initialLeft = 0;
            this.initialTop = 0;

            this.handleMouseMove = this.handleMouseMove.bind(this);
            this.handleMouseUp = this.handleMouseUp.bind(this);
        }

        attach(header, panel) {
            header.addEventListener('mousedown', (e) => this.startDrag(e, panel));
        }

        startDrag(e, panel) {
            // Ignore if clicking close button
            if (e.target.closest('.zhihu-ai-answer-result-close')) return;

            // Only allow left click
            if (e.button !== 0) return;

            this.isDragging = true;
            this.currentPanel = panel;

            this.startX = e.clientX;
            this.startY = e.clientY;

            // If panel is not direct child of body (embedded), pop it out
            if (panel.parentElement !== document.body) {
                const rect = panel.getBoundingClientRect();
                panel.style.width = rect.width + 'px';
                panel.style.height = 'auto';
                document.body.appendChild(panel);

                // Set initial fixed position based on current visual position
                panel.style.position = 'fixed';
                panel.style.top = rect.top + 'px';
                panel.style.left = rect.left + 'px';
                panel.style.margin = '0';
                panel.style.zIndex = '10000';
            } else {
                // If already in body (e.g. fixed question panel), ensure it's fixed and get current style
                const style = window.getComputedStyle(panel);
                // If it was just appended or has class styles, getBoundingClientRect is safest source of truth for "now"
                const rect = panel.getBoundingClientRect();
                panel.style.position = 'fixed';
                panel.style.top = rect.top + 'px';
                panel.style.left = rect.left + 'px';
                panel.style.margin = '0'; // Clear margins to prevent offsets
                panel.style.zIndex = '10000';
            }

            // Clear right/bottom if set, we drive by top/left
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';

            // Capture initial numeric values
            this.initialLeft = parseFloat(panel.style.left) || 0;
            this.initialTop = parseFloat(panel.style.top) || 0;

            document.addEventListener('mousemove', this.handleMouseMove);
            document.addEventListener('mouseup', this.handleMouseUp);
            e.preventDefault();
        }

        handleMouseMove(e) {
            if (!this.isDragging || !this.currentPanel) return;

            const dx = e.clientX - this.startX;
            const dy = e.clientY - this.startY;

            // Calculate new position
            let newLeft = this.initialLeft + dx;
            let newTop = this.initialTop + dy;

            // Optional: Simple bounds checking to keep header somewhat on screen
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight;

            // Keep at least 40px visible horizontally
            if (newLeft > windowWidth - 40) newLeft = windowWidth - 40;
            if (newLeft < -this.currentPanel.offsetWidth + 40) newLeft = -this.currentPanel.offsetWidth + 40;

            // Keep header visible vertically
            if (newTop < 0) newTop = 0;
            if (newTop > windowHeight - 40) newTop = windowHeight - 40;

            this.currentPanel.style.left = newLeft + 'px';
            this.currentPanel.style.top = newTop + 'px';
        }

        handleMouseUp() {
            this.isDragging = false;
            this.currentPanel = null;
            document.removeEventListener('mousemove', this.handleMouseMove);
            document.removeEventListener('mouseup', this.handleMouseUp);
        }
    }

    // UI Manager Class
    class UIManager {
        constructor() {
            this.apiClient = new APIClient();
            this.memoryManager = new MemoryManager(this.apiClient);
            this.dragManager = new DragManager();
            this.injectStyles();
            this.createConfigButton();
        }

        injectStyles() {
            const style = document.createElement('style');
            style.textContent = STYLES;
            document.head.appendChild(style);
        }

        createButton(onClick) {
            const button = document.createElement('button');
            button.className = 'zhihu-ai-summary-btn';
            button.innerHTML = `<svg class="icon" viewBox="0 0 1024 1024" fill="currentColor"><path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64z m0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/><path d="M464 336a48 48 0 1 0 96 0 48 48 0 1 0-96 0z m72 112h-48c-4.4 0-8 3.6-8 8v272c0 4.4 3.6 8 8 8h48c4.4 0 8-3.6 8-8V456c0-4.4-3.6-8-8-8z"/></svg><span>AI总结</span>`;
            button.addEventListener('click', onClick);
            return button;
        }

        createResultContainer(type) {
            const container = document.createElement('div');
            const modelName = escapeHtml(this.apiClient.model || 'AI');
            const titleMap = {
                answer: `AI 回答总结 (${modelName})`,
                article: `AI 文章总结 (${modelName})`,
                question: `AI 问题总结 (${modelName})`
            };

            container.className = 'zhihu-ai-answer-result';
            container.innerHTML = `
                <div class="zhihu-ai-answer-result-header">
                    <svg viewBox="0 0 1024 1024" fill="currentColor"><path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64z m0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/><path d="M464 336a48 48 0 1 0 96 0 48 48 0 1 0-96 0z m72 112h-48c-4.4 0-8 3.6-8 8v272c0 4.4 3.6 8 8 8h48c4.4 0 8-3.6 8-8V456c0-4.4-3.6-8-8-8z"/></svg>
                    <span class="zhihu-ai-result-title">${titleMap[type]}</span>
                    <button class="zhihu-ai-answer-result-close" title="关闭">×</button>
                </div>
                <div class="zhihu-ai-answer-result-body">
                    <div class="zhihu-ai-inline-loading"><div class="zhihu-ai-inline-spinner"></div><span>AI正在分析内容，请稍候...</span></div>
                </div>
                <div class="zhihu-ai-chat-container" style="display: none;">
                    <div class="zhihu-ai-chat-messages"></div>
                    <div class="zhihu-ai-chat-input-area">
                        <textarea class="zhihu-ai-chat-input" placeholder="继续提问..." rows="1"></textarea>
                        <button class="zhihu-ai-chat-send-btn" title="发送">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
                        </button>
                    </div>
                </div>
            `;
            container.querySelector('.zhihu-ai-answer-result-close').addEventListener('click', () => container.remove());
            return container;
        }

        async showInlineSummary(contentOrPromise, type, displayElement, insertTarget, existingContainer = null, authorName = null) {
            const container = existingContainer || this.createResultContainer(type);
            const content = contentOrPromise instanceof Promise ? await contentOrPromise : contentOrPromise;
            let topicCtx = null;


            // Ensure sourceUrl exists for stable topicId
            try { if (content && !content.sourceUrl && typeof location !== 'undefined') content.sourceUrl = location.href; } catch (e) {}
            try { topicCtx = await TopicMemory.getContext(content, type); } catch (e) { topicCtx = null; }
            if (authorName && type === 'answer') {
                container._authorName = authorName;
            }

            if (type === 'answer' || type === 'question' || type === 'article') {
                this.createAnswerSidePanel(container, insertTarget, type);
            }

            const body = container.querySelector('.zhihu-ai-answer-result-body');
            let accumulated = '';
            let rawAccumulated = '';
            const TOPIC_UPDATE_MARKER = '[[ZH_TOPIC_UPDATE]]';
            const authorPrefix = (type === 'answer' && authorName) ? `**对 ${authorName} 的回答进行AI总结**\n\n` : '';
            let memoryAddon = '';
            try {
                memoryAddon = await this.memoryManager.buildSystemPromptForSummary(content, type, authorName);
            } catch (e) {
                memoryAddon = '';
            }



            if (memoryAddon) {
                const header = container.querySelector('.zhihu-ai-answer-result-header');
                const memIndicator = document.createElement('span');
                memIndicator.style.cssText = 'font-size: 12px; color: #856404; background-color: #fff3cd; padding: 2px 6px; border-radius: 4px; margin-left: 10px; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; user-select: none;';
                memIndicator.innerHTML = '🧠 正在参考长期记忆';
                memIndicator.title = '点击查看引用的记忆内容';
                memIndicator.addEventListener('click', () => {
                    alert('【本次回答引用的记忆上下文】\n\n' + memoryAddon);
                });
                header.appendChild(memIndicator);
            }


            // Topic memory indicator (per question/topic)
            if (topicCtx && (type === 'answer' || type === 'question')) {
                const header = container.querySelector('.zhihu-ai-answer-result-header');
                const topicIndicator = document.createElement('span');
                topicIndicator.style.cssText = 'font-size: 12px; color: #666; display: inline-flex; align-items: center; gap: 4px; margin-left: 10px; cursor: pointer; user-select: none;';
                const modeLabel = (topicCtx.mode === 'delta') ? `Δ增量(≤${topicCtx.budget}条)` : '全量';
                topicIndicator.innerHTML = `📚 本题已读 ${topicCtx.seenCount} 篇 · ${modeLabel}`;
                topicIndicator.title = '点击查看本题主题记忆 keyPoints';
                topicIndicator.addEventListener('click', async () => {
                    try {
                        const st = await TopicMemory.load(topicCtx.topicId);
                        const pts = (st && Array.isArray(st.keyPoints)) ? st.keyPoints : [];
                        const text = pts.length ? pts.map(p => `- ${p}`).join('\n') : '(empty)';
                        alert(`【本题主题记忆】

topicId: ${topicCtx.topicId}
seenCount: ${st.seenCount || 0}

keyPoints:
${text}`);
                    } catch (e) {
                        alert('读取主题记忆失败');
                    }
                });
                header.appendChild(topicIndicator);
            }

            return new Promise((resolve, reject) => {
                this.apiClient.streamCall(
                    content,
                    type,
                    chunk => {
                        rawAccumulated += chunk;

                        const markerIndex = rawAccumulated.indexOf(TOPIC_UPDATE_MARKER);
                        if (markerIndex >= 0) {
                            accumulated = rawAccumulated.slice(0, markerIndex);
                        } else {
                            accumulated = rawAccumulated;
                        }

                        const fullText = authorPrefix + accumulated;
                        const escaped = fullText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
                        body.innerHTML = `<div style="white-space: normal; line-height: 1.6; font-size: 14px;">${escaped}<span class="zhihu-ai-streaming-cursor"></span></div>`;
                    },
                    async () => {
                        const fullText = authorPrefix + accumulated;
                        body.innerHTML = MarkdownParser.parse(fullText);
                        // Update per-topic memory (question-level) using model-provided update line
                        try {
                            const markerIndex = rawAccumulated.indexOf(TOPIC_UPDATE_MARKER);
                            if (markerIndex >= 0) {
                                const meta = rawAccumulated.slice(markerIndex + TOPIC_UPDATE_MARKER.length).trim();
                                if (meta) {
                                    const update = JSON.parse(meta);
                                    await TopicMemory.applyUpdate(update);
                                } else if (topicCtx && (type === 'answer' || type === 'question')) {
                                    await TopicMemory.applyUpdate({
                                        topicId: topicCtx.topicId,
                                        topicTitle: (content.questionTitle || content.title || ''),
                                        new_points: []
                                    });
                                }
                            } else if (topicCtx && (type === 'answer' || type === 'question')) {
                                await TopicMemory.applyUpdate({
                                    topicId: topicCtx.topicId,
                                    topicTitle: (content.questionTitle || content.title || ''),
                                    new_points: []
                                });
                            }
                        } catch (e) { }


                        // 写入两层记忆（Daily Notes / MEMORY.md）
                        try {
                            await this.memoryManager.recordSummaryEvent({
                                type,
                                url: (typeof location !== 'undefined' && location.href) ? location.href : '',
                                title: content?.title || '',
                                authorName: authorName || '',
                                summaryText: accumulated
                            });

                            // Show success indicator
                            const savedTip = document.createElement('div');
                            savedTip.style.cssText = 'position: absolute; bottom: 10px; right: 10px; font-size: 11px; color: #52c41a; background: #f6ffed; padding: 2px 8px; border: 1px solid #b7eb8f; border-radius: 4px; opacity: 0; transition: opacity 0.5s;';
                            savedTip.innerHTML = '✅ 已存入今日记忆';
                            container.appendChild(savedTip);
                            requestAnimationFrame(() => savedTip.style.opacity = '1');
                            setTimeout(() => {
                                savedTip.style.opacity = '0';
                                setTimeout(() => savedTip.remove(), 500);
                            }, 3000);

                        } catch (e) { }

                        // 初始化继续提问功能
                        await this.initChatFeature(container, content, type, accumulated);

                        resolve(container);
                    },
                    error => {
                        body.innerHTML = `<div class="zhihu-ai-inline-error">${escapeHtml(error?.message || '请求失败')}</div>`;
                        reject(error);
                    },
                    memoryAddon
                );
            });
        }


        createAnswerSidePanel(container, answerElement, panelType = 'answer') {
            const panel = document.createElement('div');
            panel.className = 'zhihu-ai-side-panel';
            panel.appendChild(container);

            if (panelType === 'question') {
                panel.classList.add('question-fixed');
                document.body.appendChild(panel);
            } else {
                if (!answerElement.style.position || answerElement.style.position === 'static') {
                    answerElement.style.position = 'relative';
                }

                const elementHeight = answerElement.offsetHeight;
                const minPanelHeight = window.innerHeight * 0.15;
                const maxPanelHeight = window.innerHeight - 90;

                if (elementHeight < maxPanelHeight) {
                    panel.classList.add('short');
                    const panelHeight = Math.max(minPanelHeight, elementHeight);
                    panel.style.height = 'auto';
                    panel.style.maxHeight = `${panelHeight}px`;
                } else {
                    panel.classList.add('long');
                }

                answerElement.appendChild(panel);

                if (panelType === 'article') {
                    panel.style.top = 0;
                    panel.style.left = '67%';
                }
            }

            panel.style.display = 'block';
            panel.style.opacity = '1';

            const closeBtn = container.querySelector('.zhihu-ai-answer-result-close');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => {
                    panel.remove();
                    if (panelType === 'article') {
                        const rightPanel = document.querySelector('.Post-Row-Content-right');
                        if (rightPanel) rightPanel.style.display = '';
                    }
                });
            }

            const header = container.querySelector('.zhihu-ai-answer-result-header');
            if (header) {
                this.dragManager.attach(header, panel);
            }

            return panel;
        }

        // 初始化继续提问功能
        async initChatFeature(container, originalContent, type, initialSummary) {
            const chatContainer = container.querySelector('.zhihu-ai-chat-container');
            const chatMessages = container.querySelector('.zhihu-ai-chat-messages');
            const chatInput = container.querySelector('.zhihu-ai-chat-input');
            const sendBtn = container.querySelector('.zhihu-ai-chat-send-btn');

            if (!chatContainer || !chatInput || !sendBtn) return;

            // 显示聊天区域
            chatContainer.style.display = 'block';

            // 模式状态（默认严格模式）
            let currentMode = 'strict';
            let conversationHistory = [];

            // 创建模式切换器UI
            const modeSwitcher = document.createElement('div');
            modeSwitcher.className = 'zhihu-ai-mode-switcher';
            modeSwitcher.innerHTML = `
                <button class="zhihu-ai-mode-btn active strict" data-mode="strict">
                    📄 严格模式
                </button>
                <button class="zhihu-ai-mode-btn free" data-mode="free">
                    💡 自由模式
                </button>
            `;
            chatContainer.insertBefore(modeSwitcher, chatMessages);

            // 创建模式指示器
            const modeIndicator = document.createElement('div');
            modeIndicator.className = 'zhihu-ai-mode-indicator strict';
            modeIndicator.innerHTML = '📄 当前：严格模式（仅回答文章内容）';
            chatContainer.insertBefore(modeIndicator, chatMessages);

            // 初始化对话历史的函数
            const initConversationHistory = async (mode) => {
                let memoryAddon = '';
                try {
                    memoryAddon = await this.memoryManager.buildSystemPromptForChat(mode, originalContent, type, initialSummary);
                } catch (e) { memoryAddon = ''; }

                const strictSystem = memoryAddon ? `${STRICT_MODE_PROMPT}\n\n${memoryAddon}` : STRICT_MODE_PROMPT;
                const freeSystem = memoryAddon ? `${FREE_MODE_PROMPT}\n\n${memoryAddon}` : FREE_MODE_PROMPT;

                if (mode === 'strict') {
                    // 严格模式：包含完整原文
                    return [
                        { role: 'system', content: strictSystem },
                        { role: 'user', content: this.apiClient.generatePrompt(originalContent, type) },
                        { role: 'assistant', content: initialSummary }
                    ];
                } else {
                    // 自由模式：仅包含总结
                    return [
                        { role: 'system', content: freeSystem },
                        { role: 'user', content: `我刚读了一篇文章，以下是AI的总结:\n\n${initialSummary}\n\n如果你的回答需要原文信息但总结中没有，请说明"总结未涉及此内容"。` },
                        { role: 'assistant', content: '好的，我了解了这篇文章的内容。您有什么问题吗？' }
                    ];
                }
            };


            // 初始化为严格模式
            conversationHistory = await initConversationHistory('strict');

            // 模式切换事件
            const modeButtons = modeSwitcher.querySelectorAll('.zhihu-ai-mode-btn');
            modeButtons.forEach(btn => {
                btn.addEventListener('click', async () => {
                    const newMode = btn.dataset.mode;
                    if (newMode === currentMode) return;

                    // 更新模式
                    currentMode = newMode;

                    // 更新按钮状态
                    modeButtons.forEach(b => b.classList.remove('active', 'strict', 'free'));
                    btn.classList.add('active', newMode);

                    // 更新容器样式
                    chatContainer.classList.remove('strict', 'free');
                    chatContainer.classList.add(newMode);

                    // 更新指示器
                    modeIndicator.className = `zhihu-ai-mode-indicator ${newMode}`;
                    if (newMode === 'strict') {
                        modeIndicator.innerHTML = '📄 当前：严格模式（仅回答文章内容）';
                    } else {
                        modeIndicator.innerHTML = '💡 当前：自由模式（可询问任何相关知识）';
                    }

                    // 清空现有对话
                    chatMessages.innerHTML = '';

                    // 重新初始化对话历史
                    conversationHistory = await initConversationHistory(newMode);

                    // 提示用户
                    const switchTip = document.createElement('div');
                    switchTip.className = 'zhihu-ai-chat-message ai';
                    switchTip.style.fontSize = '12px';
                    switchTip.style.opacity = '0.8';
                    switchTip.textContent = newMode === 'strict'
                        ? '已切换到严格模式，我将只基于文章原文回答问题。'
                        : '已切换到自由模式，我可以回答任何相关问题，包括背景知识和对比分析。';
                    chatMessages.appendChild(switchTip);
                });
            });

            // 设置初始容器样式
            chatContainer.classList.add('strict');


            // 自动调整输入框高度
            chatInput.addEventListener('input', () => {
                chatInput.style.height = 'auto';
                chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + 'px';
            });

            // 按Enter发送（Shift+Enter换行）
            chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendBtn.click();
                }
            });

            // 发送消息处理
            sendBtn.addEventListener('click', async () => {
                const userMessage = chatInput.value.trim();
                if (!userMessage) return;

                // 禁用输入
                chatInput.disabled = true;
                sendBtn.disabled = true;
                chatInput.value = '';
                chatInput.style.height = 'auto';

                // 添加用户消息到界面
                const userMsgEl = document.createElement('div');
                userMsgEl.className = 'zhihu-ai-chat-message user';
                userMsgEl.textContent = userMessage;
                chatMessages.appendChild(userMsgEl);

                // 添加AI消息占位
                const aiMsgEl = document.createElement('div');
                aiMsgEl.className = 'zhihu-ai-chat-message ai streaming';
                aiMsgEl.innerHTML = '<div class="zhihu-ai-inline-loading" style="padding: 0;"><div class="zhihu-ai-inline-spinner"></div><span>思考中...</span></div>';
                chatMessages.appendChild(aiMsgEl);

                // 滚动到底部
                chatMessages.scrollTop = chatMessages.scrollHeight;

                // 添加用户消息到历史
                conversationHistory.push({ role: 'user', content: userMessage });

                let aiAccumulated = '';

                // 调用API
                await this.apiClient.streamCallWithHistory(
                    conversationHistory,
                    chunk => {
                        aiAccumulated += chunk;
                        const escaped = aiAccumulated.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
                        aiMsgEl.innerHTML = `<div style="white-space: pre-wrap;">${escaped}<span class="zhihu-ai-streaming-cursor"></span></div>`;
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    },
                    async () => {
                        aiMsgEl.classList.remove('streaming');
                        aiMsgEl.innerHTML = MarkdownParser.parse(aiAccumulated);
                        conversationHistory.push({ role: 'assistant', content: aiAccumulated });

                        // 写入两层记忆（Daily Notes / MEMORY.md）
                        try {
                            await this.memoryManager.recordChatEvent({
                                type,
                                mode: currentMode,
                                url: (typeof location !== 'undefined' && location.href) ? location.href : '',
                                title: originalContent?.title || '',
                                question: userMessage,
                                answer: aiAccumulated
                            });
                        } catch (e) { }
                        chatInput.disabled = false;
                        sendBtn.disabled = false;
                        chatInput.focus();
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    },
                    error => {
                        aiMsgEl.classList.remove('streaming');
                        aiMsgEl.innerHTML = `<div class="zhihu-ai-inline-error">${escapeHtml(error?.message || '请求失败')}</div>`;
                        chatInput.disabled = false;
                        sendBtn.disabled = false;
                    }
                );
            });
        }

        createConfigButton() {
            const button = document.createElement('button');
            button.className = 'zhihu-ai-config-btn';
            button.innerHTML = '⚙️';
            button.title = '配置 OpenAI/LongCat API Key';
            button.addEventListener('click', () => this.showConfigModal());
            document.body.appendChild(button);
        }

        async showConfigModal() {
            const accounts = await storage.get('AI_ACCOUNTS', []);
            const currentAccountId = await storage.get('CURRENT_ACCOUNT_ID', '');
            const autoSummarize = await storage.get('AUTO_SUMMARIZE', false);
            const minAnswerLength = await storage.get('MIN_ANSWER_LENGTH', 200);
            const memoryEnabled = await storage.get('MEMORY_ENABLED', true);
            const memoryAutoExtract = await storage.get('MEMORY_AUTO_EXTRACT', true);
            const memoryWindowDays = await storage.get('MEMORY_WINDOW_DAYS', 2);


            const useServer = await storage.get('MEMORY_USE_SERVER', false);
            const serverUrl = await storage.get('MEMORY_SERVER_URL', 'http://127.0.0.1:8899');
            const minAnswerLengthValue = Number.isFinite(Number(minAnswerLength)) ? Number(minAnswerLength) : 200;
            const memoryWindowDaysValue = Number.isFinite(Number(memoryWindowDays)) ? Number(memoryWindowDays) : 2;
            const safeServerUrl = escapeAttr(serverUrl);

            const modal = document.createElement('div');
            modal.className = 'zhihu-ai-modal';
            modal.innerHTML = `
                <div class="zhihu-ai-modal-content">
                    <div class="zhihu-ai-modal-header">
                        <div class="zhihu-ai-modal-title">
                            <svg width="24" height="24" viewBox="0 0 1024 1024" fill="#667eea"><path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64z m0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/><path d="M464 336a48 48 0 1 0 96 0 48 48 0 1 0-96 0z m72 112h-48c-4.4 0-8 3.6-8 8v272c0 4.4 3.6 8 8 8h48c4.4 0 8-3.6 8-8V456c0-4.4-3.6-8-8-8z"/></svg>
                            配置 OpenAI/LongCat 兼容 API（记忆版 v1.0）
                        </div>
                        <button class="zhihu-ai-modal-close">×</button>
                    </div>
                    <div class="zhihu-ai-modal-body">
                        <div class="zhihu-ai-tabs">
                            <div class="zhihu-ai-tab active" data-tab="accounts">账号管理</div>
                            <div class="zhihu-ai-tab" data-tab="settings">基础设置</div>
                            <div class="zhihu-ai-tab" data-tab="memory">记忆设定</div>
                        </div>
                        <div class="zhihu-ai-tab-content active" id="accounts-tab">
                            <div class="zhihu-ai-account-list" id="account-list"></div>
                            <button class="zhihu-ai-add-account-btn" id="add-longcat-btn" style="margin-bottom: 8px;">⚡ 一键添加 LongCat</button>
                            <button class="zhihu-ai-add-account-btn" id="add-account-btn">+ 添加新账号</button>
                        </div>
                        <div class="zhihu-ai-tab-content" id="settings-tab">
                            <div class="zhihu-ai-config-panel">
                                <div class="zhihu-ai-config-item">
                                    <label class="zhihu-ai-config-label" style="display: flex; align-items: center; cursor: pointer;">
                                        <input type="checkbox" id="zhihu-ai-auto-summarize" ${autoSummarize ? 'checked' : ''} style="margin-right: 8px; width: 18px; height: 18px; cursor: pointer;">
                                        <span>自动总结(页面加载后自动调用AI总结文章和问题中的各个回答)</span>
                                    </label>
                                </div>
                                <div class="zhihu-ai-config-item">
                                    <label class="zhihu-ai-config-label">回答最少字数:</label>
                                    <input type="number" class="zhihu-ai-config-input" id="zhihu-ai-min-answer-length" value="${minAnswerLengthValue}" min="0" placeholder="200" style="width: 100%;">
                                    <div style="margin-top: 6px; font-size: 12px; color: #666;">回答字数少于此值时,不自动总结,仅显示提示信息(手动点击仍可总结)</div>
                                </div>
                                
                                <div class="zhihu-ai-config-item">
                                    <button class="zhihu-ai-config-save" id="save-settings-btn">保存设置</button>
                                </div>
                            </div>
                        </div>
                        <div class="zhihu-ai-tab-content" id="memory-tab">
                            <div class="zhihu-ai-config-panel">
                                <div class="zhihu-ai-config-item">
                                    <div style="background: #f9f9f9; padding: 10px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; color: #666;">
                                        <strong>记忆系统 (Experimental)</strong><br>
                                        启用后，AI 将根据您的“长期记忆”和“近期阅读流水”来优化总结和回答。
                                    </div>
                                    <label class="zhihu-ai-config-label" style="display: flex; align-items: center; cursor: pointer;">
                                        <input type="checkbox" id="zhihu-ai-memory-enabled" ${memoryEnabled ? 'checked' : ''} style="margin-right: 8px; width: 18px; height: 18px; cursor: pointer;">
                                        <span>启用记忆功能</span>
                                    </label>
                                </div>
                                
                                <div class="zhihu-ai-config-item">
                                    <div style="background: #f0f9ff; padding: 10px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; color: #666; border: 1px solid #bae6fd;">
                                        <strong>本地文件存储模式 (Advanced)</strong><br>
                                        需在本地运行 <code>python memory_server.py</code>。启用后，MEMORY.md 将直接读写本地文件，方便使用 Obsidian/VSCode 编辑。
                                    </div>
                                    <label class="zhihu-ai-config-label" style="display: flex; align-items: center; cursor: pointer;">
                                        <input type="checkbox" id="zhihu-ai-memory-use-server" ${useServer ? 'checked' : ''} style="margin-right: 8px; width: 18px; height: 18px; cursor: pointer;">
                                        <span>启用本地服务器存储</span>
                                    </label>
                                     <div class="zhihu-ai-config-item" style="margin-top: 10px; padding-left: 26px;">
                                        <label class="zhihu-ai-config-label">服务器地址：</label>
                                        <div style="display: flex; gap: 8px;">
                                            <input type="text" class="zhihu-ai-config-input" id="zhihu-ai-memory-server-url" value="${safeServerUrl}" placeholder="http://127.0.0.1:8899" style="flex: 1;">
                                            <button class="zhihu-ai-account-btn" id="test-server-btn" style="width: auto; padding: 0 12px;">测试连接</button>
                                        </div>
                                        <div id="server-status-msg" style="font-size: 12px; margin-top: 4px; color: #666; height: 1.5em;"></div>
                                    </div>
                                </div>

                                <div class="zhihu-ai-config-item">
                                    <label class="zhihu-ai-config-label" style="display: flex; align-items: center; cursor: pointer;">
                                        <input type="checkbox" id="zhihu-ai-memory-auto-extract" ${memoryAutoExtract ? 'checked' : ''} style="margin-right: 8px; width: 18px; height: 18px; cursor: pointer;">
                                        <span>自动从流水沉淀长期记忆（会额外产生一次小的API调用）</span>
                                    </label>
                                    <div class="zhihu-ai-config-item">
                                        <label class="zhihu-ai-config-label">近期流水天数：</label>
                                        <input type="number" id="zhihu-ai-memory-window-days" value="${memoryWindowDaysValue}" min="0" max="14" style="width: 100%;">
                                        <div style="margin-top: 6px; font-size: 12px; color: #666;">建议 1-3 天；越大上下文越长、消耗越高。</div>
                                    </div>
                                    <div style="margin-top: 8px; display:flex; gap:8px; flex-wrap: wrap;">
                                        <button class="zhihu-ai-account-btn zhihu-ai-account-btn-edit" id="edit-memory-btn" style="flex:1; min-width: 140px;">编辑 MEMORY.md</button>
                                        <button class="zhihu-ai-account-btn zhihu-ai-account-btn-edit" id="edit-today-daily-btn" style="flex:1; min-width: 140px;">编辑今日 Daily Notes</button>
                                    </div>
                                    <div style="margin-top: 8px; display:flex; gap:8px; flex-wrap: wrap;">
                                        <button class="zhihu-ai-account-btn zhihu-ai-account-btn-edit" id="extract-memory-now-btn" style="flex:1; min-width: 140px;">立即提炼（沉淀）</button>
                                        <button class="zhihu-ai-account-btn zhihu-ai-account-btn-delete" id="clear-memory-btn" style="flex:1; min-width: 140px;">清空记忆</button>
                                    </div>
                                    <div style="margin-top: 8px; font-size: 12px; color: #666;">
                                        Daily Notes 按天追加；MEMORY.md 是长期沉淀。它们都存储为可编辑的 Markdown（非黑盒）。
                                    </div>
                                </div>

                                <div class="zhihu-ai-config-item">
                                    <button class="zhihu-ai-config-save" id="save-memory-settings-btn">保存设置</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            const renderAccounts = async () => {
                const accountList = modal.querySelector('#account-list');
                const currentAccounts = await storage.get('AI_ACCOUNTS', []);
                const currentId = await storage.get('CURRENT_ACCOUNT_ID', '');

                if (currentAccounts.length === 0) {
                    accountList.innerHTML = '<div style="text-align: center; padding: 40px 20px; color: #999;">暂无账号，请添加新账号</div>';
                    return;
                }

                accountList.innerHTML = currentAccounts.map(account => {
                    const accountId = escapeAttr(account?.id || '');
                    const accountName = escapeHtml(account?.name || '');
                    const accountModel = escapeHtml(account?.model || '');
                    const accountProvider = detectProvider(account);
                    const accountProviderLabel = escapeHtml(providerLabel(accountProvider));
                    const accountUrl = String(account?.apiUrl || '');
                    const shortUrl = accountUrl.length > 40 ? accountUrl.substring(0, 40) + '...' : accountUrl;
                    const accountUrlPreview = escapeHtml(shortUrl);

                    return `
                    <div class="zhihu-ai-account-item ${account?.id === currentId ? 'active' : ''}" data-id="${accountId}">
                        <div class="zhihu-ai-account-info">
                            <div class="zhihu-ai-account-name">${accountName}</div>
                            <div class="zhihu-ai-account-detail">${accountModel} • ${accountUrlPreview}</div>
                            <div class="zhihu-ai-account-detail" style="margin-top: 3px;">提供商: ${accountProviderLabel}</div>
                        </div>
                        <div class="zhihu-ai-account-actions">
                            <button class="zhihu-ai-account-btn zhihu-ai-account-btn-edit" data-id="${accountId}">编辑</button>
                            <button class="zhihu-ai-account-btn zhihu-ai-account-btn-delete" data-id="${accountId}">删除</button>
                        </div>
                    </div>
                `;
                }).join('');

                accountList.querySelectorAll('.zhihu-ai-account-item').forEach(item => {
                    item.addEventListener('click', async (e) => {
                        if (e.target.classList.contains('zhihu-ai-account-btn')) return;
                        const accountId = item.dataset.id;
                        await storage.set('CURRENT_ACCOUNT_ID', accountId);
                        await this.apiClient.loadCurrentAccount();
                        renderAccounts();
                    });
                });

                accountList.querySelectorAll('.zhihu-ai-account-btn-edit').forEach(btn => {
                    btn.addEventListener('click', () => showAccountForm(btn.dataset.id));
                });

                accountList.querySelectorAll('.zhihu-ai-account-btn-delete').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        if (confirm('确定要删除这个账号吗？')) {
                            const accounts = await storage.get('AI_ACCOUNTS', []);
                            const filteredAccounts = accounts.filter(acc => acc.id !== btn.dataset.id);
                            await storage.set('AI_ACCOUNTS', filteredAccounts);
                            if (btn.dataset.id === await storage.get('CURRENT_ACCOUNT_ID', '')) {
                                await storage.set('CURRENT_ACCOUNT_ID', filteredAccounts[0]?.id || '');
                                await this.apiClient.loadCurrentAccount();
                            }
                            renderAccounts();
                        }
                    });
                });
            };

            const quickAddLongCat = async () => {
                const allAccounts = await storage.get('AI_ACCOUNTS', []);
                const normalizedPresetUrl = normalizeApiUrl(LONGCAT_PRESET_URL);
                let targetAccount = allAccounts.find(acc =>
                    detectProvider(acc) === 'longcat' ||
                    (normalizeApiUrl(acc?.apiUrl || '') === normalizedPresetUrl && String(acc?.apiKey || '') === LONGCAT_PRESET_KEY)
                );

                let nextAccounts = Array.isArray(allAccounts) ? allAccounts.slice() : [];
                if (targetAccount) {
                    let changed = false;
                    nextAccounts = nextAccounts.map(acc => {
                        if (acc.id !== targetAccount.id) return acc;
                        const next = { ...acc };
                        if (!next.name) { next.name = 'LongCat 默认'; changed = true; }
                        if (!next.model) { next.model = LONGCAT_PRESET_MODEL; changed = true; }
                        if (detectProvider(next) !== 'longcat') { next.provider = 'longcat'; changed = true; }
                        return next;
                    });
                    if (changed) {
                        await storage.set('AI_ACCOUNTS', nextAccounts);
                    }
                } else {
                    targetAccount = {
                        id: Date.now().toString(),
                        name: 'LongCat 默认',
                        apiUrl: LONGCAT_PRESET_URL,
                        apiKey: LONGCAT_PRESET_KEY,
                        model: LONGCAT_PRESET_MODEL,
                        provider: 'longcat'
                    };
                    nextAccounts.push(targetAccount);
                    await storage.set('AI_ACCOUNTS', nextAccounts);
                }

                await storage.set('CURRENT_ACCOUNT_ID', targetAccount.id);
                await this.apiClient.loadCurrentAccount();
                await renderAccounts();
                alert('已启用 LongCat 直连账号。');
            };

            const showAccountForm = async (editId = null) => {
                const accounts = await storage.get('AI_ACCOUNTS', []);
                const editAccount = editId ? accounts.find(acc => acc.id === editId) : null;
                const editName = escapeAttr(editAccount?.name || '');
                const editUrl = escapeAttr(editAccount?.apiUrl || '');
                const editKey = escapeAttr(editAccount?.apiKey || '');
                const editModel = escapeAttr(editAccount?.model || '');

                const formModal = document.createElement('div');
                formModal.className = 'zhihu-ai-modal';
                formModal.style.zIndex = '10001';
                formModal.innerHTML = `
                    <div class="zhihu-ai-modal-content" style="max-width: 500px;">
                        <div class="zhihu-ai-modal-header">
                            <div class="zhihu-ai-modal-title">${editId ? '编辑账号' : '添加账号'}</div>
                            <button class="zhihu-ai-modal-close">×</button>
                        </div>
                        <div class="zhihu-ai-modal-body">
                            <div class="zhihu-ai-config-panel">
                                <div class="zhihu-ai-config-item">
                                    <label class="zhihu-ai-config-label">备注名称:</label>
                                    <input type="text" class="zhihu-ai-config-input" id="account-name" value="${editName}" placeholder="默认使用API地址">
                                </div>
                                <div class="zhihu-ai-config-item">
                                    <label class="zhihu-ai-config-label">API接口地址:</label>
                                    <input type="text" class="zhihu-ai-config-input" id="account-url" value="${editUrl}" placeholder="https://api.openai.com/v1/chat/completions 或 https://api.longcat.chat/openai/v1/chat/completions">
                                </div>
                                <div class="zhihu-ai-config-item">
                                    <label class="zhihu-ai-config-label">API Key:</label>
                                    <input type="password" class="zhihu-ai-config-input" id="account-key" value="${editKey}" placeholder="sk-...">
                                </div>
                                <div class="zhihu-ai-config-item">
                                    <label class="zhihu-ai-config-label">模型名称:</label>
                                    <input type="text" class="zhihu-ai-config-input" id="account-model" value="${editModel}" placeholder="gpt-4o-mini 或 LongCat-Flash-Chat">
                                </div>
                                <div class="zhihu-ai-config-item" style="margin-top: -6px;">
                                    <button class="zhihu-ai-account-btn zhihu-ai-account-btn-edit" id="fill-longcat-preset-btn" style="width: 100%;">填充 LongCat 预设</button>
                                </div>
                                <div id="test-result-container"></div>
                                <div class="zhihu-ai-config-item">
                                    <button class="zhihu-ai-config-test" id="test-account-btn">测试连接</button>
                                    <button class="zhihu-ai-config-save" id="save-account-btn">${editId ? '保存修改' : '添加账号'}</button>
                                </div>
                            </div>
                        </div>
                    </div>
                `;

                formModal.querySelector('.zhihu-ai-modal-close').addEventListener('click', () => formModal.remove());
                formModal.addEventListener('click', e => { if (e.target === formModal) formModal.remove(); });
                formModal.querySelector('#fill-longcat-preset-btn').addEventListener('click', () => {
                    formModal.querySelector('#account-name').value = 'LongCat 默认';
                    formModal.querySelector('#account-url').value = LONGCAT_PRESET_URL;
                    formModal.querySelector('#account-key').value = LONGCAT_PRESET_KEY;
                    formModal.querySelector('#account-model').value = LONGCAT_PRESET_MODEL;
                });

                formModal.querySelector('#test-account-btn').addEventListener('click', async () => {
                    const url = formModal.querySelector('#account-url').value.trim();
                    const key = formModal.querySelector('#account-key').value.trim();
                    const model = formModal.querySelector('#account-model').value.trim();
                    const testBtn = formModal.querySelector('#test-account-btn');
                    const resultContainer = formModal.querySelector('#test-result-container');

                    if (!url || !key || !model) {
                        resultContainer.innerHTML = '<div class="zhihu-ai-test-result error">请填写完整信息</div>';
                        return;
                    }

                    testBtn.disabled = true;
                    testBtn.textContent = '测试中...';
                    resultContainer.innerHTML = '<div class="zhihu-ai-test-result" style="background: #f0f0f0; border: 1px solid #d9d9d9; color: #666;">正在测试连接...</div>';

                    const result = await this.apiClient.testConnection(key, url, model);

                    testBtn.disabled = false;
                    testBtn.textContent = '测试连接';

                    if (result.success) {
                        resultContainer.innerHTML = `<div class="zhihu-ai-test-result success">✓ ${escapeHtml(result.message)}</div>`;
                    } else {
                        resultContainer.innerHTML = `<div class="zhihu-ai-test-result error">✗ ${escapeHtml(result.message)}</div>`;
                    }
                });

                formModal.querySelector('#save-account-btn').addEventListener('click', async () => {
                    const name = formModal.querySelector('#account-name').value.trim();
                    const url = formModal.querySelector('#account-url').value.trim();
                    const key = formModal.querySelector('#account-key').value.trim();
                    const model = formModal.querySelector('#account-model').value.trim();

                    if (!url || !key || !model) {
                        alert('请填写完整的账号信息');
                        return;
                    }

                    const accounts = await storage.get('AI_ACCOUNTS', []);

                    if (editId) {
                        const index = accounts.findIndex(acc => acc.id === editId);
                        if (index !== -1) {
                            accounts[index] = {
                                id: editId,
                                name: name || url,
                                apiUrl: url,
                                apiKey: key,
                                model: model,
                                ...(isLongCatApiUrl(url) ? { provider: 'longcat' } : {})
                            };
                        }
                    } else {
                        const newAccount = {
                            id: Date.now().toString(),
                            name: name || url,
                            apiUrl: url,
                            apiKey: key,
                            model: model,
                            ...(isLongCatApiUrl(url) ? { provider: 'longcat' } : {})
                        };
                        accounts.push(newAccount);
                        await storage.set('CURRENT_ACCOUNT_ID', newAccount.id);
                    }

                    await storage.set('AI_ACCOUNTS', accounts);
                    await this.apiClient.loadCurrentAccount();
                    formModal.remove();
                    renderAccounts();
                });

                document.body.appendChild(formModal);
            };

            modal.querySelector('.zhihu-ai-modal-close').addEventListener('click', () => modal.remove());
            modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

            modal.querySelectorAll('.zhihu-ai-tab').forEach(tab => {
                tab.addEventListener('click', () => {
                    modal.querySelectorAll('.zhihu-ai-tab').forEach(t => t.classList.remove('active'));
                    modal.querySelectorAll('.zhihu-ai-tab-content').forEach(c => c.classList.remove('active'));
                    tab.classList.add('active');
                    modal.querySelector(`#${tab.dataset.tab}-tab`).classList.add('active');
                });
            });

            modal.querySelector('#add-longcat-btn').addEventListener('click', quickAddLongCat);
            modal.querySelector('#add-account-btn').addEventListener('click', () => showAccountForm());

            modal.querySelector('#save-settings-btn').addEventListener('click', async () => {
                const autoSum = modal.querySelector('#zhihu-ai-auto-summarize').checked;
                const memEnabled = modal.querySelector('#zhihu-ai-memory-enabled')?.checked ?? true;
                const memAutoExtract = modal.querySelector('#zhihu-ai-memory-auto-extract')?.checked ?? true;
                const memWindowDays = parseInt(modal.querySelector('#zhihu-ai-memory-window-days')?.value, 10);

                const minLength = parseInt(modal.querySelector('#zhihu-ai-min-answer-length').value) || 200;
                await storage.set('AUTO_SUMMARIZE', autoSum);
                await storage.set('MIN_ANSWER_LENGTH', minLength);
                await storage.set('MEMORY_ENABLED', memEnabled);
                await storage.set('MEMORY_AUTO_EXTRACT', memAutoExtract);
                await storage.set('MEMORY_WINDOW_DAYS', Number.isFinite(memWindowDays) ? memWindowDays : 2);

                alert('设置已保存！');
            });


            // Simple text editor for MEMORY.md / Daily Notes
            const openTextEditor = (title, initialValue, onSave) => {
                const editor = document.createElement('div');
                editor.className = 'zhihu-ai-modal';
                editor.style.zIndex = '2147483647';
                editor.innerHTML = `
                    <div class="zhihu-ai-modal-content" style="max-width: 860px;">
                        <div class="zhihu-ai-modal-header">
                            <div class="zhihu-ai-modal-title">${title}</div>
                            <button class="zhihu-ai-modal-close" id="editor-close-btn">&times;</button>
                        </div>
                        <div class="zhihu-ai-modal-body">
                            <textarea id="editor-textarea" style="width:100%; height: 420px; resize: vertical; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size: 12px; line-height: 1.5;"></textarea>
                            <div style="display:flex; gap:10px; margin-top: 12px; justify-content:flex-end;">
                                <button class="zhihu-ai-account-btn zhihu-ai-account-btn-edit" id="editor-save-btn">保存</button>
                                <button class="zhihu-ai-account-btn zhihu-ai-account-btn-delete" id="editor-cancel-btn">取消</button>
                            </div>
                            <div style="margin-top: 10px; font-size: 12px; color: #666;">
                                提示：这是可审计的 Markdown 记忆。建议用 Git 做版本管理，必要时可手动回滚。
                            </div>
                        </div>
                    </div>
                `;
                const ta = editor.querySelector('#editor-textarea');
                ta.value = initialValue || '';

                const close = () => editor.remove();
                editor.querySelector('#editor-close-btn').addEventListener('click', close);
                editor.querySelector('#editor-cancel-btn').addEventListener('click', close);
                editor.addEventListener('click', (e) => { if (e.target === editor) close(); });

                editor.querySelector('#editor-save-btn').addEventListener('click', async () => {
                    try {
                        await onSave(ta.value);
                        close();
                        alert('已保存！');
                    } catch (e) {
                        alert('保存失败：' + (e?.message || e));
                    }
                });

                document.body.appendChild(editor);
            };

            // Memory management buttons
            modal.querySelector('#edit-memory-btn')?.addEventListener('click', async () => {
                try {
                    const text = await this.memoryManager.getLongTermMemory();
                    openTextEditor('编辑 MEMORY.md（长期沉淀）', text, async (v) => {
                        await this.memoryManager.setLongTermMemory(v, { saveVersion: true });
                    });
                } catch (e) {
                    alert('读取失败：' + (e?.message || e));
                }
            });

            modal.querySelector('#edit-today-daily-btn')?.addEventListener('click', async () => {
                try {
                    const key = toDateKey();
                    const text = await this.memoryManager.getDailyNotes(key);
                    openTextEditor(`编辑 Daily Notes（${key}）`, text || `## ${key}\n`, async (v) => {
                        await this.memoryManager.setDailyNotes(key, v);
                    });
                } catch (e) {
                    alert('读取失败：' + (e?.message || e));
                }
            });

            modal.querySelector('#extract-memory-now-btn')?.addEventListener('click', async () => {
                try {
                    await this.memoryManager.maybeExtractLongTerm({ force: true, reason: 'manual' });
                    alert('已尝试提炼（沉淀）完成。');
                } catch (e) {
                    alert('提炼失败：' + (e?.message || e));
                }
            });

            modal.querySelector('#clear-memory-btn')?.addEventListener('click', async () => {
                const ok = confirm('确定要清空两层记忆吗？（会删除 MEMORY.md 与最近7天 Daily Notes）');
                if (!ok) return;
                try {
                    await this.memoryManager.clearAllMemory();
                    alert('已清空。');
                } catch (e) {
                    alert('清空失败：' + (e?.message || e));
                }
            });

            modal.querySelector('#save-memory-settings-btn')?.addEventListener('click', async () => {
                const memEnabled = modal.querySelector('#zhihu-ai-memory-enabled')?.checked ?? true;
                const memAutoExtract = modal.querySelector('#zhihu-ai-memory-auto-extract')?.checked ?? true;
                const memWindowDays = parseInt(modal.querySelector('#zhihu-ai-memory-window-days')?.value, 10);
                const useServer = modal.querySelector('#zhihu-ai-memory-use-server')?.checked ?? false;
                const serverUrl = modal.querySelector('#zhihu-ai-memory-server-url')?.value?.trim() || 'http://127.0.0.1:8899';

                await storage.set('MEMORY_ENABLED', memEnabled);
                await storage.set('MEMORY_AUTO_EXTRACT', memAutoExtract);
                await storage.set('MEMORY_WINDOW_DAYS', Number.isFinite(memWindowDays) ? memWindowDays : 2);
                await storage.set('MEMORY_USE_SERVER', useServer);
                await storage.set('MEMORY_SERVER_URL', serverUrl.replace(/\/$/, '')); // remove trailing slash

                alert('记忆设置已保存！' + (useServer ? '\n已启用本地服务器模式。' : ''));
            });

            modal.querySelector('#test-server-btn')?.addEventListener('click', async () => {
                const btn = modal.querySelector('#test-server-btn');
                const statusDiv = modal.querySelector('#server-status-msg');
                const url = modal.querySelector('#zhihu-ai-memory-server-url').value.trim().replace(/\/$/, '');

                btn.disabled = true;
                btn.textContent = '连接中...';
                statusDiv.textContent = '正在连接本地服务器...';
                statusDiv.style.color = '#666';

                try {
                    const res = await fetch(`${url}/status`, { signal: AbortSignal.timeout(2000) });
                    if (res.ok) {
                        const data = await res.json();
                        statusDiv.innerHTML = `✅ 连接成功<br>工作目录: ${escapeHtml(data?.directory || '')}`;
                        statusDiv.style.color = 'green';
                    } else {
                        statusDiv.textContent = `❌ 连接失败: ${res.status} ${res.statusText}`;
                        statusDiv.style.color = 'red';
                    }
                } catch (e) {
                    statusDiv.textContent = `❌ 连接失败: ${e.message}. 请确认 python server 是否运行。`;
                    statusDiv.style.color = 'red';
                } finally {
                    btn.disabled = false;
                    btn.textContent = '测试连接';
                }
            });

            document.body.appendChild(modal);
            renderAccounts();
        }

        async waitForElement(selector, timeout = 5000) {
            if (document.querySelector(selector)) return document.querySelector(selector);
            return new Promise((resolve, reject) => {
                const observer = new MutationObserver(() => {
                    if (document.querySelector(selector)) {
                        observer.disconnect();
                        resolve(document.querySelector(selector));
                    }
                });
                observer.observe(document.body, { childList: true, subtree: true });
                setTimeout(() => { observer.disconnect(); reject(new Error('Element not found')); }, timeout);
            });
        }
    }

    // Main Application Class
    class ZhihuAISummary {
        constructor() {
            console.log('知乎AI总结浏览器插件已加载');
            this.ui = new UIManager();
            this.init();
        }

        init() {
            const url = window.location.href;
            if (url.includes('zhuanlan.zhihu.com/p/')) {
                this.handleArticlePage();
            } else if (url.includes('www.zhihu.com/question/')) {
                this.handleQuestionPage();
            } else if (url === 'https://www.zhihu.com/' || url.includes('www.zhihu.com/follow') || url.includes('www.zhihu.com/hot')) {
                this.handleHomePage();
            }
        }

        async handleArticlePage() {
            try {
                await this.ui.waitForElement('.Post-Header, .ContentItem-title');
                if (document.querySelector('.zhihu-ai-summary-btn-article')) return;
                const authorHead = document.querySelector('.AuthorInfo-head');
                if (!authorHead) return;

                const articleContainer = document.querySelector('.Post-Row-Content') ||
                    document.querySelector('.Post-Row-Content-left') ||
                    authorHead.closest('article') ||
                    authorHead.closest('.Post-Main');

                const button = this.ui.createButton(async () => {
                    const existingPanel = articleContainer.querySelector('.zhihu-ai-side-panel');
                    if (existingPanel) {
                        existingPanel.remove();
                    }

                    button.classList.add('loading');

                    try {
                        const content = ContentExtractor.extractArticle();
                        if (!content.content) {
                            alert('未能提取到文章内容');
                            button.classList.remove('loading');
                            return;
                        }

                        const rightPanel = document.querySelector('.Post-Row-Content-right');
                        if (rightPanel) rightPanel.style.display = 'none';

                        const container = this.ui.createResultContainer('article');

                        await this.ui.showInlineSummary(content, 'article', null, articleContainer, container);

                    } catch (error) {
                        console.error('生成文章总结失败:', error);
                    } finally {
                        button.classList.remove('loading');
                    }
                });
                button.classList.add('zhihu-ai-summary-btn-article', 'zhihu-ai-summary-btn-answer');
                authorHead.appendChild(button);

                if (await storage.get('AUTO_SUMMARIZE', false)) setTimeout(() => button.click(), 500);
            } catch (err) {
                console.error('文章页面处理失败:', err);
            }
        }

        async handleQuestionPage() {
            setTimeout(async () => {
                const titleElements = document.querySelectorAll('.QuestionHeader-title');
                const titleElement = titleElements[1] || titleElements[0]; // Fallback to first if second doesn't exist
                if (!titleElement || document.querySelector('.zhihu-ai-summary-btn-question')) return;

                const questionContainer = document.querySelector('.QuestionHeader') ||
                    document.querySelector('.Question-mainColumn') ||
                    titleElement.closest('.QuestionHeader-content');

                const button = this.ui.createButton(async () => {
                    const existingPanel = document.querySelector('.zhihu-ai-side-panel.question-fixed');
                    if (existingPanel) {
                        existingPanel.remove();
                    }

                    button.classList.add('loading');

                    try {
                        const content = await ContentExtractor.extractQuestion();
                        const container = this.ui.createResultContainer('question');

                        await this.ui.showInlineSummary(content, 'question', null, questionContainer, container);

                    } catch (error) {
                        console.error('生成问题总结失败:', error);
                    } finally {
                        button.classList.remove('loading');
                    }
                });
                button.classList.add('zhihu-ai-summary-btn-question');

                const titleParent = titleElement.parentElement;
                titleParent.insertBefore(button, titleElement);
            }, 2000);

            this.addAnswerButtons();
            const observer = new MutationObserver(() => this.addAnswerButtons());
            observer.observe(document.body, { childList: true, subtree: true });
        }

        async handleHomePage() {
            console.log('Initiating Homepage Handler');
            // Wait for feed to load
            await this.ui.waitForElement('.Topstory-recommend .Card.TopstoryItem', 10000).catch(e => console.log('Feed wait timeout'));

            this.addFeedButtons();

            // Observe for infinite scroll
            const observer = new MutationObserver((mutations) => {
                let shouldUpdate = false;
                for (const mutation of mutations) {
                    if (mutation.addedNodes.length > 0) {
                        shouldUpdate = true;
                        break;
                    }
                }
                if (shouldUpdate) this.addFeedButtons();
            });

            const feedContainer = document.querySelector('.Topstory-recommend') || document.querySelector('.TopstoryMain');
            if (feedContainer) {
                observer.observe(feedContainer, { childList: true, subtree: true });
            }
        }

        addFeedButtons() {
            const items = document.querySelectorAll('.Card.TopstoryItem');

            items.forEach(item => {
                // Ensure we only process Unprocessed items
                if (item.querySelector('.zhihu-ai-summary-btn-feed')) return;

                // Identify content type: Answer or Article
                const isArticle = item.querySelector('.ArticleItem') !== null;
                const isAnswer = item.querySelector('.AnswerItem') !== null;

                if (!isArticle && !isAnswer) return; // Skip if unknown type

                const titleEl = item.querySelector('.ContentItem-title');
                if (!titleEl) return;

                const button = this.ui.createButton(async (e) => {
                    e.stopPropagation(); // Prevent card click

                    const existingPanel = item.querySelector('.zhihu-ai-side-panel');
                    if (existingPanel) { existingPanel.remove(); return; }

                    button.classList.add('loading');

                    try {
                        let contentResult;

                        // 1. Expand content if needed
                        const expandBtn = item.querySelector('.ContentItem-more');
                        if (expandBtn) {
                            expandBtn.click();
                            // Wait for expansion
                            await new Promise(resolve => setTimeout(resolve, 800));
                        }

                        // 2. Extract
                        if (isArticle) {
                            // Article extraction logic adapted for feed item
                            // Sometimes feed item structure is slightly different than full page
                            // But usually .RichContent-inner is there after expansion
                            const title = titleEl.innerText.trim();
                            const contentElement = item.querySelector('.RichContent-inner') || item.querySelector('.RichText');
                            const contentText = contentElement ? contentElement.innerText.trim() : '';

                            contentResult = { type: 'article', title: title, content: contentText };

                        } else {
                            // Answer extraction
                            // Use existing extractAnswer but pass the item
                            // We need to conform to extractAnswer's expectations or just extract manually here
                            const questionTitle = titleEl.innerText.trim();
                            const authorEl = item.querySelector('.AuthorInfo-name') || item.querySelector('.UserLink-link');
                            const author = authorEl ? authorEl.innerText.trim() : '匿名用户';
                            const contentElement = item.querySelector('.RichContent-inner') || item.querySelector('.RichText');
                            const contentText = contentElement ? contentElement.innerText.trim() : '';

                            contentResult = {
                                type: 'answer',
                                questionTitle: questionTitle,
                                questionDesc: '', // Feed doesn't usually show question desc
                                author: author,
                                content: contentText,
                                sourceUrl: (titleEl && titleEl.querySelector('a')) ? titleEl.querySelector('a').href : ''
                            };
                        }

                        if (!contentResult.content || contentResult.content.length < 50) {
                            alert('无法提取内容，请确保内容已展开');
                            return;
                        }

                        const container = this.ui.createResultContainer(contentResult.type);
                        if (contentResult.type === 'answer') container._authorName = contentResult.author;

                        // Show inline
                        // For feed items, we might want to insert the panel inside the item but make sure it doesn't break layout
                        // The 'ContentItem-actions' bar is a good anchor or just append to .ContentItem

                        await this.ui.showInlineSummary(contentResult, contentResult.type, null, item, container, contentResult.author);

                    } catch (err) {
                        console.error('Feed Summary Error:', err);
                    } finally {
                        button.classList.remove('loading');
                    }
                });

                button.classList.add('zhihu-ai-summary-btn-feed');
                button.innerHTML = `<svg class="icon" viewBox="0 0 1024 1024" fill="currentColor" style="width:14px;height:14px;"><path d="M512 64C264.6 64 64 264.6 64 512..."></path></svg> AI`;
                button.style.cssText = "margin-left: 10px; padding: 2px 8px; font-size: 12px; height: 24px; vertical-align: middle;";

                // Inject after title
                if (titleEl.parentElement) {
                    titleEl.parentElement.insertBefore(button, titleEl.nextSibling);
                }
            });
        }

        async addAnswerButtons() {
            const answers = document.querySelectorAll('.ContentItem.AnswerItem');
            const autoSummarize = await storage.get('AUTO_SUMMARIZE', false);

            answers.forEach((answerItem, index) => {
                if (answerItem.querySelector('.zhihu-ai-summary-btn-answer')) return;
                const authorHead = answerItem.querySelector('.AuthorInfo-head');
                if (!authorHead) return;

                const authorLink = answerItem.querySelector('.AuthorInfo-head a.UserLink-link');
                const authorName = authorLink ? authorLink.innerText.trim() : '匿名用户';

                const button = this.ui.createButton(async (event) => {
                    const existingPanel = answerItem.querySelector('.zhihu-ai-side-panel');
                    if (existingPanel) {
                        existingPanel.remove();
                    }

                    const isManualClick = event && event.isTrusted !== false;
                    button.classList.add('loading');

                    try {
                        const content = await ContentExtractor.extractAnswer(answerItem);

                        const container = this.ui.createResultContainer('answer');
                        container._authorName = authorName;

                        if (!content.content) {
                            const panel = this.ui.createAnswerSidePanel(container, answerItem, 'answer');
                            const body = container.querySelector('.zhihu-ai-answer-result-body');
                            body.innerHTML = `<div style="display: flex; align-items: center; justify-content: center; height: 100%; text-align: center; color: #666; line-height: 1.8;">
                                <div>
                                    <div style="font-size: 15px; font-weight: 500; margin-bottom: 8px;">未提取到回答内容</div>
                                    <div style="font-size: 13px; color: #999;">无法进行AI总结</div>
                                </div>
                            </div>`;
                            button.classList.remove('loading');
                            return;
                        }

                        const minAnswerLength = await storage.get('MIN_ANSWER_LENGTH', 200);
                        const contentLength = content.content.length;

                        if (!isManualClick && contentLength < minAnswerLength) {
                            const panel = this.ui.createAnswerSidePanel(container, answerItem, 'answer');
                            const body = container.querySelector('.zhihu-ai-answer-result-body');
                            body.innerHTML = `<div style="display: flex; align-items: center; justify-content: center; height: 100%; text-align: center; color: #666; line-height: 1.8;">
                                <div>
                                    <div style="font-size: 15px; font-weight: 500; margin-bottom: 8px;">回答内容较短</div>
                                    <div style="font-size: 14px;">回答少于 ${minAnswerLength} 字（当前 ${contentLength} 字）</div>
                                    <div style="font-size: 13px; color: #999; margin-top: 8px;">可手动点击AI总结按钮触发总结</div>
                                </div>
                            </div>`;
                            button.classList.remove('loading');
                            return;
                        }

                        await this.ui.showInlineSummary(content, 'answer', null, answerItem, container, authorName);

                    } catch (error) {
                        console.error('生成总结失败 - 作者:', authorName, 'Error:', error);
                    } finally {
                        button.classList.remove('loading');
                    }
                });
                button.classList.add('zhihu-ai-summary-btn-answer');
                authorHead.appendChild(button);

                if (autoSummarize) {
                    setTimeout(() => button.click(), 1000 + index * 500);
                }
            });
        }
    }

    // Initialize application
    let appInstance;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            appInstance = new ZhihuAISummary();
        });
    } else {
        appInstance = new ZhihuAISummary();
    }

    // Listen for messages from popup
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'openSettings') {
            if (appInstance && appInstance.ui) {
                appInstance.ui.showConfigModal();
            }
        }
    });
})();
