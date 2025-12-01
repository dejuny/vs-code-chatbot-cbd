(() => {
    const vscode = acquireVsCodeApi();

    const MESSAGE_TYPES = Object.freeze({
        SEND_MESSAGE: 'sendMessage',
        GET_WORKSPACE_FILES: 'getWorkspaceFiles',
        GET_CURRENT_FILE: 'getCurrentFile',
        OPEN_FILE: 'openFile',
        SAVE_CHAT_HISTORY: 'saveChatHistory',
        REQUEST_CHAT_HISTORY: 'requestChatHistory',
        AI_RESPONSE: 'aiResponse',
        WORKSPACE_FILES: 'workspaceFiles',
        CURRENT_FILE: 'currentFile',
        LOAD_CHAT_HISTORY: 'loadChatHistory',
        INITIAL_MESSAGE: 'initialMessage',
    });

    const SAVE_DELAY_MS = 100;
    const WEBVIEW_REQUEST_DELAY_MS = 200;

    const statusState = {
        workspaceFiles: 0,
        currentFile: 'No file selected',
    };

    const htmlEscapes = Object.freeze({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
    });

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, (ch) => htmlEscapes[ch] || ch);
    }

    function escapeAttr(str) {
        return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /**
     * Minimal Markdown to HTML renderer with file-link awareness.
     * Covers headings, bold/italic, code fences, inline code, lists, and links.
     * All input is HTML-escaped before formatting to avoid injection.
     */
    function renderMarkdown(text) {
        if (!text) {
            return '';
        }

        let html = escapeHtml(text);

        // Code fences
        html = html.replace(/```([\s\S]*?)```/g, (_match, code) =>
            `<pre><code>${code}</code></pre>`,
        );

        // Headings (h1-h6)
        for (let level = 6; level >= 1; level -= 1) {
            const pattern = new RegExp(`^${'#'.repeat(level)}\\s+(.+)$`, 'gm');
            html = html.replace(pattern, (_m, content) => `<h${level}>${content}</h${level}>`);
        }

        // Bold then italics (avoid double-processing)
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/(^|[^\*])\*(?!\*)(.+?)\*(?!\*)/g, (_m, prefix, content) => `${prefix}<em>${content}</em>`);

        // Inline code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Links: treat path:line as file-link, otherwise external link
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, target) => {
            const fileMatch = target.match(/^([^:()]+):(\d+)$/);
            if (fileMatch) {
                const file = escapeAttr(fileMatch[1]);
                const line = escapeAttr(fileMatch[2]);
                return `<span class="file-link" data-file="${file}" data-line="${line}">${escapeHtml(label)}</span>`;
            }

            const hasProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target);
            const href = escapeAttr(target);
            if (hasProtocol) {
                return `<a href="${href}" target="_blank" rel="noreferrer noopener">${escapeHtml(label)}</a>`;
            }
            return `<span class="file-link" data-file="${href}">${escapeHtml(label)}</span>`;
        });

        // Lists
        html = html.replace(/(^|\n)([-*])\s+([^\n]+)/g, (_m, prefix, _bullet, item) => `${prefix}<li>${item}</li>`);
        html = html.replace(/((?:<li>[\s\S]*?<\/li>\s*)+)/g, '<ul>$1</ul>');

        // Paragraphs: split on double newlines
        html = html.split(/\n{2,}/).map(block => {
            if (block.trim().startsWith('<ul>') || block.trim().startsWith('<pre>') || block.trim().match(/^<h[1-6]>/)) {
                return block;
            }
            return `<p>${block.replace(/\n/g, '<br>')}</p>`;
        }).join('');

        return html;
    }

    function postMessage(type, payload = {}) {
        vscode.postMessage({type, payload});
    }

    function parseLineNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) && num > 0 ? num : undefined;
    }

    function sendMessage() {
        const input = document.getElementById('messageInput');
        if (!input) {
            return;
        }

        const message = input.value.trim();
        if (!message) {
            return;
        }

        addMessage('user', message);
        input.value = '';
        postMessage(MESSAGE_TYPES.SEND_MESSAGE, {text: message});
    }

    function addMessage(type, content) {
        addMessageWithParsing(type, content, true);
    }

    function addMessageWithParsing(type, content, saveHistory = false) {
        const container = document.getElementById('messages');
        if (!container) {
            return;
        }

        const messageDiv = document.createElement('div');
        messageDiv.className = 'message';

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        avatar.textContent = type === 'user' ? '👤' : '🤖';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';

        if (type === 'ai') {
            messageDiv.setAttribute('data-raw-content', content);
            contentDiv.innerHTML = renderMarkdown(content);
            contentDiv.querySelectorAll('.file-link').forEach((el) => {
                const fileAttr = el.getAttribute('data-file') || '';
                const lineAttr = parseLineNumber(el.getAttribute('data-line'));
                el.addEventListener('click', () => openFile(fileAttr, lineAttr));
            });
        } else {
            const textDiv = document.createElement('div');
            textDiv.className = 'message-text';
            textDiv.innerHTML = renderMarkdown(content);
            contentDiv.appendChild(textDiv);
        }

        messageDiv.appendChild(avatar);
        messageDiv.appendChild(contentDiv);
        container.appendChild(messageDiv);
        container.scrollTop = container.scrollHeight;

        if (saveHistory) {
            window.setTimeout(saveChatHistory, SAVE_DELAY_MS);
        }
    }

    function openFile(fileName, lineNumber) {
        postMessage(MESSAGE_TYPES.OPEN_FILE, {fileName, lineNumber});
    }

    function updateStatus(text) {
        const statusText = document.getElementById('statusText');
        if (statusText) {
            statusText.textContent = text;
        }
    }

    function renderStatus() {
        const workspaceLabel = statusState.workspaceFiles > 0
            ? `${statusState.workspaceFiles} files indexed`
            : 'Repository idle';
        const fileLabel = statusState.currentFile ? `Editing ${statusState.currentFile}` : 'No file selected';
        updateStatus(`${workspaceLabel} • ${fileLabel}`);
    }

    function loadChatHistory(messages = []) {
        const container = document.getElementById('messages');
        if (!container || messages.length === 0) {
            return;
        }

        const initialMessage = container.querySelector('.message');
        container.innerHTML = '';
        if (initialMessage) {
            container.appendChild(initialMessage);
        }

        messages.forEach((msg) => addMessageWithParsing(msg.type, msg.content));
    }

    function collectMessagesForSave() {
        const container = document.getElementById('messages');
        if (!container) {
            return [];
        }

        const messages = [];
        container.querySelectorAll('.message').forEach((element, index) => {
            if (index === 0) {
                return;
            }

            const avatar = element.querySelector('.message-avatar');
            if (!avatar) {
                return;
            }

            const type = avatar.textContent === '👤' ? 'user' : 'ai';
            if (type === 'user') {
                const content = element.querySelector('.message-text');
                if (content) {
                    messages.push({type, content: content.textContent || content.innerHTML || ''});
                }
            } else {
                const rawContent = element.getAttribute('data-raw-content');
                if (rawContent) {
                    messages.push({type, content: rawContent});
                }
            }
        });

        return messages;
    }

    function saveChatHistory() {
        const messages = collectMessagesForSave();
        if (messages.length === 0) {
            return;
        }

        postMessage(MESSAGE_TYPES.SAVE_CHAT_HISTORY, {messages});
    }

    function clearChat() {
        const container = document.getElementById('messages');
        if (!container) {
            return;
        }

        const initialMessage = container.querySelector('.message');
        container.innerHTML = '';
        if (initialMessage) {
            container.appendChild(initialMessage);
        }

        saveChatHistory();
    }

    function exportChat() {
        const container = document.getElementById('messages');
        if (!container) {
            return;
        }

        const lines = [];
        container.querySelectorAll('.message').forEach((element, index) => {
            if (index === 0) {
                return;
            }
            const avatar = element.querySelector('.message-avatar');
            const content = element.querySelector('.message-text, .line-content');
            if (avatar && content) {
                const label = avatar.textContent === '👤' ? 'User' : 'AI';
                lines.push(`${label}: ${content.textContent}`);
            }
        });

        const blob = new Blob([lines.join('\n\n')], {type: 'text/plain'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'chat-history.txt';
        a.click();
        URL.revokeObjectURL(url);
    }

    function handleIncomingMessage(event) {
        const message = event.data;
        switch (message.type) {
            case MESSAGE_TYPES.AI_RESPONSE:
                addMessage('ai', message.payload?.response ?? '');
                break;
            case MESSAGE_TYPES.WORKSPACE_FILES:
                statusState.workspaceFiles = message.payload?.files?.length ?? 0;
                renderStatus();
                break;
            case MESSAGE_TYPES.CURRENT_FILE:
                statusState.currentFile = message.payload?.file || 'No file selected';
                renderStatus();
                break;
            case MESSAGE_TYPES.LOAD_CHAT_HISTORY:
                loadChatHistory(message.payload?.messages ?? []);
                break;
            case MESSAGE_TYPES.INITIAL_MESSAGE: {
                const input = document.getElementById('messageInput');
                if (input && message.payload?.message) {
                    input.value = message.payload.message;
                }
                break;
            }
            default:
                break;
        }
    }

    function attachEventHandlers() {
        const input = document.getElementById('messageInput');
        if (input) {
            input.addEventListener('keypress', (event) => {
                if (event.key === 'Enter') {
                    sendMessage();
                }
            });
        }

        const sendButton = document.getElementById('sendButton');
        if (sendButton) {
            sendButton.addEventListener('click', sendMessage);
        }

        document.addEventListener('click', (event) => {
            const target = event.target;
            if (target instanceof HTMLElement && target.classList.contains('file-link')) {
                const fileName = target.getAttribute('data-file') || '';
                const line = parseLineNumber(target.getAttribute('data-line'));
                openFile(fileName, line);
            }
        });
    }

    function requestWorkspaceContext() {
        postMessage(MESSAGE_TYPES.GET_WORKSPACE_FILES, {});
        postMessage(MESSAGE_TYPES.GET_CURRENT_FILE, {});
        window.setTimeout(() => postMessage(MESSAGE_TYPES.REQUEST_CHAT_HISTORY, {}), WEBVIEW_REQUEST_DELAY_MS);
    }

    function bootstrapFallbackUI() {
        if (!document.getElementById('messages')) {
            return;
        }

        attachEventHandlers();
        requestWorkspaceContext();
        renderStatus();
    }

    window.addEventListener('message', handleIncomingMessage);

    window.clearChat = clearChat;
    window.exportChat = exportChat;

    window.setInitialMessage = (message) => {
        const input = document.getElementById('messageInput');
        if (input) {
            input.value = message;
        }
    };

    window.addAIResponse = (response) => {
        addMessage('ai', response);
    };

    window.setWorkspaceFiles = (files) => {
        if (Array.isArray(files)) {
            statusState.workspaceFiles = files.length;
            renderStatus();
        }
    };

    window.setCurrentFile = (file) => {
        statusState.currentFile = file || 'No file selected';
        renderStatus();
    };

    bootstrapFallbackUI();
})();
