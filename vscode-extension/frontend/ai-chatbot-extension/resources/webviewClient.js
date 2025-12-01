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

    function postMessage(type, payload = {}) {
        vscode.postMessage({type, payload});
    }

    function parseLineNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) && num > 0 ? num : undefined;
    }

    function escapeHtml(value) {
        return (value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeAttribute(value) {
        return escapeHtml(value).replace(/`/g, '&#96;');
    }

    function sanitizeHref(href) {
        const trimmed = (href || '').trim();
        if (!trimmed) {
            return '#';
        }
        const lower = trimmed.toLowerCase();
        if (lower.startsWith('javascript:') || lower.startsWith('data:')) {
            return '#';
        }
        return escapeAttribute(trimmed);
    }

    function renderInlineMarkdown(text) {
        const linkTokens = [];
        let linkIndex = 0;

        const withPlaceholders = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
            const token = `__MD_LINK_${linkIndex}__`;
            linkTokens.push({token, label, href});
            linkIndex += 1;
            return token;
        });

        let html = escapeHtml(withPlaceholders);

        html = html.replace(/`([^`]+)`/g, (_match, code) => `<code>${code}</code>`);
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
        html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');

        linkTokens.forEach(({token, label, href}) => {
            const safeHref = sanitizeHref(href);
            const safeLabel = escapeHtml(label);
            const anchorHtml = `<a href="${safeHref}">${safeLabel}</a>`;
            html = html.replace(token, anchorHtml);
        });

        return html;
    }

    function markdownToHtml(markdown) {
        const lines = (markdown || '').replace(/\r\n?/g, '\n').split('\n');
        const html = [];
        let inCodeBlock = false;
        let codeLang = '';
        let codeLines = [];
        let listType = '';
        const paragraphLines = [];

        const closeList = () => {
            if (listType) {
                html.push(`</${listType}>`);
                listType = '';
            }
        };

        const flushParagraph = () => {
            if (paragraphLines.length > 0) {
                html.push(`<p>${renderInlineMarkdown(paragraphLines.join(' '))}</p>`);
                paragraphLines.length = 0;
            }
        };

        const closeCodeBlock = () => {
            if (inCodeBlock) {
                const languageClass = codeLang ? ` class="language-${escapeAttribute(codeLang)}"` : '';
                html.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
                inCodeBlock = false;
                codeLang = '';
                codeLines = [];
            }
        };

        lines.forEach((line) => {
            const fenceMatch = line.match(/^```(\w+)?\s*$/);
            if (fenceMatch) {
                if (inCodeBlock) {
                    closeCodeBlock();
                } else {
                    flushParagraph();
                    closeList();
                    inCodeBlock = true;
                    codeLang = fenceMatch[1] || '';
                }
                return;
            }

            if (inCodeBlock) {
                codeLines.push(line);
                return;
            }

            if (!line.trim()) {
                flushParagraph();
                closeList();
                return;
            }

            const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
            if (headingMatch) {
                flushParagraph();
                closeList();
                const level = headingMatch[1].length;
                html.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
                return;
            }

            if (/^[-*_]{3,}\s*$/.test(line)) {
                flushParagraph();
                closeList();
                html.push('<hr />');
                return;
            }

            const quoteMatch = line.match(/^>\s?(.*)$/);
            if (quoteMatch) {
                flushParagraph();
                closeList();
                html.push(`<blockquote>${renderInlineMarkdown(quoteMatch[1])}</blockquote>`);
                return;
            }

            const orderedListMatch = line.match(/^\s*\d+\.\s+(.*)$/);
            if (orderedListMatch) {
                flushParagraph();
                if (listType !== 'ol') {
                    closeList();
                    listType = 'ol';
                    html.push('<ol>');
                }
                html.push(`<li>${renderInlineMarkdown(orderedListMatch[1])}</li>`);
                return;
            }

            const unorderedListMatch = line.match(/^\s*[-*+]\s+(.*)$/);
            if (unorderedListMatch) {
                flushParagraph();
                if (listType !== 'ul') {
                    closeList();
                    listType = 'ul';
                    html.push('<ul>');
                }
                html.push(`<li>${renderInlineMarkdown(unorderedListMatch[1])}</li>`);
                return;
            }

            if (listType) {
                closeList();
            }

            paragraphLines.push(line.trim());
        });

        closeCodeBlock();
        flushParagraph();
        closeList();

        return html.join('\n');
    }

    function renderMarkdownWithFileLinks(markdown) {
        const fragment = document.createDocumentFragment();
        const wrapper = document.createElement('div');
        wrapper.className = 'message-text markdown-body';
        wrapper.innerHTML = markdownToHtml(markdown);

        const citations = new Map();
        const anchorPattern = /^([^#:]+)(?::(\d+))?(?:#L(\d+))?$/;

        wrapper.querySelectorAll('a').forEach((anchor) => {
            const href = anchor.getAttribute('href') || '';
            const match = href.match(anchorPattern);
            if (!match) {
                return;
            }

            const fileName = match[1];
            const lineNumber = parseLineNumber(match[2] || match[3]);

            anchor.classList.add('file-link');
            anchor.href = '#';
            anchor.addEventListener('click', (event) => {
                event.preventDefault();
                openFile(fileName, lineNumber);
            });

            if (lineNumber) {
                citations.set(`${fileName}:${lineNumber}`, {fileName, lineNumber});
            } else {
                citations.set(fileName, {fileName, lineNumber: undefined});
            }
        });

        fragment.appendChild(wrapper);

        if (citations.size > 0) {
            const citationsDiv = document.createElement('div');
            citationsDiv.className = 'line-citations';

            citations.forEach(({fileName, lineNumber}) => {
                const citationBtn = document.createElement('button');
                citationBtn.className = 'file-reference';
                citationBtn.textContent = lineNumber ? `📄 ${fileName}:${lineNumber}` : `📄 ${fileName}`;
                citationBtn.addEventListener('click', () => openFile(fileName, lineNumber));
                citationsDiv.appendChild(citationBtn);
            });

            fragment.appendChild(citationsDiv);
        }

        return fragment;
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
            contentDiv.appendChild(renderMarkdownWithFileLinks(content));
        } else {
            contentDiv.appendChild(renderMarkdownWithFileLinks(content));
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
