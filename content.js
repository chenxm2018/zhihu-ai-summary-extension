(function () {
    'use strict';

    // Storage wrapper for chrome.storage.sync
    const storage = {
        async get(key, defaultValue) {
            return new Promise((resolve) => {
                chrome.storage.sync.get({ [key]: defaultValue }, (result) => {
                    resolve(result[key]);
                });
            });
        },
        async set(key, value) {
            return new Promise((resolve) => {
                chrome.storage.sync.set({ [key]: value }, resolve);
            });
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
        .zhihu-ai-answer-result { padding: 20px; background: white; overflow-y: auto; }
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
    `;

    // Markdown Parser Class
    class MarkdownParser {
        static parse(markdown) {
            let html = markdown.replace(/\n{3,}/g, '\n\n');
            html = html.replace(/```[\s\S]*?```/g, match => {
                const codeMatch = match.match(/```(\w+)?\n?([\s\S]*?)```/);
                return codeMatch ? `<pre><code>${codeMatch[2]}</code></pre>` : match;
            });
            html = this.parseTable(html);
            html = html.replace(/^### (.+)$/gim, '<h3>$1</h3>').replace(/^## (.+)$/gim, '<h2>$1</h2>').replace(/^# (.+)$/gim, '<h1>$1</h1>');
            html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
            html = this.parseList(html);
            html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
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
            return { type: 'article', title: title.trim(), content: content.trim() };
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
            return { type: 'question', title: title.trim(), content: description.trim() };
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
            return { type: 'answer', questionTitle: questionTitle.trim(), questionDesc: questionDesc.trim(), author: author.trim(), content: content.trim() };
        }
    }

    // API Client Class
    class APIClient {
        constructor() {
            this.loadCurrentAccount();
        }

        async loadCurrentAccount() {
            const accounts = await storage.get('AI_ACCOUNTS', []);
            const currentAccountId = await storage.get('CURRENT_ACCOUNT_ID', '');

            if (accounts.length === 0) {
                const legacyKey = await storage.get('OPENAI_API_KEY', '');
                const legacyUrl = await storage.get('OPENAI_API_URL', 'https://api.openai.com/v1/chat/completions');
                const legacyModel = await storage.get('OPENAI_MODEL', 'gpt-4o-mini');

                if (legacyKey) {
                    const defaultAccount = {
                        id: Date.now().toString(),
                        name: legacyUrl,
                        apiUrl: legacyUrl,
                        apiKey: legacyKey,
                        model: legacyModel
                    };
                    accounts.push(defaultAccount);
                    await storage.set('AI_ACCOUNTS', accounts);
                    await storage.set('CURRENT_ACCOUNT_ID', defaultAccount.id);
                    this.apiKey = defaultAccount.apiKey;
                    this.apiUrl = defaultAccount.apiUrl;
                    this.model = defaultAccount.model;
                } else {
                    this.apiKey = '';
                    this.apiUrl = 'https://api.openai.com/v1/chat/completions';
                    this.model = 'gpt-4o-mini';
                }
            } else {
                const currentAccount = accounts.find(acc => acc.id === currentAccountId) || accounts[0];
                if (currentAccount) {
                    this.apiKey = currentAccount.apiKey;
                    this.apiUrl = currentAccount.apiUrl;
                    this.model = currentAccount.model;
                    if (!currentAccountId) {
                        await storage.set('CURRENT_ACCOUNT_ID', currentAccount.id);
                    }
                }
            }
            this.maxTokens = 0;
        }

        generatePrompt(content, type) {
            const prompts = {
                article: `请对以下知乎文章进行总结，提取关键信息和要点：\n\n标题：${content.title}\n\n内容：${content.content.substring(0, 50000)}\n\n请从以下方面进行分析：\n0. **超短总结（≤120字）**：用1段话概括“文章核心在讨论什么主题 + 给出什么核心方法/结论”。要求信息密度高，不写空话，不扩展科普。\n1. **核心观点**：总结文章的主要论点和结论（2-3句话）\n2. **关键论据**：列出文章中的重要依据、数据、案例或事实（至少3点）\n3. **实用建议**：如果文章中有具体建议或方法，请明确列出\n4. **价值评估**：简短评价该文章是否有深度、论据是否充分、是否有实用价值（1-2句话）\n\n要求：\n- 提取的信息要具体完整，保留关键数据和细节\n- 用清晰的格式输出，使用标题和列表\n- 避免使用表格\n- 不要引入文章中不存在的信息；不确定就写“不确定/原文未说明”`,
                question: `请详细总结以下知乎问题：\n\n问题：${content.title}\n\n描述：${content.content.substring(0, 50000)}\n\n请从以下方面进行总结：\n1. **核心疑问**：用1-2句话说明提问者的主要困惑或需求\n2. **背景信息**：列出问题中提到的关键背景、场景或前提条件\n3. **具体诉求**：提问者希望得到什么样的答案或建议\n\n要求：\n- 信息要具体完整，不要遗漏重要细节\n- 使用清晰的标题和列表展示\n- 避免使用表格`,
                answer: `请基于以下知乎问题，详细分析该回答：\n\n【问题】\n标题：${content.questionTitle}\n描述：${content.questionDesc}\n\n【回答】\n作者：${content.author}\n内容：${content.content.substring(0, 50000)}\n\n请从以下方面进行分析：\n0. **超短总结（≤120字）**：用1段话概括“回答在解决什么矛盾/误区 + 给出什么核心方法/结论”。要求信息密度高，不写空话，不扩展科普。\n1. **核心观点**：总结回答的主要论点和结论（2-3句话）\n2. **关键论据**：列出回答中的重要依据、数据、案例或事实（至少3点）\n3. **实用建议**：如果回答中有具体建议或方法，请明确列出\n4. **价值评估**：简短评价该回答是否切题、论据是否充分、是否有实用价值（1-2句话）\n\n要求：\n- 提取的信息要具体完整，保留关键数据和细节\n- 用清晰的格式输出，使用标题和列表\n- 避免使用表格\n- 不要引入回答中不存在的信息；不确定就写“不确定/原文未说明”\n- “超短总结”必须只基于回答内容，问题仅用于限定语境`
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
                        ? '连接失败：无法访问API接口，请检查网络连接和接口地址'
                        : `连接失败：${error.message}`
                };
            }
        }

        async streamCall(content, type, onChunk, onComplete, onError) {
            if (!this.apiKey) {
                onError(new Error('请先配置OpenAI API Key！点击右下角设置按钮进行配置。'));
                return;
            }

            try {
                const requestBody = {
                    model: this.model,
                    messages: [
                        { role: 'system', content: '你是一个专业的内容总结助手，擅长从给定文本中提取关键信息并进行简洁准确的总结。请使用清晰的Markdown格式，优先使用标题、列表和短段落，避免使用表格。\n\n重要约束：\n- 只能基于用户提供的原文内容，不要引入原文未出现的信息或常识扩展。\n- 如信息缺失或无法判断，请明确写“原文未说明/不确定”，不要猜测。\n- 输出控制信息密度：少而关键，避免空话套话。' },
                        { role: 'user', content: this.generatePrompt(content, type) }
                    ],
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
                    ? '请求失败：\n1. 请检查API接口地址是否正确\n2. 请检查API服务是否可访问\n3. 请检查网络连接\n4. 如果使用代理，请确保代理配置正确'
                    : error.message;
                onError(new Error(errorMessage));
            }
        }

        // 支持对话历史的流式调用
        async streamCallWithHistory(messages, onChunk, onComplete, onError) {
            if (!this.apiKey) {
                onError(new Error('请先配置OpenAI API Key！点击右下角设置按钮进行配置。'));
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
            const modelName = this.apiClient.model || 'AI';
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

            if (authorName && type === 'answer') {
                container._authorName = authorName;
            }

            if (type === 'answer' || type === 'question' || type === 'article') {
                this.createAnswerSidePanel(container, insertTarget, type);
            }

            const body = container.querySelector('.zhihu-ai-answer-result-body');
            let accumulated = '';

            const authorPrefix = (type === 'answer' && authorName) ? `**对 ${authorName} 的回答进行AI总结**\n\n` : '';

            return new Promise((resolve, reject) => {
                this.apiClient.streamCall(
                    content,
                    type,
                    chunk => {
                        accumulated += chunk;
                        const fullText = authorPrefix + accumulated;
                        const escaped = fullText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
                        body.innerHTML = `<div style="white-space: pre-wrap;">${escaped}<span class="zhihu-ai-streaming-cursor"></span></div>`;
                    },
                    () => {
                        const fullText = authorPrefix + accumulated;
                        body.innerHTML = MarkdownParser.parse(fullText);

                        // 初始化继续提问功能
                        this.initChatFeature(container, content, type, accumulated);

                        resolve(container);
                    },
                    error => {
                        body.innerHTML = `<div class="zhihu-ai-inline-error">${error.message}</div>`;
                        reject(error);
                    }
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
        initChatFeature(container, originalContent, type, initialSummary) {
            const chatContainer = container.querySelector('.zhihu-ai-chat-container');
            const chatMessages = container.querySelector('.zhihu-ai-chat-messages');
            const chatInput = container.querySelector('.zhihu-ai-chat-input');
            const sendBtn = container.querySelector('.zhihu-ai-chat-send-btn');

            if (!chatContainer || !chatInput || !sendBtn) return;

            // 显示聊天区域
            chatContainer.style.display = 'block';

            // 构建初始对话历史
            const conversationHistory = [
                { role: 'system', content: '你是一个专业的内容分析助手。用户会基于之前的总结向你追问，请结合原文内容与已给出的总结回答。使用Markdown，回答简洁准确。\n\n重要约束：\n- 只依据原文与已给出的总结，不做外延推断；不确定则说明“原文未说明”。\n- 若用户的问题需要定位原文证据，请引用原文短句（≤20字）作为依据。' },
                { role: 'user', content: this.apiClient.generatePrompt(originalContent, type) },
                { role: 'assistant', content: initialSummary }
            ];

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
                    () => {
                        aiMsgEl.classList.remove('streaming');
                        aiMsgEl.innerHTML = MarkdownParser.parse(aiAccumulated);
                        conversationHistory.push({ role: 'assistant', content: aiAccumulated });
                        chatInput.disabled = false;
                        sendBtn.disabled = false;
                        chatInput.focus();
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    },
                    error => {
                        aiMsgEl.classList.remove('streaming');
                        aiMsgEl.innerHTML = `<div class="zhihu-ai-inline-error">${error.message}</div>`;
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
            button.title = '配置 OpenAI API Key';
            button.addEventListener('click', () => this.showConfigModal());
            document.body.appendChild(button);
        }

        async showConfigModal() {
            const accounts = await storage.get('AI_ACCOUNTS', []);
            const currentAccountId = await storage.get('CURRENT_ACCOUNT_ID', '');
            const autoSummarize = await storage.get('AUTO_SUMMARIZE', false);
            const minAnswerLength = await storage.get('MIN_ANSWER_LENGTH', 200);

            const modal = document.createElement('div');
            modal.className = 'zhihu-ai-modal';
            modal.innerHTML = `
                <div class="zhihu-ai-modal-content">
                    <div class="zhihu-ai-modal-header">
                        <div class="zhihu-ai-modal-title">
                            <svg width="24" height="24" viewBox="0 0 1024 1024" fill="#667eea"><path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64z m0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/><path d="M464 336a48 48 0 1 0 96 0 48 48 0 1 0-96 0z m72 112h-48c-4.4 0-8 3.6-8 8v272c0 4.4 3.6 8 8 8h48c4.4 0 8-3.6 8-8V456c0-4.4-3.6-8-8-8z"/></svg>
                            配置 OpenAI API（浏览器插件版）
                        </div>
                        <button class="zhihu-ai-modal-close">×</button>
                    </div>
                    <div class="zhihu-ai-modal-body">
                        <div class="zhihu-ai-tabs">
                            <div class="zhihu-ai-tab active" data-tab="accounts">账号管理</div>
                            <div class="zhihu-ai-tab" data-tab="settings">基础设置</div>
                        </div>
                        <div class="zhihu-ai-tab-content active" id="accounts-tab">
                            <div class="zhihu-ai-account-list" id="account-list"></div>
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
                                    <input type="number" class="zhihu-ai-config-input" id="zhihu-ai-min-answer-length" value="${minAnswerLength}" min="0" placeholder="200" style="width: 100%;">
                                    <div style="margin-top: 6px; font-size: 12px; color: #666;">回答字数少于此值时,不自动总结,仅显示提示信息(手动点击仍可总结)</div>
                                </div>
                                <div class="zhihu-ai-config-item">
                                    <button class="zhihu-ai-config-save" id="save-settings-btn">保存设置</button>
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

                accountList.innerHTML = currentAccounts.map(account => `
                    <div class="zhihu-ai-account-item ${account.id === currentId ? 'active' : ''}" data-id="${account.id}">
                        <div class="zhihu-ai-account-info">
                            <div class="zhihu-ai-account-name">${account.name}</div>
                            <div class="zhihu-ai-account-detail">${account.model} • ${account.apiUrl.length > 40 ? account.apiUrl.substring(0, 40) + '...' : account.apiUrl}</div>
                        </div>
                        <div class="zhihu-ai-account-actions">
                            <button class="zhihu-ai-account-btn zhihu-ai-account-btn-edit" data-id="${account.id}">编辑</button>
                            <button class="zhihu-ai-account-btn zhihu-ai-account-btn-delete" data-id="${account.id}">删除</button>
                        </div>
                    </div>
                `).join('');

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

            const showAccountForm = async (editId = null) => {
                const accounts = await storage.get('AI_ACCOUNTS', []);
                const editAccount = editId ? accounts.find(acc => acc.id === editId) : null;

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
                                    <input type="text" class="zhihu-ai-config-input" id="account-name" value="${editAccount?.name || ''}" placeholder="默认使用API地址">
                                </div>
                                <div class="zhihu-ai-config-item">
                                    <label class="zhihu-ai-config-label">API接口地址:</label>
                                    <input type="text" class="zhihu-ai-config-input" id="account-url" value="${editAccount?.apiUrl || ''}" placeholder="https://api.openai.com/v1/chat/completions">
                                </div>
                                <div class="zhihu-ai-config-item">
                                    <label class="zhihu-ai-config-label">API Key:</label>
                                    <input type="password" class="zhihu-ai-config-input" id="account-key" value="${editAccount?.apiKey || ''}" placeholder="sk-...">
                                </div>
                                <div class="zhihu-ai-config-item">
                                    <label class="zhihu-ai-config-label">模型名称:</label>
                                    <input type="text" class="zhihu-ai-config-input" id="account-model" value="${editAccount?.model || ''}" placeholder="gpt-4o-mini">
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
                        resultContainer.innerHTML = `<div class="zhihu-ai-test-result success">✓ ${result.message}</div>`;
                    } else {
                        resultContainer.innerHTML = `<div class="zhihu-ai-test-result error">✗ ${result.message}</div>`;
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
                                model: model
                            };
                        }
                    } else {
                        const newAccount = {
                            id: Date.now().toString(),
                            name: name || url,
                            apiUrl: url,
                            apiKey: key,
                            model: model
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

            modal.querySelector('#add-account-btn').addEventListener('click', () => showAccountForm());

            modal.querySelector('#save-settings-btn').addEventListener('click', async () => {
                const autoSum = modal.querySelector('#zhihu-ai-auto-summarize').checked;
                const minLength = parseInt(modal.querySelector('#zhihu-ai-min-answer-length').value) || 200;
                await storage.set('AUTO_SUMMARIZE', autoSum);
                await storage.set('MIN_ANSWER_LENGTH', minLength);
                alert('设置已保存！');
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
                                content: contentText
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
