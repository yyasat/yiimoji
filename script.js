        // 使用 IndexedDB 实现无限制存储
        const db = {
            name: 'StudioAI_DB',
            store: 'chat_sessions',
            async init() {
                // 关键修复：向浏览器申请「持久化存储」权限。
                // 不申请的话，浏览器（尤其 iOS Safari / 手机浏览器 / 隐私模式）
                // 会在长时间不访问后，把 IndexedDB 当成临时数据自动清空，导致历史记录丢失。
                try {
                    if (navigator.storage && navigator.storage.persist) {
                        const already = await navigator.storage.persisted();
                        if (!already) {
                            const granted = await navigator.storage.persist();
                            console.log('持久化存储申请结果:', granted);
                        }
                    }
                } catch (e) {
                    console.warn('持久化存储申请失败（不影响使用）:', e);
                }
                return new Promise((resolve, reject) => {
                    const request = indexedDB.open(this.name, 1);
                    request.onupgradeneeded = (e) => e.target.result.createObjectStore(this.store);
                    request.onsuccess = (e) => { this.instance = e.target.result; resolve(); };
                    request.onerror = (e) => { console.error('数据库打开失败:', e); reject(e); };
                });
            },
            async save(data) {
                // 改为等事务真正完成再返回，避免页面关闭过快导致数据没写进去
                return new Promise((resolve, reject) => {
                    try {
                        const tx = this.instance.transaction(this.store, 'readwrite');
                        tx.objectStore(this.store).put(JSON.parse(JSON.stringify(data)), 'all_history');
                        tx.oncomplete = () => resolve();
                        tx.onerror = (e) => { console.error('数据保存失败:', e); reject(e); };
                    } catch (e) {
                        console.error('数据保存异常:', e);
                        reject(e);
                    }
                });
            },
            async load() {
                return new Promise((resolve) => {
                    const tx = this.instance.transaction(this.store, 'readonly');
                    const request = tx.objectStore(this.store).get('all_history');
                    request.onsuccess = () => resolve(request.result || []);
                    request.onerror = () => resolve([]);
                });
            }
        };

        // 修复配置未读取的 Bug，每次加载优先从缓存中拿取
        let config = JSON.parse(localStorage.getItem('studio_v15_config')) || { url: '', key: '', model: '' };
        let sessions = [];
        let currentSessionId = null;
        let allModels = JSON.parse(localStorage.getItem('studio_all_models')) || [];
        let isGenerating = false;
        let currentAbortController = null;
        let pendingAttachments = [];

        const DEFAULT_SYSTEM_PROMPT = '请始终使用中文回复用户。无论用户使用什么语言提问，你的回答都应该使用简体中文，除非用户明确要求使用其他语言。代码、专有名词、技术术语可以保留英文原文。\n\n当需要修改用户上传的代码文件（如 .js / .css / .html 等）时，必须使用以下 XML 格式输出修改内容，而不是直接输出完整文件：\n<ai_edit_file filename="文件名">\n<search>\n需要被替换的原始代码（必须与原文件逐字逐空格完全一致，包括缩进和换行）\n</search>\n<replace>\n替换后的新代码\n</replace>\n</ai_edit_file>\n如需多处修改，依次输出多个此标签。只有在用户明确要求输出完整文件时，才直接输出整个文件。';

        // 文件内容存储：{ 文件名 → 内容 }，用于验证 ai_edit_file 的搜索匹配
        window.fileStore = window.fileStore || {};

        // 代码渲染器
        const renderer = new marked.Renderer();
        renderer.code = function(token) {
            let code, lang;
            
            // 兼容 marked 不同版本的 token 结构
            if (typeof token === 'object' && token !== null) {
                // marked v5+ 传入的是 token 对象
                code = token.text != null ? token.text : (token.raw || '');
                lang = token.lang || '';
                
                // 如果 code 还包含 ``` 标记，说明取到了 raw，需要手动提取
                if (code.startsWith('```')) {
                    const lines = code.split('\n');
                    lines.shift(); // 移除第一行 ```lang
                    if (lines.length > 0 && lines[lines.length - 1].trim() === '```') {
                        lines.pop(); // 移除最后一行 ```
                    }
                    code = lines.join('\n');
                }
            } else {
                // marked 旧版本：参数是 (code, lang, escaped)
                code = token || '';
                lang = arguments[1] || '';
            }
            
            // 【核心修复】：直接保留 AI 输出的真实文本（包括合法的 &amp; 等），彻底删除容易引起误杀的 unescapeHtml 逻辑
            let rawCode = code;
            
            const id = 'code-' + Math.random().toString(36).substr(2, 9);
            
            window.rawCodeBlocks = window.rawCodeBlocks || {};
            window.rawCodeBlocks[id] = rawCode;
            
            let highlightedCode;
            if (lang && hljs.getLanguage(lang)) {
                try {
                    highlightedCode = hljs.highlight(rawCode, { language: lang }).value;
                } catch (e) {
                    highlightedCode = rawCode.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                }
            } else {
                highlightedCode = rawCode.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            }

            if (lang && lang.toLowerCase() === 'html') {
                const docTitle = extractHtmlTitle(rawCode);
                return `<div class="artifact-card" data-code-id="${id}" onclick="previewHtmlArtifact('${id}')">
                    <div class="artifact-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><circle cx="6.5" cy="6.5" r="0.6" fill="currentColor" stroke="none"/><circle cx="9" cy="6.5" r="0.6" fill="currentColor" stroke="none"/><circle cx="11.5" cy="6.5" r="0.6" fill="currentColor" stroke="none"/></svg></div>
                    <div class="artifact-info">
                        <div class="artifact-title">${docTitle}</div>
                        <div class="artifact-meta">代码 · HTML</div>
                    </div>
                    <button onclick="downloadHtmlArtifact('${id}', event)" class="artifact-dl">下载</button>
                </div>`;
            }

            return `<div class="code-card"><div class="code-header"><span>${lang || '代码'}</span><button onclick="copyCode('${id}')">复制</button></div><div class="code-body"><div id="${id}" class="code-content"><pre><code class="hljs ${lang}">${highlightedCode}</code></pre></div><div class="code-mask"></div></div><div class="code-toggle" onclick="toggleCode(this)">展开 ∨</div></div>`;
        };
        // 预处理函数：将 AI 输出的 XML 标签格式代码转换为标准 markdown 代码块
        function preprocessMarkdown(text) {
            if (!text) return text;

            // 解析 <ai_edit_file> 标签，渲染为可操作的修改卡片
            text = text.replace(/<ai_edit_file\s+filename="([^"]*)"[^>]*>([\s\S]*?)<\/ai_edit_file>/gi, function(match, filename, body) {
                const searchMatch = body.match(/<search>\n?([\s\S]*?)\n?<\/search>/i);
                const replaceMatch = body.match(/<replace>\n?([\s\S]*?)\n?<\/replace>/i);
                if (!searchMatch || !replaceMatch) return '';
                const searchText = searchMatch[1];
                const replaceText = replaceMatch[1];
                const id = 'edit-' + Math.random().toString(36).substr(2, 9);
                window.editCards = window.editCards || {};
                window.editCards[id] = { filename, search: searchText, replace: replaceText };
                const lineCount = searchText.split('\n').length;
                const safeFilename = filename.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                return `\n<div class="edit-card" id="${id}"><div class="edit-card-header"><div class="edit-card-icon">✏️</div><div class="edit-card-info"><div class="edit-card-title">${safeFilename}</div><div class="edit-card-meta">代码修改 · ${lineCount} 行</div></div><span class="edit-card-status" id="${id}-status"></span></div><div class="edit-card-actions" id="${id}-actions"><button class="edit-apply-btn" onclick="applyEdit('${id}')">应用修改</button></div></div>\n`;
            });

            // 匹配 <file_write file="xxx.html" ...>...</file_write> 格式
            text = text.replace(/<file_write\s+file="([^"]*\.html)"[^>]*>([\s\S]*?)<\/file_write>/gi, function(match, filename, code) {
                window.fileStore[filename] = code.trim();
                return '\n```html\n' + code.trim() + '\n```\n';
            });
            // 匹配其他扩展名的 file_write
            text = text.replace(/<file_write\s+file="([^"]*\.(\w+))"[^>]*>([\s\S]*?)<\/file_write>/gi, function(match, filename, ext, code) {
                const langMap = { js: 'javascript', ts: 'typescript', py: 'python', css: 'css', json: 'json', md: 'markdown', java: 'java', cpp: 'cpp', c: 'c', go: 'go', rs: 'rust', rb: 'ruby', sh: 'bash', xml: 'xml', sql: 'sql' };
                const lang = langMap[ext] || ext;
                window.fileStore[filename] = code.trim();
                return '\n```' + lang + '\n' + code.trim() + '\n```\n';
            });
            // 匹配未闭合的 <file_write ...> 标签（流式过程中还没收到 </file_write>）
            // 不做替换，留给 detectStreamingHtmlBlock 逻辑处理
            return text;
        }

        marked.use({ 
            renderer,
            breaks: true,
            gfm: true
        });

        // 智能提取 HTML 卡片标题：title 标签 > h1 标签 > 当前对话标题 > 新文档
        function extractHtmlTitle(code) {
            if (!code) return '新文档';
            const titleMatch = code.match(/<title[^>]*>(.*?)<\/title>/i);
            if (titleMatch && titleMatch[1].trim()) return titleMatch[1].trim();
            const h1Match = code.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
            if (h1Match) {
                const t = h1Match[1].replace(/<[^>]+>/g, '').trim();
                if (t) return t;
            }
            const session = sessions.find(s => s.id === currentSessionId);
            if (session && session.title && session.title !== '新对话') return session.title;
            return '新文档';
        }

        function copyCode(id) {
            const text = (window.rawCodeBlocks && window.rawCodeBlocks[id]) ? window.rawCodeBlocks[id] : document.getElementById(id).innerText;
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text)
                    .then(() => alert("已复制"))
                    .catch(() => fallbackCopy(text));
            } else {
                fallbackCopy(text);
            }
        }

        function fallbackCopy(text) {
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed"; 
            textArea.style.opacity = "0";      
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            try {
                document.execCommand('copy');
                alert("已复制");
            } catch (err) {
                alert("复制失败，请手动选择复制");
            }
            document.body.removeChild(textArea);
        }

        window.onload = async () => {
            await db.init();
            sessions = await db.load();
            if (!config.key || !config.model) showSetup();
            else startApp();
        };

        function startApp() {
            document.getElementById('setup-layer').classList.add('hidden');
            document.getElementById('active-model-display').innerHTML = `${config.model} <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"></path></svg>`;
            if (sessions.length > 0) loadSession(sessions[0].id);
            else createNewChat();
            renderQuickModelList(allModels);
        }

        // --- 附件核心交互逻辑 ---
        function toggleAttachMenu() {
            document.getElementById('attach-menu').classList.toggle('show');
        }

        function triggerFile(accept) {
            const input = document.getElementById('hidden-file-input');
            input.accept = accept;
            input.click();
            document.getElementById('attach-menu').classList.remove('show');
        }

        function processFile(input) {
            const files = Array.from(input.files);
            if (files.length === 0) return;

            files.forEach(file => {
                const reader = new FileReader();
                if (file.type.startsWith('image/')) {
                    reader.onload = (e) => {
                        pendingAttachments.push({ type: 'image', name: file.name, data: e.target.result });
                        renderAttachments();
                    };
                    reader.readAsDataURL(file);
                } else {
                    reader.onload = (e) => {
                        pendingAttachments.push({ type: 'file', name: file.name, data: e.target.result });
                        renderAttachments();
                    };
                    reader.readAsText(file);
                }
            });
            input.value = ''; 
        }

        function handlePaste(event) {
            const clipboardData = event.clipboardData || window.clipboardData;
            const pastedText = clipboardData.getData('text');
            
            const isLongText = pastedText.length > 800;
            const isCode = /[\{\}\[\];]/.test(pastedText) && (pastedText.includes('function') || pastedText.includes('var ') || pastedText.includes('const ') || pastedText.includes('import ') || pastedText.includes('def ') || pastedText.includes('<div'));

            if (isLongText || isCode) {
                event.preventDefault();
                let firstLine = pastedText.trim().split('\n')[0].substring(0, 30);
                const fileName = isCode ? `代码片段: ${firstLine}...` : `长文本: ${firstLine}...`;
                pendingAttachments.push({ type: 'file', name: fileName, data: pastedText });
                renderAttachments();
            }
        }

        function renderAttachments() {
            const container = document.getElementById('attachment-preview');
            if (pendingAttachments.length === 0) {
                container.innerHTML = '';
                return;
            }
            container.innerHTML = pendingAttachments.map((at, i) => `
                <div class="file-card-preview" onclick="previewAttachment(${i})">
                    <div class="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center text-base flex-shrink-0 border border-gray-100">
                        ${at.type === 'image' ? '🖼️' : '📄'}
                    </div>
                    <div class="flex-1 min-w-0 pr-4">
                        <div class="text-[11px] font-medium text-gray-700 truncate">${at.name}</div>
                        <div class="text-[9px] text-gray-400 uppercase tracking-wider mt-0.5">${at.type === 'image' ? '图片素材' : '文档/代码'}</div>
                    </div>
                    <button onclick="removeAttachment(${i}, event)" class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-red-500 transition-colors p-1">
                        ✕
                    </button>
                </div>
            `).join('');
            container.scrollLeft = container.scrollWidth;
        }

        function removeAttachment(i, event) {
            if (event) event.stopPropagation();
            pendingAttachments.splice(i, 1);
            renderAttachments();
        }

        function previewAttachment(i) {
            const at = pendingAttachments[i];
            if (!at) return;
            // 图片走图集预览，可左右切换
            if (at.type === 'image') {
                const imgs = pendingAttachments.filter(a => a.type === 'image').map(a => a.data);
                const startIdx = imgs.indexOf(at.data);
                openImagePreview(imgs, startIdx >= 0 ? startIdx : 0);
                return;
            }
            document.getElementById('modal-file-icon').innerText = '📄';
            document.getElementById('modal-file-name').innerText = at.name;
            const body = document.getElementById('modal-file-body');
            
            // 使用 DOM TextContent 替代手动正则表达式，彻底规避特殊字符导致的转义崩溃问题
            const pre = document.createElement('pre');
            pre.className = "font-mono text-xs bg-[#f9f9f7] text-gray-800 p-4 rounded-xl overflow-x-auto whitespace-pre-wrap break-all border border-gray-100";
            const code = document.createElement('code');
            code.textContent = at.data; // 直接设置 textContent，浏览器会自动处理所有转义，极其安全
            pre.appendChild(code);
            
            body.innerHTML = '';
            body.appendChild(pre);
            document.getElementById('file-preview-modal').classList.remove('hidden');
        }

        // --- 图片图集预览（支持左右切换）---
        window._imageGallery = { images: [], index: 0 };

        function openImagePreview(images, startIndex) {
            if (!images || images.length === 0) return;
            window._imageGallery = { images: images, index: startIndex || 0 };
            document.getElementById('modal-file-icon').innerText = '🖼️';
            renderImageGallery();
            document.getElementById('file-preview-modal').classList.remove('hidden');
        }

        function renderImageGallery() {
            const g = window._imageGallery;
            const body = document.getElementById('modal-file-body');
            const multi = g.images.length > 1;
            document.getElementById('modal-file-name').innerText = multi ? `图片预览 ${g.index + 1}/${g.images.length}` : '图片预览';
            const navBtn = (dir, pos, path) => `
                <button onclick="navImage(${dir}, event)" class="absolute ${pos} top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/90 border border-gray-200 shadow-md flex items-center justify-center text-gray-600 hover:bg-white hover:text-black transition-all z-10 active:scale-90">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>
                </button>`;
            body.innerHTML = `
                <div class="relative flex justify-center items-center min-h-[200px]">
                    ${multi ? navBtn(-1, 'left-1', 'm15 18-6-6 6-6') : ''}
                    <img src="${g.images[g.index]}" class="max-w-full max-h-[60vh] rounded-xl border border-gray-100 shadow-sm" />
                    ${multi ? navBtn(1, 'right-1', 'm9 18 6-6-6-6') : ''}
                </div>
                ${multi ? `<div class="text-center text-[11px] text-gray-400 mt-3 font-mono tracking-widest">${g.index + 1} / ${g.images.length}</div>` : ''}
            `;
        }

        function navImage(dir, event) {
            if (event) event.stopPropagation();
            const g = window._imageGallery;
            if (!g.images.length) return;
            let n = g.index + dir;
            if (n < 0) n = g.images.length - 1;
            if (n >= g.images.length) n = 0;
            g.index = n;
            renderImageGallery();
        }

        function closeFilePreview() {
            document.getElementById('file-preview-modal').classList.add('hidden');
        }

        document.addEventListener('keydown', (e) => {
            const modal = document.getElementById('file-preview-modal');
            if (modal.classList.contains('hidden')) return;
            if (!window._imageGallery || window._imageGallery.images.length < 2) return;
            if (e.key === 'ArrowLeft') navImage(-1);
            else if (e.key === 'ArrowRight') navImage(1);
        });

        function escapeHtml(str) {
            var div = document.createElement('div');
            div.appendChild(document.createTextNode(str));
            return div.innerHTML;
        }

        function previewMsgFile(name, data) {
            document.getElementById('modal-file-icon').innerText = '📄';
            document.getElementById('modal-file-name').innerText = name;
            var safeContent = escapeHtml(data);
            document.getElementById('modal-file-body').innerHTML = `
                <div class="flex justify-end mb-2">
                    <button onclick="copyFilePreviewContent()" id="file-preview-copy-btn" class="px-3 py-1.5 rounded-lg text-[11px] text-gray-500 hover:bg-gray-100 border border-gray-200 flex items-center gap-1 transition-colors">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        复制代码
                    </button>
                </div>
                <pre class="font-mono text-xs bg-[#f9f9f7] text-gray-800 p-4 rounded-xl overflow-x-auto whitespace-pre-wrap break-all border border-gray-100"><code>${safeContent}</code></pre>`;
            window._filePreviewRawData = data;
            document.getElementById('file-preview-modal').classList.remove('hidden');
        }
        
        function copyFilePreviewContent() {
            const text = window._filePreviewRawData;
            if (!text) return;
            const btn = document.getElementById('file-preview-copy-btn');
            const success = () => {
                if (btn) { btn.innerHTML = '已复制 ✓'; btn.classList.add('text-green-600'); }
                setTimeout(() => {
                    if (btn) { btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>复制代码'; btn.classList.remove('text-green-600'); }
                }, 1500);
            };
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(success).catch(() => {
                    fallbackCopy(text); success();
                });
            } else {
                fallbackCopy(text); success();
            }
        }

        function getThinkingHTML() {
            return `<div class="thinking-indicator">
                <div class="thinking-dots"><span></span><span></span><span></span></div>
                <span class="thinking-text">正在思考</span>
            </div>`;
        }

        // --- 流式渲染节流器（核心改造：独立 spinner 不被 innerHTML 覆盖）---
        function createStreamRenderer(mdContainer, bubble) {
            let pendingRender = false;
            let currentText = '';
            let artifactIndicator = null;
            let streamArtifactId = 'stream-art-' + Date.now(); // 生成过程中的临时ID

            return {
                update(text) {
                    currentText = text;
                    if (!pendingRender) {
                        pendingRender = true;
                        requestAnimationFrame(() => {
                            mdContainer.innerHTML = marked.parse(preprocessMarkdown(currentText));
                            
                            // 实时同步预览：检测流式生成的 HTML 代码块
                            const match = currentText.match(/```html\s*([\s\S]*?)$/);
                            if (match) {
                                const codeContent = match[1];
                                window.rawCodeBlocks = window.rawCodeBlocks || {};
                                window.rawCodeBlocks[streamArtifactId] = codeContent;
                                
                                // 如果预览窗口已打开且正在预览此生成块，则刷新
                                if (!document.getElementById('html-preview-modal').classList.contains('hidden') && 
                                    window._currentHtmlArtifactId === streamArtifactId) {
                                    updateHtmlPreviewContent(streamArtifactId);
                                }
                            }
                            
                            pendingRender = false;
                            const chatWin = document.getElementById('chat-window');
                            chatWin.scrollTop = chatWin.scrollHeight;
                        });
                    }
                },
                finalize(text) {
                    mdContainer.innerHTML = marked.parse(preprocessMarkdown(text));
                    if (bubble) bubble.classList.remove('streaming');
                }
            };
        }

        // --- 核心流式构建与提交逻辑 ---
        async function handleSend(editIdx = null, shouldRegenerate = true, isContinuation = false) {
            if (isGenerating && editIdx === null && !isContinuation) return;
            const input = document.getElementById('user-input');
            const session = sessions.find(s => s.id === currentSessionId);
            
            let contentText = input.value.trim();
            let attachments = [...pendingAttachments];
            
            if (!isContinuation) {
                pendingAttachments = [];
                renderAttachments();

                if (editIdx !== null) {
                    const msg = session.messages[editIdx];
                    contentText = msg.versions[msg.activeIdx].content;
                    if (shouldRegenerate) {
                        session.messages = session.messages.slice(0, editIdx + 1);
                        loadSession(currentSessionId);
                    } else {
                        loadSession(currentSessionId);
                        saveSessions();
                        return;
                    }
                } else {
                    if (!contentText && attachments.length === 0) return;
                    
                    let finalContent = contentText;
                    attachments.filter(a => a.type === 'file').forEach(a => {
                        // 存入 fileStore，供 ai_edit_file 验证使用
                        window.fileStore[a.name] = a.data;
                        finalContent += `\n\n--- 导入文件: ${a.name} ---\n\`\`\`\n${a.data}\n\`\`\``;
                    });

                    session.messages.push({ 
                        role: 'user', 
                        activeIdx: 0, 
                        versions: [{ 
                            content: finalContent,
                            displayText: contentText,
                            images: attachments.filter(a => a.type === 'image').map(a => a.data),
                            files: attachments.filter(a => a.type === 'file').map(a => ({ name: a.name, data: a.data })),
                            next: [] 
                        }] 
                    });
                    appendUI('user', session.messages[session.messages.length-1], session.messages.length - 1);
                    input.value = ''; input.style.height = 'auto';
                }
            } else {
                input.value = ''; input.style.height = 'auto';
            }

            toggleInputState(true);
            currentAbortController = new AbortController();
            
            let aiBubble;
            let mdContainer;
            let fullText = '';
            let streamRenderer;

            if (isContinuation) {
                mdContainer = window.lastMdContainer;
                aiBubble = window.lastAiBubble;
                fullText = window.lastFullText || '';
                streamRenderer = createStreamRenderer(mdContainer, aiBubble);
                if (aiBubble) aiBubble.classList.add('streaming');
            } else {
                aiBubble = appendUI('assistant', { role: 'assistant', content: '' }, session.messages.length);
                mdContainer = aiBubble.querySelector('.markdown-content');
                mdContainer.innerHTML = getThinkingHTML();
                streamRenderer = createStreamRenderer(mdContainer, aiBubble);
                window.lastMdContainer = mdContainer;
                window.lastAiBubble = aiBubble;
            }

            try {
                const apiMessages = [];
                apiMessages.push({ role: "system", content: DEFAULT_SYSTEM_PROMPT });
                
                session.messages.forEach(m => {
                    const activeVer = m.role === 'user' ? m.versions[m.activeIdx] : null;
                    if (m.role === 'user') {
                        const contentArray = [{ type: "text", text: activeVer.content }];
                        if (activeVer.images && activeVer.images.length > 0) {
                            activeVer.images.forEach(imgData => {
                                contentArray.push({ type: "image_url", image_url: { url: imgData } });
                            });
                        }
                        apiMessages.push({ role: "user", content: contentArray });
                    } else {
                        apiMessages.push({ role: "assistant", content: m.content });
                    }
                });

                if (isContinuation) {
                    apiMessages.push({ role: "user", content: [{ type: "text", text: "你的上条回复因为长度限制被截断了，请务必紧接着刚才断掉的最后一个字继续输出。严格要求：1)不要重复前面的任何内容；2)不要重新开始代码块（不要再写```html或```javascript等开头标记），直接续写代码内容本身；3)不要说任何解释性的话，直接接着写。" }]});
                }

                const res = await fetch(`${config.url.replace(/\/+$/, '')}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${config.key}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        model: config.model, 
                        messages: apiMessages, 
                        stream: true,
                        max_tokens: 8192 
                    }),
                    signal: currentAbortController.signal
                });

                const reader = res.body.getReader();
                const decoder = new TextDecoder('utf-8');
                if (!isContinuation) {
                    mdContainer.innerHTML = getThinkingHTML();
                    aiBubble.classList.add('streaming');
                }
                
                let buffer = '';
                let finishReason = null;
                let firstChunkReceived = false;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); 

                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        if (trimmedLine.startsWith('data: ') && !trimmedLine.includes('[DONE]')) {
                            try {
                                const json = JSON.parse(trimmedLine.slice(6));
                                const deltaContent = json.choices[0].delta.content || '';
                                
                                if (deltaContent && !firstChunkReceived) {
                                    firstChunkReceived = true;
                                    if (!isContinuation) mdContainer.innerHTML = '';
                                }
                                
                                fullText += deltaContent;
                                
                                if (json.choices[0].finish_reason) {
                                    finishReason = json.choices[0].finish_reason;
                                }
                                
                                if (firstChunkReceived) {
                                    streamRenderer.update(fullText);
                                }
                            } catch(e) {
                                console.warn("JSON解析跳过不完整数据块:", trimmedLine);
                            }
                        }
                    }
                }
                
                streamRenderer.finalize(fullText);

                if (isContinuation) {
                    session.messages[session.messages.length - 1].content = fullText;
                } else {
                    session.messages.push({ role: 'assistant', content: fullText });
                }
                
                window.lastFullText = fullText;
                saveSessions();

                if (session.title === '新对话' && session.messages.length >= 2) {
                    autoRenameSession(session.id);
                }

                if (!isContinuation && finishReason !== 'length' && finishReason !== 'max_tokens' && aiBubble) {
                    generateSuggestions(aiBubble, session.messages);
                }

                if (finishReason === 'length' || finishReason === 'max_tokens') {
                    setTimeout(() => {
                        if (confirm("⚠️ AI 的输出达到了单次字数上限。\n\n是否无缝拼接到当前消息尾部继续生成？")) {
                            handleSend(null, true, true); 
                        }
                    }, 400); 
                }

            } catch (e) {
                if (e.name === 'AbortError') {
                    streamRenderer.finalize(fullText);
                    mdContainer.innerHTML += '<span class="text-gray-300 text-[10px] ml-2">(已停止)</span>';
                    if (fullText) { 
                        if (isContinuation) {
                            session.messages[session.messages.length - 1].content = fullText + "...";
                        } else {
                            session.messages.push({ role: 'assistant', content: fullText + "..." }); 
                        }
                        window.lastFullText = fullText;
                        saveSessions(); 
                    }
                } else {
                    if (aiBubble) aiBubble.classList.remove('streaming');
                    mdContainer.innerText = "错误: " + e.message;
                }
            } finally {
                toggleInputState(false);
                currentAbortController = null;
            }
        }

        // --- 其余 UI 框架方法 ---
        function toggleQuickModelPanel() {
            if (isGenerating) return;
            const panel = document.getElementById('quick-model-panel');
            panel.classList.toggle('show');
            if (panel.classList.contains('show')) {
                document.getElementById('quick-model-search').focus();
                renderQuickModelList(allModels);
            }
        }

        function renderQuickModelList(list) {
            const container = document.getElementById('quick-model-list');
            if (list.length === 0) {
                container.innerHTML = `<div class="p-4 text-center text-gray-300 text-xs">暂无模型列表</div>`;
                return;
            }
            container.innerHTML = list.map(m => `
                <div onclick="selectQuickModel('${m}')" class="p-3 hover:bg-gray-50 cursor-pointer text-[11px] rounded-xl transition-colors flex justify-between items-center ${m === config.model ? 'bg-gray-50 font-bold' : ''}">
                    ${m} ${m === config.model ? '●' : ''}
                </div>
            `).join('');
        }

        function selectQuickModel(m) {
            config.model = m;
            localStorage.setItem('studio_v15_config', JSON.stringify(config));
            document.getElementById('active-model-display').innerHTML = `${m} <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"></path></svg>`;
            toggleQuickModelPanel();
        }

        function openSidebar() { document.getElementById('sidebar').classList.add('open'); document.getElementById('sidebar-overlay').classList.add('show'); }
        function closeSidebar() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('sidebar-overlay').classList.remove('show'); }
        // 修复界面逻辑：利用 Tailwind 的 hidden 进行控制
        function showSetup() { document.getElementById('setup-layer').classList.remove('hidden'); }
        async function fetchModels() {
            const url = document.getElementById('base-url').value.trim();
            const key = document.getElementById('api-key').value.trim();
            if (!url || !key) return alert('请填写地址和密钥');
            try {
                const res = await fetch(`${url.replace(/\/+$/, '')}/models`, { headers: { 'Authorization': `Bearer ${key}` } });
                const data = await res.json();
                allModels = data.data.map(m => m.id).sort();
                localStorage.setItem('studio_all_models', JSON.stringify(allModels));
                renderModelList(allModels);
                document.getElementById('model-list').classList.remove('hidden');
            } catch (e) { alert('获取失败'); }
        }
        function renderModelList(list) {
            document.getElementById('model-list').innerHTML = list.map(m => `<div onclick="selectModel('${m}')" class="p-3 hover:bg-gray-50 cursor-pointer text-xs border-b border-gray-50">${m}</div>`).join('');
        }
        function selectModel(m) { config.model = m; document.getElementById('model-search').value = m; document.getElementById('model-list').classList.add('hidden'); }
        function saveConfig() {
            config.url = document.getElementById('base-url').value.trim();
            config.key = document.getElementById('api-key').value.trim();
            localStorage.setItem('studio_v15_config', JSON.stringify(config));
            startApp();
        }
        function createNewChat() {
            const id = Date.now();
            sessions.unshift({ id, title: '新对话', messages: [] });
            currentSessionId = id;
            saveSessions();
            loadSession(id);
        }
        function loadSession(id) {
            currentSessionId = id;
            const session = sessions.find(s => s.id === id);
            const win = document.getElementById('chat-window');
            win.innerHTML = '';
            if (session.messages.length === 0) {
                win.innerHTML = `<div id="empty-state" class="text-center mt-32"><h3 class="serif text-3xl italic text-gray-200">Studio AI</h3></div>`;
            } else {
                session.messages.forEach((m, i) => appendUI(m.role, m, i));
            }
            renderHistoryList();
        }
        
        function appendUI(role, msgObj, idx) {
            document.getElementById('empty-state')?.remove();
            const win = document.getElementById('chat-window');
            const wrap = document.createElement('div');
            wrap.className = `mb-10 flex flex-col ${role === 'user' ? 'items-end' : 'items-start'}`;
            const bubble = document.createElement('div');
            bubble.className = role === 'user' ? 'user-msg text-sm text-gray-700' : 'ai-msg text-sm text-gray-600 w-full md:max-w-[85%]';
            
            const _ver = role === 'user' ? msgObj.versions[msgObj.activeIdx] : null;
            const content = role === 'user'
                ? (_ver.displayText !== undefined ? _ver.displayText : _ver.content.replace(/\n\n---\s*导入文件:[\s\S]*/g, '').trim())
                : msgObj.content;

            if (role === 'user') {
                const files = _ver.files || [];
                const images = _ver.images || [];

                if (files.length > 0 || images.length > 0) {
                    const attachRow = document.createElement('div');
                    attachRow.className = 'flex flex-wrap gap-2 mb-2 justify-end';
                    
                    files.forEach((f, fi) => {
                        const card = document.createElement('div');
                        card.className = 'flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2 shadow-sm cursor-pointer hover:border-gray-400 transition-all';
                        card.innerHTML = `<span class="text-base">📄</span><span class="text-[11px] text-gray-600 max-w-[120px] truncate">${f.name}</span>`;
                        card.onclick = (e) => { e.stopPropagation(); previewMsgFile(f.name, f.data); };
                        attachRow.appendChild(card);
                    });

                    images.forEach((imgData, ii) => {
                        const card = document.createElement('div');
                        card.className = 'w-12 h-12 rounded-xl overflow-hidden border border-gray-200 shadow-sm cursor-pointer hover:border-gray-400 transition-all';
                        card.innerHTML = `<img src="${imgData}" class="w-full h-full object-cover" />`;
                        card.onclick = (e) => {
                            e.stopPropagation();
                            openImagePreview(images, ii);
                        };
                        attachRow.appendChild(card);
                    });

                    wrap.appendChild(attachRow);
                }

                bubble.innerHTML = marked.parse(preprocessMarkdown(content));
                bubble.onclick = () => { if(!isGenerating) editMessage(idx); };

                if (msgObj.versions.length > 1) {
                    const ctrl = document.createElement('div');
                    ctrl.className = 'flex items-center gap-1.5 text-xs text-gray-400 bg-white/60 backdrop-blur-sm rounded-full px-2 py-0.5 w-fit border border-gray-200/60 mt-1.5 shadow-sm select-none transition-all hover:bg-gray-50 hover:text-gray-600 hover:border-gray-300';
                    ctrl.innerHTML = `
                        <button onclick="switchVer(${idx}, -1, event)" class="px-1 hover:text-black transition-colors transform active:scale-90 flex items-center justify-center">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                        </button>
                        <span class="font-mono text-[10px] tracking-[0.1em] font-medium pt-[1px]">${msgObj.activeIdx + 1} / ${msgObj.versions.length}</span>
                        <button onclick="switchVer(${idx}, 1, event)" class="px-1 hover:text-black transition-colors transform active:scale-90 flex items-center justify-center">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                        </button>
                    `;
                    wrap.appendChild(bubble);
                    wrap.appendChild(ctrl);
                } else {
                    wrap.appendChild(bubble);
                }
            } else {
                bubble.innerHTML = `
                    <div class="markdown-content"></div>
                    <div class="flex justify-end mt-2 pt-2 border-t border-gray-100 text-[10px] text-gray-400">
                        <button onclick="regenerateMessage(${idx}, event)" class="hover:text-black flex items-center gap-1 transition-colors">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                            重新回答
                        </button>
                    </div>
                `;

                wrap.appendChild(bubble);
                const mdContainer = bubble.querySelector('.markdown-content');
                mdContainer.innerHTML = marked.parse(preprocessMarkdown(content));
            }
            win.appendChild(wrap);
            win.scrollTop = win.scrollHeight;
            return bubble;
        }

        // --- 快捷建议选项生成 ---
        async function generateSuggestions(bubble, messages) {
            if (!config.url || !config.key) return;
            try {
                const context = messages.slice(-4).map(m => ({
                    role: m.role,
                    content: m.role === 'user' ? (m.versions[m.activeIdx]?.content || '') : m.content
                }));
                const res = await fetch(`${config.url.replace(/\/+$/, '')}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${config.key}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: config.model,
                        messages: [
                            { role: 'system', content: '根据对话内容，生成3个用户可能想继续追问的简短问题或操作指令。紧扣主题、简短精炼（不超过18字）、多样化。仅返回JSON数组，不要任何其他内容。格式: ["问题1","问题2","问题3"]' },
                            ...context
                        ],
                        max_tokens: 120
                    })
                });
                const data = await res.json();
                const raw = (data.choices?.[0]?.message?.content || '').trim().replace(/```json|```/g, '').trim();
                const suggestions = JSON.parse(raw);
                if (Array.isArray(suggestions) && suggestions.length > 0) {
                    const chips = document.createElement('div');
                    chips.className = 'suggestion-chips';
                    chips.innerHTML = suggestions.map(s =>
                        `<button class="suggestion-chip" onclick="useSuggestion(this)">${s}</button>`
                    ).join('');
                    bubble.appendChild(chips);
                }
            } catch(e) { /* 静默失败 */ }
        }

        function useSuggestion(btn) {
            const text = btn.textContent.trim();
            const input = document.getElementById('user-input');
            input.value = text;
            autoResize(input);
            input.focus();
            document.querySelectorAll('.suggestion-chips').forEach(el => el.remove());
        }

        function regenerateMessage(idx, event) {
            if (event) event.stopPropagation();
            if (isGenerating) return;
            const session = sessions.find(s => s.id === currentSessionId);
            if (!session) return;
            const userMsgIdx = idx - 1;
            if (userMsgIdx >= 0 && session.messages[userMsgIdx]) {
                session.messages = session.messages.slice(0, idx);
                loadSession(currentSessionId);
                handleSend(userMsgIdx, true);
            }
        }

        function editMessage(idx) {
            const session = sessions.find(s => s.id === currentSessionId);
            const msg = session.messages[idx];
            const ver = msg.versions[msg.activeIdx];
            const currentText = ver.displayText !== undefined 
                ? ver.displayText 
                : ver.content.replace(/\n\n---\s*导入文件:[\s\S]*/g, '').trim();

            const overlay = document.createElement('div');
            overlay.className = 'fixed inset-0 z-[6000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
            overlay.innerHTML = `
                <div class="bg-white w-full max-w-2xl rounded-3xl p-6 shadow-2xl">
                    <div class="text-sm font-medium mb-4 text-gray-500">编辑消息</div>
                    <textarea id="temp-edit-area" class="w-full h-64 p-4 border border-gray-100 rounded-2xl focus:ring-2 focus:ring-black outline-none resize-none text-sm leading-relaxed">${currentText}</textarea>
                    <div class="flex justify-end gap-3 mt-4">
                        <button id="cancel-edit" class="px-6 py-2 text-xs text-gray-400 hover:text-black">取消</button>
                        <button id="confirm-edit" class="px-6 py-2 bg-black text-white rounded-full text-xs">保存并重新发送</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            const textarea = document.getElementById('temp-edit-area');
            textarea.focus();

            const handleConfirm = () => {
                const nextText = textarea.value.trim();
                if (nextText && nextText !== currentText) {
                    msg.versions[msg.activeIdx].next = session.messages.slice(idx + 1);
                    const fileSection = ver.content.match(/(\n\n---\s*导入文件:[\s\S]*)$/);
                    const preservedFiles = fileSection ? fileSection[1] : '';
                    const newContent = nextText + preservedFiles;
                    msg.versions.push({ 
                        content: newContent, 
                        displayText: nextText, 
                        images: ver.images ? [...ver.images] : [],
                        files: ver.files ? [...ver.files] : [],
                        next: [] 
                    });
                    msg.activeIdx = msg.versions.length - 1;
                    handleSend(idx, true);
                }
                document.body.removeChild(overlay);
            };

            document.getElementById('confirm-edit').onclick = handleConfirm;
            document.getElementById('cancel-edit').onclick = () => document.body.removeChild(overlay);
        }

        function switchVer(msgIdx, dir, event) {
            event.stopPropagation();
            const session = sessions.find(s => s.id === currentSessionId);
            const msg = session.messages[msgIdx];
            let newIdx = msg.activeIdx + dir;
            if (newIdx >= 0 && newIdx < msg.versions.length) {
                msg.versions[msg.activeIdx].next = session.messages.slice(msgIdx + 1);
                msg.activeIdx = newIdx;
                const restoredNext = msg.versions[msg.activeIdx].next || [];
                session.messages = [...session.messages.slice(0, msgIdx + 1), ...restoredNext];
                loadSession(currentSessionId);
                saveSessions();
            }
        }
        function renderHistoryList() {
            document.getElementById('history-list').innerHTML = sessions.map(s => `
                <div class="history-item group relative">
                    <div onclick="loadSession(${s.id})" class="p-4 pr-16 text-[11px] rounded-2xl cursor-pointer transition-all truncate ${s.id === currentSessionId ? 'bg-black text-white shadow-lg' : 'hover:bg-gray-100 text-gray-400'}">${s.title}</div>
                    <div class="item-actions absolute right-2 top-1/2 -translate-y-1/2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <button onclick="exportSession(${s.id}, event)" class="p-1 hover:text-green-500 text-gray-300" title="导出">⤓</button>
                        <button onclick="renameSession(${s.id}, event)" class="p-1 hover:text-blue-400 text-gray-300">✎</button>
                        <button onclick="deleteSession(${s.id}, event)" class="p-1 hover:text-red-400 text-gray-300">✕</button>
                    </div>
                </div>
            `).join('') + `
            <div class="mt-4 p-2">
                <button onclick="importSession()" class="w-full py-2 text-[10px] text-gray-400 hover:text-black border border-dashed border-gray-200 rounded-xl">导入对话存档</button>
            </div>`;
        }

        function exportSession(id, e) {
            e.stopPropagation();
            const s = sessions.find(x => x.id === id);
            if (!s) return;
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(s));
            const dl = document.createElement('a');
            dl.setAttribute("href", dataStr);
            dl.setAttribute("download", `${s.title || 'chat'}_backup.json`);
            dl.click();
        }

        function importSession() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = e => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = event => {
                    try {
                        const imported = JSON.parse(event.target.result);
                        imported.id = Date.now(); // 分配新ID防止冲突
                        sessions.unshift(imported);
                        saveSessions();
                        loadSession(imported.id);
                    } catch (err) { alert('导入失败，文件格式错误'); }
                };
                reader.readAsText(file);
            };
            input.click();
        }
        function saveSessions() {
            db.save(sessions);
            renderHistoryList();
        }

        function clearAllData() { 
            if(confirm("确定清空所有数据（包括 API 配置和所有对话记录）吗？此操作不可撤销。")) { 
                localStorage.clear(); 
                const req = indexedDB.deleteDatabase(db.name);
                req.onsuccess = () => location.reload();
            } 
        }
                let _htmlBlobUrl = null;
        let _currentHtmlArtifactId = null;
        // 新增辅助函数：统一更新预览内容
        function updateHtmlPreviewContent(id) {
            const code = window.rawCodeBlocks[id];
            if (!code) return;
            if (_htmlBlobUrl) URL.revokeObjectURL(_htmlBlobUrl);
            _htmlBlobUrl = URL.createObjectURL(new Blob([code], { type: 'text/html' }));
            document.getElementById('html-iframe').src = _htmlBlobUrl;
            const safe = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            document.getElementById('html-code-view').innerHTML = safe;
        }

        function previewHtmlArtifact(id) {
            const code = window.rawCodeBlocks[id];
            if (!code) return;
            _currentHtmlArtifactId = id;
            document.getElementById('html-preview-title').textContent = extractHtmlTitle(code);
            
            updateHtmlPreviewContent(id); // 使用统一更新逻辑
            
            const copyBtn = document.getElementById('html-copy-btn');
            if (copyBtn) {
                copyBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>复制代码`;
                copyBtn.classList.remove('text-green-600', 'text-red-500');
                copyBtn.classList.add('text-gray-500');
            }
            switchHtmlTab('preview');
            document.getElementById('html-preview-modal').classList.remove('hidden');
        }
        function copyHtmlArtifact() {
            if (!_currentHtmlArtifactId) return;
            const code = window.rawCodeBlocks[_currentHtmlArtifactId];
            if (!code) return;
            const btn = document.getElementById('html-copy-btn');
            const restoreIcon = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>复制代码`;
            const setState = (text, colorClass) => {
                if (!btn) return;
                btn.innerHTML = text;
                btn.classList.remove('text-gray-500', 'text-green-600', 'text-red-500');
                btn.classList.add(colorClass);
                setTimeout(() => {
                    btn.innerHTML = restoreIcon;
                    btn.classList.remove('text-green-600', 'text-red-500');
                    btn.classList.add('text-gray-500');
                }, 1500);
            };
            const doFallback = () => {
                const ta = document.createElement('textarea');
                ta.value = code;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.focus(); ta.select();
                try {
                    document.execCommand('copy');
                    setState('已复制 ✓', 'text-green-600');
                } catch(e) {
                    setState('复制失败', 'text-red-500');
                }
                document.body.removeChild(ta);
            };
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(code)
                    .then(() => setState('已复制 ✓', 'text-green-600'))
                    .catch(doFallback);
            } else {
                doFallback();
            }
        }
        function switchHtmlTab(tab) {
            const p = tab === 'preview';
            document.getElementById('html-pane-preview').classList.toggle('hidden', !p);
            document.getElementById('html-pane-code').classList.toggle('hidden', p);
            document.getElementById('html-tab-preview').className = `px-3 py-1.5 rounded-lg text-[11px] font-medium ${p ? 'bg-black text-white' : 'text-gray-500 hover:bg-gray-100'}`;
            document.getElementById('html-tab-code').className = `px-3 py-1.5 rounded-lg text-[11px] font-medium ${!p ? 'bg-black text-white' : 'text-gray-500 hover:bg-gray-100'}`;
        }
        function closeHtmlPreview() {
            document.getElementById('html-preview-modal').classList.add('hidden');
            document.getElementById('html-iframe').src = 'about:blank';
        }
        function downloadHtmlArtifact(id, event) {
            event.stopPropagation();
            const code = window.rawCodeBlocks[id];
            if (!code) return;
            const name = extractHtmlTitle(code) + '.html';
            const blob = new Blob([code], { type: 'text/html' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            a.click();
        }
        function toggleCode(btn) {
            const content = btn.closest('.code-card').querySelector('.code-content');
            const expanded = content.classList.contains('expanded');
            if (!expanded) {
                content.style.maxHeight = content.scrollHeight + 'px';
                content.classList.add('expanded');
                btn.textContent = '收起 ∧';
            } else {
                content.style.maxHeight = '';
                content.classList.remove('expanded');
                btn.textContent = '展开 ∨';
            }
        }

        // --- ai_edit_file 验证与应用 ---
        function applyEdit(id) {
            const edit = (window.editCards || {})[id];
            if (!edit) { alert('修改数据丢失，请重新生成。'); return; }

            const content = (window.fileStore || {})[edit.filename];
            if (content === undefined) {
                _setEditStatus(id, 'fail', `未找到文件 "${edit.filename}"，请先上传该文件`);
                return;
            }
            if (!content.includes(edit.search)) {
                _setEditStatus(id, 'mismatch', null);
                return;
            }
            // 应用修改
            const newContent = content.replace(edit.search, edit.replace);
            window.fileStore[edit.filename] = newContent;
            const blob = new Blob([newContent], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = edit.filename; a.click();
            URL.revokeObjectURL(url);
            _setEditStatus(id, 'success', null);
        }

        function _setEditStatus(id, status, msg) {
            const statusEl = document.getElementById(id + '-status');
            const actionsEl = document.getElementById(id + '-actions');
            if (status === 'success') {
                if (statusEl) { statusEl.textContent = '✓ 已应用并下载'; statusEl.className = 'edit-card-status edit-status-ok'; }
                if (actionsEl) actionsEl.innerHTML = '';
            } else if (status === 'mismatch') {
                if (statusEl) { statusEl.textContent = '✗ 原文不匹配'; statusEl.className = 'edit-card-status edit-status-fail'; }
                if (actionsEl) actionsEl.innerHTML = `
                    <span class="edit-retry-hint">是否重新生成？</span>
                    <button class="edit-retry-btn" onclick="editRetry('${id}')">重新生成</button>
                    <button class="edit-dismiss-btn" onclick="editDismiss('${id}')">不需要</button>`;
            } else if (status === 'fail') {
                if (statusEl) { statusEl.textContent = msg || '失败'; statusEl.className = 'edit-card-status edit-status-fail'; }
                if (actionsEl) actionsEl.innerHTML = `<button class="edit-dismiss-btn" onclick="editDismiss('${id}')">知道了</button>`;
            }
        }

        function editRetry(id) {
            const edit = (window.editCards || {})[id];
            editDismiss(id);
            if (!edit) return;
            const input = document.getElementById('user-input');
            input.value = `你上次给出的针对 "${edit.filename}" 的修改验证失败，原因是 <search> 里的文本在文件中找不到完全一致的内容（可能是空格或缩进有出入）。请重新查看我发给你的原始文件内容，确保 <search> 部分与原文件逐字逐空格完全一致后，重新输出 <ai_edit_file> 修改。`;
            input.focus();
            autoResize(input);
        }

        function editDismiss(id) {
            const actionsEl = document.getElementById(id + '-actions');
            if (actionsEl) actionsEl.innerHTML = '<span style="font-size:11px;color:#9ca3af;padding:4px 0;display:block">已跳过</span>';
        }
        function autoResize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
        function stopGeneration() { if (currentAbortController) currentAbortController.abort(); isGenerating = false; toggleInputState(false); }
        function toggleInputState(loading) {
            isGenerating = loading;
            document.getElementById('send-btn').classList.toggle('hidden', loading);
            document.getElementById('stop-btn').classList.toggle('hidden', !loading);
        }
        function renameSession(id, e) { e.stopPropagation(); const s = sessions.find(x => x.id === id); const n = prompt("重命名:", s.title); if(n) { s.title = n; saveSessions(); } }

        async function autoRenameSession(id) {
            const session = sessions.find(x => x.id === id);
            if (!session || session.messages.length === 0) return;
            const sampleText = session.messages.slice(0, 2).map(m => {
                const text = m.role === 'user' ? (m.versions[m.activeIdx]?.content || '') : m.content;
                return `${m.role === 'user' ? '用户' : 'AI'}: ${text}`;
            }).join('\n');
            try {
                const res = await fetch(`${config.url.replace(/\/+$/, '')}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${config.key}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        model: config.model, 
                        messages: [
                            { role: "system", content: "你是一个智能对话命名助手。请分析对话的初次提问和AI的回答，提取用户的核心意图或讨论的具体事物，生成一个高度概括且具象的标题（建议 4~12 个字）。采用动宾结构或核心名词，例如'修复流式输出截断问题'或'Tailwind样式修改'。绝不要使用完整的句子，绝不要包含任何标点符号、引号、解释或前缀。直接纯文本返回标题。" },
                            { role: "user", content: `请为以下对话生成精简标题：\n${sampleText}` }
                        ],
                        max_tokens: 30
                    })
                });
                const data = await res.json();
                if (data.choices && data.choices[0].message.content) {
                    const cleanTitle = data.choices[0].message.content.trim().replace(/[。！？，、""""''「」]/g, '');
                    if (cleanTitle) {
                        session.title = cleanTitle;
                        saveSessions();
                    }
                }
            } catch (e) {
                console.error("AI 自动命名失败: ", e);
            }
        }
        function deleteSession(id, e) { e.stopPropagation(); if(confirm("删除？")) { sessions = sessions.filter(x => x.id !== id); saveSessions(); if(currentSessionId === id) createNewChat(); } }
        function filterQuickModels() { const q = document.getElementById('quick-model-search').value.toLowerCase(); renderQuickModelList(allModels.filter(m => m.toLowerCase().includes(q))); }
        function filterModels() { const q = document.getElementById('model-search').value.toLowerCase(); renderModelList(allModels.filter(m => m.toLowerCase().includes(q))); }
