// ==UserScript==
// @name         烂梗机
// @namespace    http://tampermonkey.net/
// @version      1.1.5
// @description  多平台自动复读弹幕 | 修复DPM误判 | 精准弹幕检测
// @match        https://www.douyu.com/*
// @match        https://www.huya.com/*
// @match        https://live.bilibili.com/*
// @match        https://live.douyin.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    if (window.dyBotScriptLoaded) return;
    window.dyBotScriptLoaded = true;

    // =============================== 常量与平台检测 ===============================
    const PLATFORM = (() => {
        const host = location.hostname;
        if (host.includes('douyu.com')) return 'douyu';
        if (host.includes('bilibili.com')) return 'bilibili';
        if (host.includes('douyin.com') || host.includes('live.douyin.com')) return 'douyin';
        if (host.includes('huya.com')) return 'huya';
        return 'unknown';
    })();
    console.log('[烂梗机] 平台:', PLATFORM);

    const DANMU_CACHE_MAX = 500;
    const UI_UPDATE_INTERVAL = 2000;
    const CONTAINER_POLL_INTERVAL = 1000;
    const CONTAINER_POLL_MAX = 45;
    const DPM_WINDOW_MS = 60000;
    const MAX_TIMESTAMPS = 500;
    const MAX_TS_AGE_MS = 120000;
    const TS_CLEANUP_INTERVAL = 5000;
    const MAX_HISTORY_SIZE_FALLBACK = 100;
    const RETRY_MAX_ATTEMPTS = 3;
    const MIN_SEND_INTERVAL_MS = 2000;
    const RETRY_DELAY_MS = 3000;
    const SELECTOR_REPROBE_INTERVAL = 300000;

    const STORAGE_KEYS = {
        CONFIG: PLATFORM + '_config_v5',
        BLOCKLIST: PLATFORM + '_blocklist_v5',
        PRIORITY: PLATFORM + '_priority_v5',
        PANEL_POS: PLATFORM + '_panel_v5',
        FILTER_RULES: PLATFORM + '_filter_rules_v5',
        THEME: PLATFORM + '_theme_v5',
        CONFIG_VERSION: PLATFORM + '_config_version_v5',
    };

    // =============================== 默认配置（含主题） ===============================
    const defaultConfig = {
        minMsgLength: 4,
        lengthThreshold: 15,
        lengthBonus: 2.5,
        trendingThreshold: 5,
        priorityEnabled: true,
        priorityWeight: 3.0,
        crazyModeDPM: 180,
        normalModeDPM: 80,
        crazyInterval: 4,
        normalIntervalMin: 6,
        normalIntervalMax: 8,
        zenInterval: 10,
        dedupWindowSec: 120,
        dedupHistorySize: 25,
        filterRules: [],
        theme: {
            bgColor: '#1a1a2e',
            textColor: '#e0e0e0',
            accentColor: '#ff9800',
            borderColor: 'rgba(255,255,255,0.06)',
            opacity: 0.95,
            fontSize: '12px',
            borderRadius: '10px',
        }
    };

    // =============================== 状态对象 ===============================
    const state = {
        config: { ...defaultConfig },
        mainTimer: null,
        countdownTimer: null,
        retryTimer: null,
        nextSendTimestamp: 0,
        currentMode: '关闭',
        isRunning: false,
        danmuObserver: null,
        containerElement: null,
        freqMap: new Map(),
        weightedMap: new Map(),
        recentSent: [],
        sentHistory: [],
        blocklist: [],
        priorityWords: [],
        candidateCount: 0,
        lastSentMsg: '',
        nextPreviewMsg: '',
        pendingMsg: null,
        errors: [],
        debugLogs: [],
        timestamps: [],
        retryCount: 0,
        lastRetryTime: 0,
        isSending: false,
        weightUpdateScheduled: false,
        configVersion: 0,
        lastTsCleanup: 0,
    };

    // =============================== 基础选择器（多平台） ===============================
    const BASE_SELECTORS = {
        douyu: {
            danmuContainer: ['#js-barrage-list', '.Barrage-list', '.Barrage-main', '[class*="Barrage-list"]', '.chat-history', '.danmu-list'],
            danmuItem: ['li.Barrage-listItem', '.Barrage-listItem', '[class*="barrage-item"]'],
            danmuText: ['span.Barrage-content:not(.Barrage-pointer)', '.barrage-text', '[class*="barrage-content"]'],
            chatInput: ['div.ChatSend-txt', '.ChatSend-txt', '[contenteditable="true"]', 'textarea.chat-input', 'input.chat-input'],
            sendButton: ['.ChatSend-button', 'div.ChatSend-button', 'button[class*="send"]', '.send-btn'],
        },
        bilibili: {
            danmuContainer: ['#chat-items', '#chat-history-list', '.chat-list', '.danmaku-list'],
            danmuItem: ['.chat-item.danmaku-item', '.danmaku-item', '[class*="danmaku-item"]'],
            danmuText: ['.chat-item.danmaku-item', '.danmaku-text'],
            chatInput: ['textarea.chat-input', 'textarea#chat-input', 'input[type="text"].chat-input'],
            sendButton: ['button.send-btn', '.bl-button.send-btn', 'button[class*="send"]'],
            textSource: 'data-danmaku',
        },
        douyin: {
            danmuContainer: ['.gOr3NRD4', '[class*="webcast-chatroom"]', '#chat-room', '.chat-container', '.danmu-container'],
            danmuItem: ['.webcast-chatroom___item', '.chat-item', '[class*="chat-item"]'],
            danmuText: ['.webcast-chatroom___content-with-emoji-text', '.chat-content', '.danmu-text'],
            chatInput: ['[data-slate-editor="true"]', 'div[contenteditable="true"]', '.chat-input', 'textarea.chat-input', 'input.chat-input'],
            sendButton: ['svg.webcast-chatroom___send-btn', '.webcast-chatroom___send-btn', 'button.webcast-chatroom___send-btn', 'button[class*="send"]', 'div[class*="send"]'],
        },
        huya: {
            danmuContainer: ['#chat-room__list', '#chat-room__wrap', '.chat-room__list', '#msg-list', '.chat-room-list', '.chat-messages', '.chat-history', '.danmu-list'],
            danmuItem: ['.msg-item', '.msg-normal', '.js-chat-item', '.chat-item', '[class*="chat-item"]'],
            danmuText: ['.msg-text', '.msg-content', '.J_msg', '.chat-text', '.danmu-text'],
            chatInput: ['#pub_msg_input', '#chat-input', 'textarea.input-msg', '.chat-textarea', 'textarea[placeholder*="发言"]', '#chatTextarea', 'div[contenteditable="true"]', 'input[type="text"]'],
            sendButton: ['#msg_send_bt', '.js-send-msg', '.send-btn', '.btn-sendMsg', 'button[aria-label="发送"]', 'span.send-btn', 'button[class*="send"]', 'div[class*="send"]'],
        }
    };

    // =============================== 选择器探测器 ===============================
    class SelectorProbe {
        constructor(platform) {
            this.platform = platform;
            this.base = BASE_SELECTORS[platform] || BASE_SELECTORS.douyu;
            this.cache = { danmuContainer: null, danmuItem: null, danmuText: null, chatInput: null, sendButton: null };
            this.lastProbe = 0;
            this.probeInterval = SELECTOR_REPROBE_INTERVAL;
        }

        probeOne(selectorArray, root = document) {
            if (!Array.isArray(selectorArray)) selectorArray = [selectorArray];
            const valid = selectorArray.filter(s => s && typeof s === 'string' && s.trim() !== '');
            for (const sel of valid) {
                try {
                    const el = root.querySelector(sel);
                    if (el) return { selector: sel, element: el };
                } catch (_) {}
            }
            return null;
        }

        probeAll() {
            const now = Date.now();
            if (now - this.lastProbe < this.probeInterval && this.cache.danmuContainer && document.contains(this.cache.danmuContainer)) {
                return this.cache;
            }
            this.lastProbe = now;

            const cr = this.probeOne(this.base.danmuContainer);
            if (cr) {
                this.cache.danmuContainer = cr.element;
                this.cache.danmuContainerSelector = cr.selector;
            } else {
                this.cache.danmuContainer = null;
            }

            this.cache.danmuItemSelector = this.base.danmuItem[0] || '';
            this.cache.danmuTextSelector = this.base.danmuText[0] || '';
            this.cache.chatInputSelector = this.base.chatInput[0] || '';
            this.cache.sendButtonSelector = this.base.sendButton[0] || '';
            return this.cache;
        }

        getSelectors() {
            const cache = this.probeAll();
            return {
                danmuContainer: cache.danmuContainer ? cache.danmuContainerSelector : null,
                danmuItem: cache.danmuItemSelector,
                danmuText: cache.danmuTextSelector,
                chatInput: cache.chatInputSelector,
                sendButton: cache.sendButtonSelector,
                containerElement: cache.danmuContainer,
            };
        }

        refresh() {
            this.lastProbe = 0;
            return this.probeAll();
        }
    }

    // =============================== 工具函数 ===============================
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function findElement(selectors, root = document) {
        if (!selectors) return null;
        if (!Array.isArray(selectors)) selectors = [selectors];
        const valid = selectors.filter(s => s && typeof s === 'string' && s.trim() !== '');
        for (const sel of valid) {
            try {
                const el = root.querySelector(sel);
                if (el) return el;
            } catch (_) {}
        }
        return null;
    }

    function findElementSmart(selectors, root = document, type = 'generic') {
        const bySelector = findElement(selectors, root);
        if (bySelector) return bySelector;

        let query = '';
        if (type === 'input') {
            query = 'textarea, input, [contenteditable="true"], [role="textbox"], [role="combobox"], [aria-label*="输入"], [aria-label*="发言"], [placeholder]';
        } else if (type === 'button') {
            query = 'button, input[type="submit"], input[type="button"], [role="button"], [aria-label*="发送"], [aria-label*="send"], [aria-label*="提交"], [class*="send"], [class*="submit"]';
        } else {
            query = 'button, input, textarea, [contenteditable], [role="button"], [role="textbox"]';
        }
        try {
            const elements = root.querySelectorAll(query);
            const candidates = [];
            for (const el of elements) {
                try {
                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 && rect.height === 0) continue;
                } catch (_) { continue; }
                if (el.offsetParent === null && !el.isContentEditable) continue;
                candidates.push(el);
            }
            if (candidates.length === 0) return null;
            candidates.sort((a, b) => {
                const ra = a.getBoundingClientRect();
                const rb = b.getBoundingClientRect();
                return (rb.top + rb.bottom) - (ra.top + ra.bottom);
            });
            return candidates[0];
        } catch (_) { return null; }
    }

    function findAllElements(selectors, root = document) {
        if (!selectors) return [];
        if (!Array.isArray(selectors)) selectors = [selectors];
        const valid = selectors.filter(s => s && typeof s === 'string' && s.trim() !== '');
        const results = [];
        for (const sel of valid) {
            try {
                const els = root.querySelectorAll(sel);
                if (els.length) results.push(...els);
            } catch (_) {}
        }
        return results;
    }

    function $(id) { return document.getElementById(id); }

    function escapeHtml(str) {
        return String(str).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m] || m));
    }

    // =============================== 平台解析器（含降级方案） ===============================
    class PlatformParser {
        constructor(platform, probe) {
            this.platform = platform;
            this.probe = probe;
            this.selectors = probe.getSelectors();
        }

        refreshSelectors() { this.selectors = this.probe.getSelectors(); }

        extractText(danmuNode) {
            if (!danmuNode) return '';
            const sel = this.selectors;
            if (this.platform === 'bilibili' && BASE_SELECTORS.bilibili.textSource) {
                const attr = danmuNode.getAttribute('data-danmaku');
                if (attr) return attr.replace(/\s+/g, ' ').trim();
            }
            if (sel.danmuText) {
                const textEl = findElement(sel.danmuText, danmuNode);
                if (textEl) return (textEl.textContent || '').replace(/\s+/g, ' ').trim();
            }
            return (danmuNode.textContent || '').replace(/\s+/g, ' ').trim();
        }

        // 终极降级：所有选择器失败时返回 document.body
        findContainer() {
            const sel = this.selectors;
            if (sel.containerElement && document.contains(sel.containerElement)) {
                return sel.containerElement;
            }
            const result = this.probe.probeOne(BASE_SELECTORS[this.platform].danmuContainer);
            if (result) {
                this.selectors.containerElement = result.element;
                this.selectors.danmuContainer = result.selector;
                return result.element;
            }
            console.warn('[烂梗机] 未找到弹幕容器，降级监听 body');
            return document.body;
        }

        findChatInput() {
            let el = findElement(this.selectors.chatInput);
            if (el) return el;
            return findElementSmart(this.selectors.chatInput, document, 'input');
        }

        findSendButton() {
            let el = findElement(this.selectors.sendButton);
            if (el) return el;
            return findElementSmart(this.selectors.sendButton, document, 'button');
        }

        getDanmuItemSelector() { return this.selectors.danmuItem; }
    }

    // =============================== 平台发送器 ===============================
    class PlatformSender {
        constructor(platform, parser) {
            this.platform = platform;
            this.parser = parser;
            this.cachedInput = null;
            this.cachedButton = null;
            this.lastCacheTime = 0;
        }

        refreshCache() {
            this.cachedInput = this.parser.findChatInput();
            this.cachedButton = this.parser.findSendButton();
            this.lastCacheTime = Date.now();
            if (!this.cachedInput) console.warn('[烂梗机] 未找到输入框');
            if (!this.cachedButton) console.warn('[烂梗机] 未找到发送按钮');
        }

        async send(msg) {
            if (!msg) return { success: false, errorCode: 'EMPTY_MSG', message: '消息为空' };
            if (!state.isRunning) return { success: false, errorCode: 'STOPPED', message: '机器人已停止' };

            if (!this.cachedInput || !this.cachedButton || Date.now() - this.lastCacheTime > 30000) {
                this.refreshCache();
            }
            const input = this.cachedInput;
            let button = this.cachedButton;
            if (!input) {
                this.refreshCache();
                if (!this.cachedInput) return { success: false, errorCode: 'INPUT_NOT_FOUND', message: '输入框未找到' };
            }

            try {
                this._fillInput(input, msg);
            } catch (e) {
                console.error('[烂梗机] 填充输入框失败:', e);
                return { success: false, errorCode: 'FILL_ERROR', message: e.message };
            }

            const result = await this._platformSpecificSend(input, button);
            if (result.success) {
                let currentVal = '';
                try { currentVal = input.value || input.innerText || ''; } catch (_) {}
                if (currentVal.trim() === '') {
                    return { success: true, errorCode: null, message: '发送成功' };
                } else {
                    return { success: false, errorCode: 'SEND_FAILED', message: '发送后输入框未清空' };
                }
            } else {
                return result;
            }
        }

        _fillInput(input, msg) {
            try { input.focus(); } catch (_) {}
            if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
                input.value = msg;
            } else if (input.isContentEditable) {
                input.innerText = '';
                try {
                    const range = document.createRange();
                    const sel = window.getSelection();
                    range.selectNodeContents(input);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    document.execCommand('insertText', false, msg);
                } catch (_) {
                    input.innerText = msg;
                }
                if (input.innerText !== msg) input.innerText = msg;
            } else {
                input.value = msg;
            }
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            try {
                input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
                input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: msg }));
            } catch (_) {}
        }

        async _platformSpecificSend(input, btn) {
            const platform = this.platform;
            if (platform === 'douyin') {
                input.dispatchEvent(new Event('beforeinput', { bubbles: true }));
                await sleep(100);
                if (!btn || !document.body.contains(btn)) {
                    this.refreshCache();
                    btn = this.cachedButton;
                }
                if (btn) {
                    this._enableButton(btn);
                    this._triggerClick(btn);
                    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                    return { success: true };
                }
                return { success: false, errorCode: 'BUTTON_NOT_FOUND', message: '发送按钮未找到' };
            }
            if (platform === 'huya') {
                input.focus();
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true }));
                await sleep(50);
                if (!btn || !document.body.contains(btn)) {
                    this.refreshCache();
                    btn = this.cachedButton;
                }
                if (btn) {
                    this._enableButton(btn);
                    this._triggerClick(btn);
                    this._triggerReactHandler(btn);
                    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                    return { success: true };
                }
                return { success: false, errorCode: 'BUTTON_NOT_FOUND', message: '虎牙发送按钮未找到' };
            }
            if (platform === 'bilibili') {
                await sleep(50);
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                return { success: true };
            }
            // 通用（斗鱼等）
            await sleep(100);
            if (!btn || !document.body.contains(btn)) {
                this.refreshCache();
                btn = this.cachedButton;
            }
            if (btn) {
                this._enableButton(btn);
                this._triggerClick(btn);
                return { success: true };
            }
            return { success: false, errorCode: 'BUTTON_NOT_FOUND', message: '通用发送按钮未找到' };
        }

        _enableButton(btn) {
            try {
                btn.classList.remove('disable', 'disabled', 'is-disabled');
                btn.removeAttribute('disabled');
                btn.disabled = false;
            } catch (_) {}
        }

        _triggerClick(el) {
            const events = ['mousedown', 'mouseup', 'click'];
            for (const type of events) {
                try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })); } catch (_) {}
            }
            try {
                el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
                el.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
            } catch (_) {}
        }

        _triggerReactHandler(el) {
            try {
                const keys = Object.keys(el).filter(k =>
                    k.startsWith('__reactEventHandlers') || k.startsWith('_reactListeners') || k.startsWith('__reactProps')
                );
                for (const key of keys) {
                    const props = el[key];
                    if (props) {
                        const handlers = ['onClick', 'onMouseDown', 'onTouchEnd', 'onPress'];
                        for (const h of handlers) {
                            if (typeof props[h] === 'function') {
                                try { props[h](new MouseEvent('click', { bubbles: true })); } catch (_) {}
                            }
                        }
                    }
                }
            } catch (_) {}
        }
    }

    // =============================== 核心辅助函数 ===============================
    const blockRegexCache = new Map();
    function isBlocked(text) {
        try {
            for (const rule of state.blocklist) {
                if (!rule) continue;
                if (rule.startsWith('/') && rule.endsWith('/')) {
                    try { const re = new RegExp(rule.slice(1, -1), 'i'); if (re.test(text)) return true; } catch (_) {}
                } else {
                    if (text.toLowerCase().includes(rule.toLowerCase())) return true;
                }
            }
            const rules = state.config.filterRules || [];
            for (const rule of rules) {
                if (rule.type === 'length') {
                    const len = text.length;
                    if (rule.op === '>' && len <= rule.value) return true;
                    if (rule.op === '<' && len >= rule.value) return true;
                    if (rule.op === '==' && len !== rule.value) return true;
                    if (rule.op === '>=' && len < rule.value) return true;
                    if (rule.op === '<=' && len > rule.value) return true;
                } else if (rule.type === 'contains') {
                    if (!text.includes(rule.value)) return true;
                } else if (rule.type === 'not_contains') {
                    if (text.includes(rule.value)) return true;
                } else if (rule.type === 'regex') {
                    try { const re = new RegExp(rule.value, 'i'); if (!re.test(text)) return true; } catch (_) {}
                }
            }
        } catch (_) {}
        return false;
    }

    function clearBlockRegexCache() { blockRegexCache.clear(); }

    function getPriorityMultiplier(text) {
        try {
            if (!state.config.priorityEnabled || !state.priorityWords.length) return 1;
            for (const word of state.priorityWords) {
                if (!word) continue;
                let matched = false;
                if (word.startsWith('/') && word.endsWith('/')) {
                    try { const re = new RegExp(word.slice(1, -1), 'i'); if (re.test(text)) matched = true; } catch (_) {}
                } else {
                    if (text.toLowerCase().includes(word.toLowerCase())) matched = true;
                }
                if (matched) return state.config.priorityWeight;
            }
        } catch (_) {}
        return 1;
    }

    function getLengthMultiplier(text) {
        try { return text.length > state.config.lengthThreshold ? state.config.lengthBonus : 1; } catch (_) { return 1; }
    }

    // =============================== 日志 ===============================
    function addDebugLog(level, content) {
        try {
            state.debugLogs.push({ level, content, time: new Date().toLocaleTimeString() });
            if (state.debugLogs.length > 500) state.debugLogs.shift();
            updateDebugConsoleUI();
        } catch (_) {}
    }

    const origWarn = console.warn;
    const origError = console.error;
    console.warn = function (...args) {
        origWarn.apply(console, args);
        try { const c = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '); addDebugLog('warn', c); } catch (_) {}
    };
    console.error = function (...args) {
        origError.apply(console, args);
        try { const c = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '); addDebugLog('error', c); } catch (_) {}
    };

    function captureError(source, err) {
        const msg = err?.message || String(err);
        console.error(`[烂梗机] 错误 [${source}]:`, msg);
        try {
            state.errors.push({ source, message: msg, time: new Date().toLocaleTimeString() });
            if (state.errors.length > 20) state.errors.shift();
            addDebugLog('error', `[${source}] ${msg}`);
        } catch (_) {}
    }

    // =============================== DPM 优化（基于斗鱼Ex） ===============================
    function recordMessageTimestamp() {
        const now = Date.now();
        state.timestamps.push(now);

        // 限制容量
        if (state.timestamps.length > MAX_TIMESTAMPS) {
            state.timestamps = state.timestamps.slice(-MAX_TIMESTAMPS);
        }

        // 定时清理（每5秒）
        if (now - state.lastTsCleanup > TS_CLEANUP_INTERVAL) {
            const cutoff = now - MAX_TS_AGE_MS;
            state.timestamps = state.timestamps.filter(ts => ts > cutoff);
            state.lastTsCleanup = now;
        }
    }

    function getMessagesPerMinute() {
        // 仅在数组较大或最旧时间戳过期时清理
        const cutoff = Date.now() - DPM_WINDOW_MS;
        if (state.timestamps.length > 0) {
            const oldest = state.timestamps[0];
            if (oldest < cutoff) {
                state.timestamps = state.timestamps.filter(ts => ts > cutoff);
            }
        }
        return state.timestamps.length;
    }

    // =============================== 弹幕采集（精准检测） ===============================
    function startDanmuObserver(container) {
        try { if (state.danmuObserver) state.danmuObserver.disconnect(); } catch (_) {}

        // 重置时间戳（新直播间重新统计）
        state.timestamps = [];
        state.lastTsCleanup = 0;

        let pendingNodes = [];
        let idleCallbackId = null;

        const processPending = () => {
            const nodes = pendingNodes;
            pendingNodes = [];
            idleCallbackId = null;
            for (const node of nodes) {
                try {
                    extractDanmuAndUpdate(node);
                } catch (_) {}
            }
        };

        const schedule = () => {
            if (idleCallbackId) return;
            if (window.requestIdleCallback) {
                idleCallbackId = requestIdleCallback(processPending, { timeout: 100 });
            } else {
                idleCallbackId = setTimeout(processPending, 0);
            }
        };

        const extractDanmuAndUpdate = (node) => {
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            const itemSelector = parser.getDanmuItemSelector();
            let matched = false;
            if (itemSelector) {
                const items = itemSelector.split(',').map(s => s.trim()).filter(Boolean);
                for (const sel of items) {
                    try {
                        if (node.matches && node.matches(sel)) {
                            const text = parser.extractText(node);
                            if (text) addDanmuToCache(text);
                            matched = true;
                            break;
                        }
                    } catch (_) {}
                }
            }
            if (!matched && node.querySelectorAll) {
                try {
                    const allItems = findAllElements(itemSelector, node);
                    for (const item of allItems) {
                        const text = parser.extractText(item);
                        if (text) addDanmuToCache(text);
                    }
                } catch (_) {}
            }
        };

        try {
            // ★★★ 修复：只对真正的弹幕节点记录时间戳 ★★★
            state.danmuObserver = new MutationObserver(mutations => {
                let hasNew = false;
                const itemSelector = parser.getDanmuItemSelector();
                // 解析选择器列表
                let selectors = [];
                if (itemSelector) {
                    selectors = itemSelector.split(',').map(s => s.trim()).filter(Boolean);
                }

                for (const m of mutations) {
                    for (const node of m.addedNodes) {
                        if (node.nodeType !== Node.ELEMENT_NODE) continue;

                        // 检查节点是否匹配弹幕条目选择器
                        let isDanmu = false;
                        if (selectors.length > 0) {
                            // 检查节点自身
                            for (const sel of selectors) {
                                try {
                                    if (node.matches && node.matches(sel)) {
                                        isDanmu = true;
                                        break;
                                    }
                                } catch (_) {}
                            }
                            // 如果节点本身不匹配，检查其子元素是否有匹配的
                            if (!isDanmu && node.querySelectorAll) {
                                for (const sel of selectors) {
                                    try {
                                        if (node.querySelectorAll(sel).length > 0) {
                                            isDanmu = true;
                                            break;
                                        }
                                    } catch (_) {}
                                }
                            }
                        } else {
                            // 如果没有选择器，则回退到检查节点是否包含特定类或属性（较宽泛）
                            // 实际上不应该发生，但保留兜底
                            isDanmu = true;
                        }

                        if (isDanmu) {
                            // 只有真正的弹幕节点才记录时间戳和提取文本
                            recordMessageTimestamp();
                            hasNew = true;
                            pendingNodes.push(node);
                        }
                    }
                }
                if (hasNew) schedule();
            });

            state.danmuObserver.observe(container, { childList: true, subtree: true });
            console.log('[烂梗机] 弹幕监听已启动（DPM精准版）');
            addDebugLog('info', '弹幕监听已启动（DPM精准版）');
        } catch (e) {
            captureError('startDanmuObserver', e);
        }
    }

    function addDanmuToCache(text) {
        if (!text) return;
        try {
            const count = (state.freqMap.get(text) || 0) + 1;
            state.freqMap.set(text, count);
            if (state.freqMap.size > DANMU_CACHE_MAX) {
                const entries = [...state.freqMap.entries()];
                entries.sort((a, b) => b[1] - a[1]);
                state.freqMap = new Map(entries.slice(0, DANMU_CACHE_MAX));
            }
            scheduleWeightUpdate();
        } catch (_) {}
    }

    function scheduleWeightUpdate() {
        if (state.weightUpdateScheduled) return;
        state.weightUpdateScheduled = true;
        try {
            if (window.requestIdleCallback) {
                requestIdleCallback(updateWeights, { timeout: 200 });
            } else {
                setTimeout(updateWeights, 50);
            }
        } catch (_) {
            setTimeout(updateWeights, 50);
        }
    }

    function updateWeights() {
        state.weightUpdateScheduled = false;
        try {
            const now = Date.now();
            const windowMs = state.config.dedupWindowSec * 1000;
            const cutoff = windowMs > 0 ? now - windowMs : 0;
            const sentTexts = new Set(state.recentSent.filter(m => m.timestamp > cutoff).map(m => m.text));
            const historySet = new Set(state.sentHistory);

            const newWeighted = new Map();
            for (const [text, count] of state.freqMap.entries()) {
                if (text.length < state.config.minMsgLength) continue;
                if (isBlocked(text)) continue;
                if (sentTexts.has(text)) continue;
                if (historySet.has(text)) continue;
                const weight = count * count * getLengthMultiplier(text) * getPriorityMultiplier(text);
                newWeighted.set(text, { count, weight });
            }
            state.weightedMap = newWeighted;
        } catch (e) {
            captureError('updateWeights', e);
        }
    }

    // =============================== 权重选择（移除全量排序） ===============================
    function getWeightedMessages() {
        try {
            const candidates = [];
            for (const [text, data] of state.weightedMap) {
                candidates.push({ text, count: data.count, weight: data.weight, length: text.length });
            }
            state.candidateCount = candidates.length;
            return candidates;
        } catch (e) {
            captureError('getWeightedMessages', e);
            return [];
        }
    }

    // =============================== 加权随机选择（一次遍历，无排序） ===============================
    function weightedRandomSelect(candidates) {
        if (!candidates.length) return null;

        // 趋势置顶：找最大频次
        if (state.config.trendingThreshold > 0) {
            let max = candidates[0];
            for (const c of candidates) {
                if (c.count > max.count) max = c;
            }
            if (max.count >= state.config.trendingThreshold) return max;
        }

        // 加权随机：一次遍历
        let total = 0;
        for (const c of candidates) total += c.weight;
        if (total <= 0) return candidates[0];

        let rand = Math.random() * total;
        for (const c of candidates) {
            rand -= c.weight;
            if (rand < 0) return c;
        }
        return candidates[candidates.length - 1];
    }

    // =============================== 发送与调度 ===============================
    async function sendMessage(msg) {
        if (!msg || state.isSending) return { success: false, errorCode: 'BUSY', message: '正在发送中' };
        if (!state.isRunning) return { success: false, errorCode: 'STOPPED', message: '机器人已停止' };

        state.isSending = true;
        try {
            const result = await sender.send(msg);
            if (result.success) {
                updateSentHistory(msg);
                state.pendingMsg = null;
                state.retryCount = 0;
                state.lastRetryTime = 0;
                addDebugLog('send', `发送成功: ${msg}`);
                return { success: true };
            } else {
                state.pendingMsg = msg;
                state.lastRetryTime = Date.now();
                console.warn('[烂梗机] 发送失败:', result.message);
                addDebugLog('warn', `发送失败: ${result.message} (${result.errorCode})`);
                return { success: false, errorCode: result.errorCode, message: result.message };
            }
        } catch (e) {
            captureError('sendMessage', e);
            state.pendingMsg = msg;
            state.lastRetryTime = Date.now();
            return { success: false, errorCode: 'EXCEPTION', message: e.message };
        } finally {
            state.isSending = false;
        }
    }

    function updateSentHistory(msg) {
        try {
            const now = Date.now();
            state.recentSent.push({ text: msg, timestamp: now });
            const windowMs = state.config.dedupWindowSec * 1000;
            if (windowMs > 0) state.recentSent = state.recentSent.filter(m => m.timestamp > now - windowMs);

            state.sentHistory.push(msg);
            const maxHistory = state.config.dedupHistorySize > 0 ? state.config.dedupHistorySize : MAX_HISTORY_SIZE_FALLBACK;
            while (state.sentHistory.length > maxHistory) state.sentHistory.shift();
            state.lastSentMsg = msg;

            state.weightedMap.delete(msg);
            scheduleWeightUpdate();
        } catch (e) {
            captureError('updateSentHistory', e);
        }
    }

    async function runBot() {
        if (!state.isRunning || state.isSending) return;

        try {
            if (state.pendingMsg) {
                const now = Date.now();
                if (state.retryCount < RETRY_MAX_ATTEMPTS && now - state.lastRetryTime >= RETRY_DELAY_MS) {
                    state.retryCount++;
                    state.lastRetryTime = now;
                    const result = await sendMessage(state.pendingMsg);
                    if (!result.success) {
                        scheduleRetry();
                        return;
                    }
                } else if (state.retryCount >= RETRY_MAX_ATTEMPTS) {
                    console.warn('[烂梗机] 超过最大重试次数，丢弃:', state.pendingMsg);
                    addDebugLog('warn', `丢弃未发送消息: ${state.pendingMsg}`);
                    state.pendingMsg = null;
                    state.retryCount = 0;
                    state.lastRetryTime = 0;
                }
                return;
            }

            const candidates = getWeightedMessages();
            if (!candidates.length) return;
            const selected = weightedRandomSelect(candidates);
            if (selected) {
                if (!state.isRunning) return;
                const result = await sendMessage(selected.text);
                if (result.success) {
                    const nextCandidates = getWeightedMessages();
                    state.nextPreviewMsg = nextCandidates[0]?.text || '';
                }
            }
        } catch (e) {
            captureError('runBot', e);
        }
    }

    function scheduleRetry() {
        if (state.retryTimer) clearTimeout(state.retryTimer);
        state.retryTimer = setTimeout(() => {
            state.retryTimer = null;
            if (state.isRunning) runBot().catch(e => captureError('scheduleRetry', e));
        }, RETRY_DELAY_MS);
    }

    function scheduleNext() {
        if (!state.isRunning) return;
        if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
        runBot().catch(e => captureError('scheduleNext.runBot', e)).then(() => {
            if (!state.isRunning) return;
            try {
                let interval;
                switch (state.currentMode) {
                    case '疯狂': interval = state.config.crazyInterval * 1000; break;
                    case '正常': interval = (Math.random() * (state.config.normalIntervalMax - state.config.normalIntervalMin) + state.config.normalIntervalMin) * 1000; break;
                    default: interval = state.config.zenInterval * 1000; break;
                }
                interval += Math.random() * 2000 - 1000;
                interval = Math.max(interval, MIN_SEND_INTERVAL_MS);
                state.nextSendTimestamp = Date.now() + interval;
                state.mainTimer = setTimeout(scheduleNext, interval);
            } catch (e) {
                captureError('scheduleNext.interval', e);
                state.mainTimer = setTimeout(scheduleNext, 5000);
            }
        });
    }

    function switchMode() {
        if (!state.isRunning) return;
        try {
            const dpm = getMessagesPerMinute();
            if (dpm > state.config.crazyModeDPM) state.currentMode = '疯狂';
            else if (dpm > state.config.normalModeDPM) state.currentMode = '正常';
            else state.currentMode = '佛系';
            if (!state.mainTimer) scheduleNext();
            addDebugLog('info', `切换模式: ${state.currentMode} (DPM=${dpm})`);
        } catch (e) {
            captureError('switchMode', e);
        }
    }

    function stopBot() {
        try {
            if (state.mainTimer) { clearTimeout(state.mainTimer); state.mainTimer = null; }
            if (state.countdownTimer) { clearInterval(state.countdownTimer); state.countdownTimer = null; }
            if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
            if (state.danmuObserver) { try { state.danmuObserver.disconnect(); } catch (_) {} state.danmuObserver = null; }
            state.currentMode = '关闭';
            state.candidateCount = 0;
            state.nextPreviewMsg = '';
            state.pendingMsg = null;
            state.retryCount = 0;
            state.lastRetryTime = 0;
            state.isSending = false;
            updateUIDisplay(getMessagesPerMinute());
            addDebugLog('info', '机器人已停止');
        } catch (e) { captureError('stopBot', e); }
    }

    // =============================== 主题应用 ===============================
    function applyTheme(theme) {
        if (!theme) return;
        const root = document.documentElement;
        root.style.setProperty('--bot-bg', theme.bgColor || '#1a1a2e');
        root.style.setProperty('--bot-text', theme.textColor || '#e0e0e0');
        root.style.setProperty('--bot-accent', theme.accentColor || '#ff9800');
        root.style.setProperty('--bot-border', theme.borderColor || 'rgba(255,255,255,0.06)');
        root.style.setProperty('--bot-opacity', theme.opacity || 0.95);
        root.style.setProperty('--bot-font-size', theme.fontSize || '12px');
        root.style.setProperty('--bot-radius', theme.borderRadius || '10px');
    }

    // =============================== 配置管理（含版本同步） ===============================
    function loadConfig() {
        try {
            const saved = GM_getValue(STORAGE_KEYS.CONFIG, {});
            state.config = { ...defaultConfig, ...saved };
            const theme = GM_getValue(STORAGE_KEYS.THEME, null);
            if (theme) state.config.theme = { ...defaultConfig.theme, ...theme };
            state.configVersion = GM_getValue(STORAGE_KEYS.CONFIG_VERSION, 0);
        } catch (_) {
            state.config = { ...defaultConfig };
            state.configVersion = 0;
        }
        try {
            state.blocklist = GM_getValue(STORAGE_KEYS.BLOCKLIST, []);
            clearBlockRegexCache();
        } catch (_) { state.blocklist = []; }
        try {
            state.priorityWords = GM_getValue(STORAGE_KEYS.PRIORITY, []);
        } catch (_) { state.priorityWords = []; }
        try {
            const rules = GM_getValue(STORAGE_KEYS.FILTER_RULES, []);
            state.config.filterRules = rules;
        } catch (_) { state.config.filterRules = []; }
        applyTheme(state.config.theme);
        updateUIValues();
        addDebugLog('info', '配置加载完成');
    }

    function saveConfigValue(key, value) {
        state.config[key] = value;
        GM_setValue(STORAGE_KEYS.CONFIG, state.config);
        if (key === 'filterRules') GM_setValue(STORAGE_KEYS.FILTER_RULES, value);
        state.configVersion = (state.configVersion || 0) + 1;
        GM_setValue(STORAGE_KEYS.CONFIG_VERSION, state.configVersion);
    }

    function saveTheme(theme) {
        state.config.theme = { ...state.config.theme, ...theme };
        GM_setValue(STORAGE_KEYS.THEME, state.config.theme);
        applyTheme(state.config.theme);
        state.configVersion = (state.configVersion || 0) + 1;
        GM_setValue(STORAGE_KEYS.CONFIG_VERSION, state.configVersion);
    }

    function parseFilterRules(text) {
        const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
        const rules = [];
        for (const line of lines) {
            let rule = null;
            if (line.startsWith('length>')) { const val = parseInt(line.substring(7)); if (!isNaN(val)) rule = { type: 'length', op: '>', value: val }; }
            else if (line.startsWith('length<')) { const val = parseInt(line.substring(7)); if (!isNaN(val)) rule = { type: 'length', op: '<', value: val }; }
            else if (line.startsWith('length>=')) { const val = parseInt(line.substring(8)); if (!isNaN(val)) rule = { type: 'length', op: '>=', value: val }; }
            else if (line.startsWith('length<=')) { const val = parseInt(line.substring(8)); if (!isNaN(val)) rule = { type: 'length', op: '<=', value: val }; }
            else if (line.startsWith('length==')) { const val = parseInt(line.substring(8)); if (!isNaN(val)) rule = { type: 'length', op: '==', value: val }; }
            else if (line.startsWith('contains:')) { const val = line.substring(9).trim(); if (val) rule = { type: 'contains', value: val }; }
            else if (line.startsWith('not_contains:')) { const val = line.substring(13).trim(); if (val) rule = { type: 'not_contains', value: val }; }
            else if (line.startsWith('regex:')) { const val = line.substring(6).trim(); if (val) rule = { type: 'regex', value: val }; }
            if (rule) rules.push(rule);
        }
        return rules;
    }

    function checkConfigUpdate() {
        try {
            const newVer = GM_getValue(STORAGE_KEYS.CONFIG_VERSION, 0);
            if (newVer !== state.configVersion) {
                state.configVersion = newVer;
                loadConfig();
                applyTheme(state.config.theme);
                updateUIDisplay(getMessagesPerMinute());
                console.log('[烂梗机] 配置已更新');
            }
        } catch (_) {}
    }

    // =============================== 调试日志 UI 更新 ===============================
    let debugConsoleUpdatePending = false;
    function updateDebugConsoleUI() {
        if (debugConsoleUpdatePending) return;
        debugConsoleUpdatePending = true;
        requestAnimationFrame(() => {
            debugConsoleUpdatePending = false;
            try {
                const container = document.querySelector('#settings-debug-list');
                if (!container) return;

                const errorLogs = state.debugLogs.filter(log => log.level === 'error').slice(-100);
                container.innerHTML = errorLogs.map(log =>
                    `<div style="border-bottom:1px solid var(--bot-border, rgba(255,255,255,0.06));padding:4px 0;display:flex;flex-wrap:wrap;gap:6px;font-size:11px;color:var(--bot-text, #e0e0e0);">
                        <span style="color:#888;">[${log.time}]</span>
                        <span style="color:#f44336;font-weight:bold;">ERROR</span>
                        <span style="color:var(--bot-text, #e0e0e0);word-break:break-all;flex:1;">${escapeHtml(log.content)}</span>
                    </div>`
                ).join('');

                if (container.scrollHeight > container.clientHeight) {
                    container.scrollTop = container.scrollHeight;
                }

                const badge = document.querySelector('#settings-debug-count');
                const errorCount = errorLogs.length;
                if (badge) {
                    badge.textContent = errorCount;
                    badge.style.display = errorCount > 0 ? 'inline-block' : 'none';
                }
            } catch (e) { captureError('updateDebugConsoleUI', e); }
        });
    }

    // =============================== 设置页（遮罩层）- 主题同步 ===============================
    function openSettingsPage() {
        const existing = document.getElementById('bot-settings-overlay');
        if (existing) { existing.remove(); return; }

        const overlay = document.createElement('div');
        overlay.id = 'bot-settings-overlay';
        overlay.style.cssText = `
position: fixed; top: 0; left: 0; width: 100%; height: 100%;
background: rgba(0,0,0,0.85); z-index: 100000;
display: flex; justify-content: center; align-items: center;
overflow-y: auto; padding: 20px; box-sizing: border-box;
`;

        const panel = document.createElement('div');
        panel.style.cssText = `
background: var(--bot-bg, #1a1a2e);
color: var(--bot-text, #e0e0e0);
max-width: 600px; width: 100%;
border-radius: var(--bot-radius, 12px);
padding: 20px; max-height: 90vh; overflow-y: auto;
border: 1px solid var(--bot-border, rgba(255,255,255,0.1));
font-size: var(--bot-font-size, 12px);
`;

        panel.innerHTML = buildSettingsHTMLContent();
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) overlay.remove();
        });

        overlay.addEventListener('click', function(e) {
            const target = e.target;
            if (target.id === 'settings-save-btn') {
                saveSettingsFromUI(overlay);
            } else if (target.id === 'settings-reset-btn') {
                resetSettingsUI(overlay);
            } else if (target.id === 'settings-close-btn') {
                overlay.remove();
            } else if (target.id === 'settings-debug-clear') {
                state.debugLogs = [];
                updateDebugConsoleUI();
                console.log('[烂梗机] 调试日志已清空');
            } else if (target.id === 'settings-debug-export') {
                const content = state.debugLogs.map(l => `[${l.time}] ${l.level.toUpperCase()}: ${l.content}`).join('\n');
                const blob = new Blob([content], { type: 'text/plain' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `bot_full_log_${Date.now()}.log`;
                a.click();
                URL.revokeObjectURL(a.href);
            }
        });
    }

    function buildSettingsHTMLContent() {
        const cfg = state.config;
        const theme = cfg.theme || defaultConfig.theme;
        const blocklist = state.blocklist.join(' / ');
        const priority = state.priorityWords.join(' / ');
        const rules = (cfg.filterRules || []).map(r => {
            if (r.type === 'length') return `length${r.op}${r.value}`;
            if (r.type === 'contains') return `contains:${r.value}`;
            if (r.type === 'not_contains') return `not_contains:${r.value}`;
            if (r.type === 'regex') return `regex:${r.value}`;
            return '';
        }).filter(Boolean).join('\n');

        return `
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
  <h2 style="margin:0;color:var(--bot-accent, #ff9800);font-size:calc(var(--bot-font-size, 12px) + 4px);">🤖 烂梗机设置</h2>
  <button id="settings-close-btn" style="background:transparent;border:none;color:#aaa;font-size:20px;cursor:pointer;">✕</button>
</div>
<div id="settings-save-msg" style="color:#4caf50;text-align:center;display:none;margin-bottom:8px;">✅ 已保存，将自动应用。</div>

<div class="settings-section" style="background:var(--bot-border, rgba(255,255,255,0.03));border-radius:6px;padding:10px 12px;margin-bottom:12px;border:1px solid var(--bot-border, rgba(255,255,255,0.08));">
  <h3 style="font-size:calc(var(--bot-font-size, 12px) + 1px);color:var(--bot-accent, #ff9800);margin:0 0 6px 0;">📝 弹幕设置</h3>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">最短长度</label>
    <input type="number" id="s-minLen" value="${cfg.minMsgLength}" min="1" max="50" style="background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:3px 5px;font-size:var(--bot-font-size, 12px);flex:1;min-width:50px;">
  </div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">长弹幕阈值</label>
    <input type="number" id="s-lenThres" value="${cfg.lengthThreshold}" min="5" max="100" style="background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:3px 5px;font-size:var(--bot-font-size, 12px);flex:1;min-width:50px;">
  </div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">长度加成</label>
    <input type="number" id="s-lenBonus" value="${cfg.lengthBonus}" min="1" max="10" step="0.5" style="background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:3px 5px;font-size:var(--bot-font-size, 12px);flex:1;min-width:50px;">
  </div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">趋势置顶</label>
    <input type="number" id="s-trending" value="${cfg.trendingThreshold}" min="2" max="50" style="background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:3px 5px;font-size:var(--bot-font-size, 12px);flex:1;min-width:50px;">
  </div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">去重窗口(秒)</label>
    <input type="number" id="s-dedupWindow" value="${cfg.dedupWindowSec}" min="0" max="600" step="5" style="background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:3px 5px;font-size:var(--bot-font-size, 12px);flex:1;min-width:50px;">
  </div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">历史去重(条)</label>
    <input type="number" id="s-dedupHistory" value="${cfg.dedupHistorySize}" min="0" max="100" style="background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:3px 5px;font-size:var(--bot-font-size, 12px);flex:1;min-width:50px;">
  </div>
</div>

<div class="settings-section" style="background:var(--bot-border, rgba(255,255,255,0.03));border-radius:6px;padding:10px 12px;margin-bottom:12px;border:1px solid var(--bot-border, rgba(255,255,255,0.08));">
  <h3 style="font-size:calc(var(--bot-font-size, 12px) + 1px);color:var(--bot-accent, #ff9800);margin:0 0 6px 0;">⚡ 模式设置</h3>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">疯狂阈值 DPM</label>
    <input type="number" id="s-crazyDpm" value="${cfg.crazyModeDPM}" min="10" style="background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:3px 5px;font-size:var(--bot-font-size, 12px);flex:1;min-width:50px;">
  </div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">疯狂间隔(秒)</label>
    <input type="number" id="s-crazyInterval" value="${cfg.crazyInterval}" min="1" style="background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:3px 5px;font-size:var(--bot-font-size, 12px);flex:1;min-width:50px;">
  </div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">正常阈值 DPM</label>
    <input type="number" id="s-normalDpm" value="${cfg.normalModeDPM}" min="10" style="background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:3px 5px;font-size:var(--bot-font-size, 12px);flex:1;min-width:50px;">
  </div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">佛系间隔(秒)</label>
    <input type="number" id="s-zenInterval" value="${cfg.zenInterval}" min="1" style="background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:3px 5px;font-size:var(--bot-font-size, 12px);flex:1;min-width:50px;">
  </div>
</div>

<div class="settings-section" style="background:var(--bot-border, rgba(255,255,255,0.03));border-radius:6px;padding:10px 12px;margin-bottom:12px;border:1px solid var(--bot-border, rgba(255,255,255,0.08));">
  <h3 style="font-size:calc(var(--bot-font-size, 12px) + 1px);color:var(--bot-accent, #ff9800);margin:0 0 6px 0;">🚫 屏蔽词 & 高级筛选</h3>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">屏蔽词</label>
    <textarea id="s-blocklist" rows="2" style="width:100%;background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:4px;font-size:var(--bot-font-size, 12px);resize:vertical;box-sizing:border-box;">${blocklist}</textarea>
  </div>
  <div style="font-size:calc(var(--bot-font-size, 12px) - 2px);color:#666;margin-top:2px;">用斜杠 / 分隔，支持正则 /广告/</div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;margin-top:6px;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">筛选规则</label>
    <textarea id="s-filterRules" rows="3" style="width:100%;background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:4px;font-size:var(--bot-font-size, 12px);resize:vertical;box-sizing:border-box;">${rules}</textarea>
  </div>
  <div style="font-size:calc(var(--bot-font-size, 12px) - 2px);color:#666;margin-top:2px;">每行一条，如 length>10, contains:哈哈, regex:/^\\d+$/</div>
</div>

<div class="settings-section" style="background:var(--bot-border, rgba(255,255,255,0.03));border-radius:6px;padding:10px 12px;margin-bottom:12px;border:1px solid var(--bot-border, rgba(255,255,255,0.08));">
  <h3 style="font-size:calc(var(--bot-font-size, 12px) + 1px);color:var(--bot-accent, #ff9800);margin:0 0 6px 0;">⭐ 优先词</h3>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">启用</label>
    <input type="checkbox" id="s-priorityEnabled" ${cfg.priorityEnabled ? 'checked' : ''} style="width:auto;">
  </div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">优先词</label>
    <textarea id="s-priorityWords" rows="2" style="width:100%;background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:4px;font-size:var(--bot-font-size, 12px);resize:vertical;box-sizing:border-box;">${priority}</textarea>
  </div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">权重加成</label>
    <input type="number" id="s-priorityWeight" value="${cfg.priorityWeight}" min="1" max="20" step="0.5" style="background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:3px 5px;font-size:var(--bot-font-size, 12px);flex:1;min-width:50px;">
  </div>
  <div style="font-size:calc(var(--bot-font-size, 12px) - 2px);color:#666;margin-top:2px;">用斜杠 / 分隔，支持正则</div>
</div>

<!-- 外观设置 - 颜色选择器强制白色背景 -->
<div class="settings-section" style="background:var(--bot-border, rgba(255,255,255,0.03));border-radius:6px;padding:10px 12px;margin-bottom:12px;border:1px solid var(--bot-border, rgba(255,255,255,0.08));">
  <h3 style="font-size:calc(var(--bot-font-size, 12px) + 1px);color:var(--bot-accent, #ff9800);margin:0 0 6px 0;">🎨 外观设置</h3>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">背景色</label>
    <input type="color" id="s-bgColor" value="${theme.bgColor}" style="background:#fff;border:2px solid var(--bot-accent, #ff9800);border-radius:4px;padding:2px;width:40px;height:40px;cursor:pointer;">
  </div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">文字颜色</label>
    <input type="color" id="s-textColor" value="${theme.textColor}" style="background:#fff;border:2px solid var(--bot-accent, #ff9800);border-radius:4px;padding:2px;width:40px;height:40px;cursor:pointer;">
  </div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">强调色</label>
    <input type="color" id="s-accentColor" value="${theme.accentColor}" style="background:#fff;border:2px solid var(--bot-accent, #ff9800);border-radius:4px;padding:2px;width:40px;height:40px;cursor:pointer;">
  </div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">边框颜色</label>
    <input type="color" id="s-borderColor" value="${theme.borderColor}" style="background:#fff;border:2px solid var(--bot-accent, #ff9800);border-radius:4px;padding:2px;width:40px;height:40px;cursor:pointer;">
  </div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">透明度</label>
    <input type="number" id="s-opacity" value="${theme.opacity}" min="0.5" max="1" step="0.05" style="background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:3px 5px;font-size:var(--bot-font-size, 12px);flex:1;min-width:50px;">
  </div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">字体大小</label>
    <input type="text" id="s-fontSize" value="${theme.fontSize}" style="background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:3px 5px;font-size:var(--bot-font-size, 12px);flex:1;min-width:50px;">
  </div>
  <div class="row" style="display:flex;align-items:center;margin-bottom:4px;gap:6px;flex-wrap:wrap;">
    <label style="width:80px;font-size:var(--bot-font-size, 12px);color:var(--bot-text, #aaa);flex-shrink:0;">圆角</label>
    <input type="text" id="s-borderRadius" value="${theme.borderRadius}" style="background:var(--bot-border, rgba(255,255,255,0.06));border:1px solid var(--bot-border, rgba(255,255,255,0.12));color:var(--bot-text, #eee);border-radius:4px;padding:3px 5px;font-size:var(--bot-font-size, 12px);flex:1;min-width:50px;">
  </div>
</div>

<!-- 🐛 调试日志区域 -->
<div class="settings-section" style="background:var(--bot-border, rgba(255,255,255,0.03));border-radius:6px;padding:10px 12px;margin-bottom:12px;border:1px solid var(--bot-border, rgba(255,255,255,0.08));">
  <h3 style="font-size:calc(var(--bot-font-size, 12px) + 1px);color:var(--bot-accent, #ff9800);margin:0 0 6px 0;">
    🐛 错误日志 <span id="settings-debug-count" style="background:var(--bot-accent, #ff9800);color:var(--bot-bg, #1a1a2e);border-radius:10px;padding:0 8px;font-size:calc(var(--bot-font-size, 12px) - 2px);display:none;">0</span>
  </h3>
  <div style="display:flex;gap:8px;margin-bottom:8px;">
    <button id="settings-debug-clear" style="background:var(--bot-border, #2c2c3a);border:none;color:var(--bot-text, #ccc);padding:4px 10px;border-radius:4px;cursor:pointer;font-size:calc(var(--bot-font-size, 12px) - 1px);">清空日志</button>
    <button id="settings-debug-export" style="background:var(--bot-border, #2c2c3a);border:none;color:var(--bot-text, #ccc);padding:4px 10px;border-radius:4px;cursor:pointer;font-size:calc(var(--bot-font-size, 12px) - 1px);">导出日志</button>
  </div>
  <div id="settings-debug-list" style="background:var(--bot-border, rgba(255,255,255,0.03));border-radius:6px;padding:6px;max-height:200px;overflow-y:auto;font-family:monospace;font-size:calc(var(--bot-font-size, 12px) - 1px);"></div>
  <div style="font-size:calc(var(--bot-font-size, 12px) - 2px);color:#666;margin-top:2px;">仅显示错误，完整日志可导出</div>
</div>

<div style="display:flex;gap:10px;justify-content:center;margin-top:16px;">
  <button id="settings-save-btn" style="background:var(--bot-accent, #ff9800);color:var(--bot-bg, #1a1a2e);border:none;padding:8px 24px;border-radius:4px;font-weight:bold;cursor:pointer;font-size:var(--bot-font-size, 12px);">💾 保存</button>
  <button id="settings-reset-btn" style="background:var(--bot-border, #333);color:var(--bot-text, #fff);border:none;padding:8px 24px;border-radius:4px;cursor:pointer;font-size:var(--bot-font-size, 12px);">↩️ 重置</button>
</div>`;
    }

    function saveSettingsFromUI(overlay) {
        function getVal(id) { const el = overlay.querySelector('#' + id); return el ? el.value : ''; }
        function getNum(id) { return parseFloat(getVal(id)) || 0; }
        function getBool(id) { const el = overlay.querySelector('#' + id); return el ? el.checked : false; }
        function getText(id) { return getVal(id); }

        const config = {
            minMsgLength: getNum('s-minLen'),
            lengthThreshold: getNum('s-lenThres'),
            lengthBonus: getNum('s-lenBonus'),
            trendingThreshold: getNum('s-trending'),
            dedupWindowSec: getNum('s-dedupWindow'),
            dedupHistorySize: getNum('s-dedupHistory'),
            crazyModeDPM: getNum('s-crazyDpm'),
            crazyInterval: getNum('s-crazyInterval'),
            normalModeDPM: getNum('s-normalDpm'),
            zenInterval: getNum('s-zenInterval'),
            priorityEnabled: getBool('s-priorityEnabled'),
            priorityWeight: getNum('s-priorityWeight'),
            filterRules: parseFilterRules(getText('s-filterRules')),
        };

        const blockRaw = getText('s-blocklist');
        const blockSep = blockRaw.includes('/') ? '/' : ',';
        const blocklist = blockRaw.split(blockSep).map(s => s.trim()).filter(Boolean);

        const priRaw = getText('s-priorityWords');
        const priSep = priRaw.includes('/') ? '/' : ',';
        const priorityWords = priRaw.split(priSep).map(s => s.trim()).filter(Boolean);

        const theme = {
            bgColor: getVal('s-bgColor'),
            textColor: getVal('s-textColor'),
            accentColor: getVal('s-accentColor'),
            borderColor: getVal('s-borderColor'),
            opacity: getNum('s-opacity'),
            fontSize: getVal('s-fontSize') || '12px',
            borderRadius: getVal('s-borderRadius') || '10px',
        };

        for (const [key, value] of Object.entries(config)) {
            if (key !== 'filterRules') {
                saveConfigValue(key, value);
            }
        }
        saveConfigValue('filterRules', config.filterRules);

        GM_setValue(STORAGE_KEYS.BLOCKLIST, blocklist);
        state.blocklist = blocklist;
        clearBlockRegexCache();

        GM_setValue(STORAGE_KEYS.PRIORITY, priorityWords);
        state.priorityWords = priorityWords;

        saveTheme(theme);

        applyTheme(theme);
        updateUIDisplay(getMessagesPerMinute());

        const msg = overlay.querySelector('#settings-save-msg');
        if (msg) { msg.style.display = 'block'; setTimeout(() => msg.style.display = 'none', 3000); }
    }

    function resetSettingsUI(overlay) {
        const def = defaultConfig;
        const defTheme = defaultConfig.theme;
        const setVal = (id, val) => { const el = overlay.querySelector('#' + id); if (el) el.value = val; };
        const setBool = (id, val) => { const el = overlay.querySelector('#' + id); if (el) el.checked = val; };
        setVal('s-minLen', def.minMsgLength);
        setVal('s-lenThres', def.lengthThreshold);
        setVal('s-lenBonus', def.lengthBonus);
        setVal('s-trending', def.trendingThreshold);
        setVal('s-dedupWindow', def.dedupWindowSec);
        setVal('s-dedupHistory', def.dedupHistorySize);
        setVal('s-crazyDpm', def.crazyModeDPM);
        setVal('s-crazyInterval', def.crazyInterval);
        setVal('s-normalDpm', def.normalModeDPM);
        setVal('s-zenInterval', def.zenInterval);
        setBool('s-priorityEnabled', def.priorityEnabled);
        setVal('s-priorityWeight', def.priorityWeight);
        setVal('s-blocklist', '');
        setVal('s-priorityWords', '');
        setVal('s-filterRules', '');
        setVal('s-bgColor', defTheme.bgColor);
        setVal('s-textColor', defTheme.textColor);
        setVal('s-accentColor', defTheme.accentColor);
        setVal('s-borderColor', defTheme.borderColor);
        setVal('s-opacity', defTheme.opacity);
        setVal('s-fontSize', defTheme.fontSize);
        setVal('s-borderRadius', defTheme.borderRadius);
    }

    // =============================== 主面板 UI ===============================
    function createUI() {
        document.body.insertAdjacentHTML('beforeend', `
<div id="bot-panel" class="bot-panel-collapsed">
  <div id="bot-panel-header">
    <span class="bot-header-icon">🤖</span> 烂梗机
    <button id="bot-settings-btn" style="background:transparent;border:none;color:var(--bot-accent, #ff9800);cursor:pointer;font-size:14px;">⚙️</button>
  </div>
  <div id="bot-panel-content">
    <div class="bot-section">
      <div class="bot-status-grid">
        <div class="bot-status-item"><div class="bot-status-label">模式</div><div class="bot-status-value" id="bot-status-mode">关闭</div></div>
        <div class="bot-status-item"><div class="bot-status-label">DPM</div><div class="bot-status-value bot-mono" id="bot-status-dpm">0</div></div>
        <div class="bot-status-item"><div class="bot-status-label">候选</div><div class="bot-status-value bot-mono" id="bot-status-candidates">0</div></div>
        <div class="bot-status-item"><div class="bot-status-label">倒计时</div><div class="bot-status-value bot-mono" id="bot-status-countdown">--</div></div>
      </div>
      <div class="bot-last-sent" id="bot-last-sent"><span class="bot-last-sent-prefix">上次:</span><span class="bot-last-sent-text" id="bot-last-sent-text">--</span></div>
      <div class="bot-next-preview" id="bot-next-preview"><span class="bot-last-sent-prefix">下次:</span><span class="bot-last-sent-text" id="bot-next-preview-text">--</span></div>
    </div>
    <div class="bot-row bot-center">
      <label class="bot-switch"><input type="checkbox" id="bot-toggle-switch"><span class="bot-slider"></span></label>
    </div>
    <div id="bot-error-summary" style="font-size:10px;color:#f44336;text-align:center;margin-top:4px;display:none;">⚠️ 有错误，请查看日志</div>
  </div>
</div>`);
        injectStyles();
        addPanelEventListeners();
    }

    function injectStyles() {
        GM_addStyle(`
:root {
    --bot-bg: #1a1a2e;
    --bot-text: #e0e0e0;
    --bot-accent: #ff9800;
    --bot-border: rgba(255,255,255,0.06);
    --bot-opacity: 0.95;
    --bot-font-size: 12px;
    --bot-radius: 10px;
}
#bot-panel {
    position: fixed; bottom: 80px; right: 20px; z-index: 99999;
    background: var(--bot-bg);
    color: var(--bot-text);
    border-radius: var(--bot-radius);
    box-shadow: 0 6px 24px rgba(0,0,0,0.7), 0 0 0 1px var(--bot-border);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: var(--bot-font-size);
    width: 240px;
    user-select: none;
    opacity: var(--bot-opacity);
    transition: opacity 0.3s;
}
#bot-panel:hover { opacity: 1; }
#bot-panel-header {
    padding: 8px 12px;
    background: var(--bot-border);
    cursor: grab;
    border-radius: var(--bot-radius) var(--bot-radius) 0 0;
    text-align: center;
    font-weight: 600;
    font-size: 13px;
    color: var(--bot-accent);
    border-bottom: 1px solid var(--bot-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
}
#bot-panel-header:active { cursor: grabbing; }
#bot-settings-btn:hover { color: #fff; }
.bot-header-icon { font-size: 14px; }
#bot-panel.bot-panel-collapsed #bot-panel-content { display: none; }
#bot-panel.bot-panel-collapsed #bot-panel-header { border-radius: var(--bot-radius); border-bottom: none; }
#bot-panel-content { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 2px; }
.bot-status-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 0; margin-bottom: 6px; }
.bot-status-item { display: flex; flex-direction: column; align-items: center; padding: 4px 2px; background: rgba(255,255,255,0.03); border-radius: 4px; }
.bot-status-label { font-size: 9px; color: #888; text-transform: uppercase; letter-spacing: 0.3px; }
.bot-status-value { font-size: 13px; font-weight: 700; }
.bot-mono { font-family: "SF Mono", "Fira Code", monospace; }
.bot-status-value.mode-off { color: #666; }
.bot-status-value.mode-zen { color: #4caf50; }
.bot-status-value.mode-normal { color: var(--bot-accent); }
.bot-status-value.mode-crazy { color: #f44336; }
.bot-last-sent, .bot-next-preview {
    background: rgba(255,255,255,0.04);
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 10px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    border-left: 3px solid #555;
    margin-top: 2px;
}
.bot-last-sent.has-content { border-left-color: var(--bot-accent); }
.bot-next-preview.has-content { border-left-color: #4caf50; }
.bot-last-sent-prefix { color: #777; margin-right: 4px; }
.bot-last-sent-text { color: #ccc; }
.bot-row { display: flex; align-items: center; margin-bottom: 4px; }
.bot-center { justify-content: center; margin: 4px 0 2px; }
.bot-switch { position: relative; display: inline-block; width: 44px; height: 24px; }
.bot-switch input { opacity: 0; width: 0; height: 0; }
.bot-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #444; transition: .3s; border-radius: 24px; }
.bot-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: #ccc; transition: .3s; border-radius: 50%; }
input:checked + .bot-slider { background-color: var(--bot-accent); }
input:checked + .bot-slider:before { transform: translateX(20px); background-color: #fff; }
#bot-panel.bot-panel-fshidden { display: none !important; }
`);
    }

    function addPanelEventListeners() {
        const toggle = $('bot-toggle-switch');
        if (toggle) {
            toggle.addEventListener('change', e => {
                state.isRunning = e.target.checked;
                if (state.isRunning) switchMode();
                else stopBot();
            });
        }

        const settingsBtn = $('bot-settings-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                openSettingsPage();
            });
        }

        setupDrag();
    }

    // =============================== 拖拽修复（统一 left/top） ===============================
    function setupDrag() {
        const panel = $('bot-panel');
        const header = $('bot-panel-header');
        if (!panel || !header) return;

        let isDragging = false;
        let startX, startY, startRect;
        let offsetX = 0, offsetY = 0;

        header.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();

            const rect = panel.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            startRect = { left: rect.left, top: rect.top };

            panel.style.transform = '';
            panel.style.left = rect.left + 'px';
            panel.style.top = rect.top + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';

            isDragging = false;
            offsetX = 0;
            offsetY = 0;

            const onMove = (ev) => {
                offsetX = ev.clientX - startX;
                offsetY = ev.clientY - startY;
                if (Math.abs(offsetX) > 3 || Math.abs(offsetY) > 3) isDragging = true;
                if (!isDragging) return;

                panel.style.left = (startRect.left + offsetX) + 'px';
                panel.style.top = (startRect.top + offsetY) + 'px';
            };

            const onUp = (ev) => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);

                const isSettingsBtn = ev.target.closest('#bot-settings-btn');

                if (isDragging) {
                    GM_setValue(STORAGE_KEYS.PANEL_POS, {
                        left: panel.style.left,
                        top: panel.style.top
                    });
                } else if (!isSettingsBtn) {
                    panel.classList.toggle('bot-panel-collapsed');
                }
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    function updateUIValues() {
        // 用于初始化时填充 UI，但设置页是动态生成的，所以留空
    }

    function updateUIDisplay(dpm) {
        try {
            const modeEl = $('bot-status-mode');
            if (!modeEl) return;
            const hasErr = state.errors.length > 0;
            modeEl.textContent = hasErr ? '错误' : state.currentMode;
            modeEl.className = 'bot-status-value';
            if (hasErr) modeEl.classList.add('mode-crazy');
            else if (state.currentMode === '疯狂') modeEl.classList.add('mode-crazy');
            else if (state.currentMode === '正常') modeEl.classList.add('mode-normal');
            else if (state.currentMode === '佛系') modeEl.classList.add('mode-zen');
            else modeEl.classList.add('mode-off');

            $('bot-status-dpm').textContent = dpm;
            $('bot-status-candidates').textContent = state.candidateCount;

            const lastWrap = $('bot-last-sent');
            const lastText = $('bot-last-sent-text');
            if (lastWrap && lastText) {
                if (state.lastSentMsg) {
                    lastWrap.classList.add('has-content');
                    lastText.textContent = state.lastSentMsg.length > 18 ? state.lastSentMsg.slice(0, 18) + '...' : state.lastSentMsg;
                    lastWrap.title = state.lastSentMsg;
                } else {
                    lastWrap.classList.remove('has-content');
                    lastText.textContent = '--';
                    lastWrap.title = '';
                }
            }

            const nextWrap = $('bot-next-preview');
            const nextText = $('bot-next-preview-text');
            if (nextWrap && nextText) {
                if (state.nextPreviewMsg && state.isRunning) {
                    nextWrap.classList.add('has-content');
                    nextText.textContent = state.nextPreviewMsg.length > 18 ? state.nextPreviewMsg.slice(0, 18) + '...' : state.nextPreviewMsg;
                    nextWrap.title = state.nextPreviewMsg;
                } else {
                    nextWrap.classList.remove('has-content');
                    nextText.textContent = '--';
                    nextWrap.title = '';
                }
            }

            if (state.countdownTimer) { clearInterval(state.countdownTimer); state.countdownTimer = null; }
            const cdEl = $('bot-status-countdown');
            if (cdEl) {
                if (state.isRunning && state.nextSendTimestamp > 0) {
                    const tick = () => {
                        try {
                            const now = Date.now();
                            if (now >= state.nextSendTimestamp) cdEl.textContent = '发送中';
                            else cdEl.textContent = ((state.nextSendTimestamp - now) / 1000).toFixed(1) + 's';
                        } catch (_) {}
                    };
                    tick();
                    state.countdownTimer = setInterval(tick, 100);
                } else {
                    cdEl.textContent = '--';
                }
            }
        } catch (e) { captureError('updateUIDisplay', e); }
    }

    function loadPanelPosition() {
        try {
            const panel = $('bot-panel');
            if (!panel) return;
            const pos = GM_getValue(STORAGE_KEYS.PANEL_POS, null);
            if (pos && pos.left && pos.top) {
                panel.style.left = pos.left;
                panel.style.top = pos.top;
                panel.style.bottom = 'auto';
                panel.style.right = 'auto';
            }
        } catch (_) {}
    }

    // =============================== 实例化 ===============================
    const probe = new SelectorProbe(PLATFORM);
    const parser = new PlatformParser(PLATFORM, probe);
    const sender = new PlatformSender(PLATFORM, parser);

    // =============================== 初始化 ===============================
    function init() {
        console.log('[烂梗机] 初始化 v1.1.5');
        createUI();
        loadConfig();
        loadPanelPosition();

        probe.probeAll();
        parser.refreshSelectors();

        let poll = 0;
        const tryFind = setInterval(() => {
            poll++;
            try {
                const container = parser.findContainer();
                if (container) {
                    clearInterval(tryFind);
                    state.containerElement = container;
                    startDanmuObserver(container);
                    scheduleWeightUpdate();
                    return;
                }
                if (poll >= CONTAINER_POLL_MAX) {
                    clearInterval(tryFind);
                    console.warn('[烂梗机] 弹幕容器查找超时，监听整个文档');
                    addDebugLog('warn', '弹幕容器查找超时，监听整个文档');
                    state.containerElement = document.body;
                    startDanmuObserver(document.body);
                }
            } catch (e) {
                captureError('tryFind', e);
            }
        }, CONTAINER_POLL_INTERVAL);

        setInterval(() => {
            checkConfigUpdate();
            if (state.isRunning) switchMode();
            const candidates = getWeightedMessages();
            state.nextPreviewMsg = candidates[0]?.text || '';
            updateUIDisplay(getMessagesPerMinute());
        }, UI_UPDATE_INTERVAL);

        setInterval(() => {
            try { sender.refreshCache(); } catch (_) {}
        }, 30000);

        const updateFullscreen = () => {
            try {
                const panel = $('bot-panel');
                if (!panel) return;
                const stdFS = !!document.fullscreenElement;
                const webFS = document.body.classList.contains('player-fullscreen') ||
                    document.querySelector('.layout-Player-barrageStage.fullscreen');
                panel.classList.toggle('bot-panel-fshidden', stdFS || webFS);
            } catch (_) {}
        };
        document.addEventListener('fullscreenchange', updateFullscreen);
        setInterval(updateFullscreen, 1500);

        document.addEventListener('visibilitychange', () => {
            try {
                if (!document.hidden && state.isRunning) {
                    state.timestamps = state.timestamps.filter(ts => ts > Date.now() - DPM_WINDOW_MS);
                    scheduleWeightUpdate();
                }
            } catch (_) {}
        });
    }

    setTimeout(init, 3000);
})();