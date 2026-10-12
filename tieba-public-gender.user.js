// ==UserScript==
// @name         百度贴吧公开性别标记
// @namespace    local.tieba-public-gender
// @version      1.0.0
// @description  在帖子昵称旁显示用户公开资料中的性别；未公开或无法获取时显示未知。
// @homepageURL  https://github.com/shiluodeqiou/tieba-public-gender
// @supportURL   https://github.com/shiluodeqiou/tieba-public-gender/issues
// @updateURL    https://raw.githubusercontent.com/shiluodeqiou/tieba-public-gender/main/tieba-public-gender.user.js
// @downloadURL  https://raw.githubusercontent.com/shiluodeqiou/tieba-public-gender/main/tieba-public-gender.user.js
// @match        https://tieba.baidu.com/p/*
// @match        http://tieba.baidu.com/p/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      tieba.baidu.com
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = Object.freeze({
        endpoint: 'https://tieba.baidu.com/home/get/panel',
        cacheKey: 'tieba-public-gender:cache:v1',
        showUnknownKey: 'tieba-public-gender:show-unknown',
        knownTtlMs: 24 * 60 * 60 * 1000,
        unknownTtlMs: 60 * 60 * 1000,
        errorTtlMs: 5 * 60 * 1000,
        timeoutMs: 10 * 1000,
        intervalMs: 900,
        concurrency: 2,
        cooldownMs: 60 * 1000,
        maxCacheEntries: 500,
        scanDelayMs: 120
    });
    const BADGE_CLASS = 'tb-public-gender-badge';
    // 楼中楼只选正文的第一个用户链接，排除头像、被回复者和正文中的 @ 提及。
    const NAME_SELECTOR = [
        'a.p_author_name',
        '.lzl_cnt > a.j_user_card:first-child',
        '.lzl_cnt > a.at:first-child'
    ].join(',');
    const REASONS = Object.freeze({
        'not-public': '用户未公开可识别的性别资料',
        'missing-identity': '页面未提供可靠的账号名，未使用显示昵称猜测',
        'identity-mismatch': '资料返回的账号与请求账号不一致，已忽略',
        'unexpected-value': '接口返回了未支持的性别值，已忽略',
        'api-error': '贴吧资料接口未返回成功结果',
        'invalid-response': '资料接口未返回预期的 JSON，可能需要验证',
        'rate-limited': '贴吧限制了请求频率，已暂停新请求一分钟',
        'access-denied': '公开资料接口拒绝访问，未尝试使用登录凭据',
        'http-error': '公开资料接口暂时不可用',
        'network-error': '网络请求失败或油猴未允许请求',
        timeout: '公开资料请求超时',
        cooldown: '接口暂时不可用，正在等待恢复',
        redirected: '资料请求被重定向到其他地址，已忽略'
    });

    function unknown(reason) {
        return { gender: 'unknown', reason };
    }

    function validUsername(value) {
        // 不 trim 或改写账号，以免查到另一个用户；拒绝空值和控制字符。
        return typeof value === 'string' && value.trim() !== '' &&
            value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
    }

    function readField(element) {
        try {
            const field = JSON.parse(element?.getAttribute('data-field') || 'null');
            return field && typeof field === 'object' && !Array.isArray(field) ? field : {};
        } catch {
            return {};
        }
    }

    function extractUsername(anchor) {
        const direct = readField(anchor);
        const directName = [direct.un, direct.user_name, anchor.getAttribute('username')]
            .find(validUsername);
        if (directName) return directName;

        const reply = anchor.closest('.lzl_single_post');
        if (reply) {
            const name = readField(reply).user_name;
            // 不能回退到外层主楼作者，否则会把楼中楼作者标为主楼作者。
            if (validUsername(name)) return name;
        } else {
            const author = readField(anchor.closest('.l_post')).author;
            if (author && validUsername(author.user_name)) return author.user_name;
        }

        try {
            const url = new URL(anchor.getAttribute('href') || '', 'https://tieba.baidu.com');
            if (url.hostname === 'tieba.baidu.com' && url.pathname === '/home/main') {
                const name = url.searchParams.get('un');
                if (validUsername(name)) return name;
            }
        } catch { /* 无效链接按未知处理。 */ }
        return null;
    }

    function buildProfileUrl(username) {
        if (!validUsername(username)) throw new TypeError('无效账号名');
        const url = new URL(CONFIG.endpoint);
        url.searchParams.set('ie', 'utf-8');
        url.searchParams.set('un', username);
        return url.href;
    }

    function parsePanelResponse(payload, username) {
        if (!payload || typeof payload !== 'object' ||
            (payload.no !== 0 && payload.no !== '0')) return unknown('api-error');
        const data = payload.data;
        if (!data || typeof data !== 'object' || Array.isArray(data)) return unknown('api-error');
        // 当前接口的 data.name 是账号名，data.name_show/show_nickname 是显示昵称。
        // 必须有账号名且完全匹配；不把第三方或错误账号的资料展示给当前作者。
        if (!validUsername(data.name) || data.name !== username) return unknown('identity-mismatch');
        if ([1, '1', true].includes(data.is_private)) return unknown('not-public');
        if (data.sex === 'male' || data.sex === 'female') {
            return { gender: data.sex, reason: 'public' };
        }
        if (data.sex == null || data.sex === '' || data.sex === 'unknown' || data.sex === '0' || data.sex === 0) {
            return unknown('not-public');
        }
        // 只采用此接口已核实的字符串枚举；不套用其他接口的 1/2 数字含义。
        return unknown('unexpected-value');
    }

    function createCache({ initial, now = Date.now, maxEntries = CONFIG.maxCacheEntries } = {}) {
        const entries = new Map();
        if (initial?.version === 1 && Array.isArray(initial.entries)) {
            for (const entry of initial.entries.slice(-maxEntries)) {
                if (!Array.isArray(entry) || entry.length !== 2) continue;
                const [name, value] = entry;
                const validResult = value && (
                    ((value.gender === 'male' || value.gender === 'female') && value.reason === 'public') ||
                    (value.gender === 'unknown' && Object.hasOwn(REASONS, value.reason))
                );
                if (validUsername(name) && validResult && Number.isFinite(value.expiresAt) &&
                    value.expiresAt > now() && value.expiresAt <= now() + CONFIG.knownTtlMs) {
                    entries.set(name, value);
                }
            }
        }
        function prune() {
            for (const [name, entry] of entries) {
                if (entry.expiresAt <= now()) entries.delete(name);
            }
            while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
        }
        return {
            get(name) {
                const entry = entries.get(name);
                if (!entry) return null;
                if (entry.expiresAt <= now()) {
                    entries.delete(name);
                    return null;
                }
                return { gender: entry.gender, reason: entry.reason };
            },
            set(name, result) {
                const ttl = result.reason === 'public' ? CONFIG.knownTtlMs :
                    ['not-public', 'unexpected-value'].includes(result.reason) ?
                        CONFIG.unknownTtlMs : CONFIG.errorTtlMs;
                entries.delete(name);
                entries.set(name, { ...result, expiresAt: now() + ttl });
                prune();
            },
            clear() { entries.clear(); },
            snapshot() {
                prune();
                return { version: 1, entries: Array.from(entries) };
            }
        };
    }

    function createQueue({ concurrency = CONFIG.concurrency, intervalMs = CONFIG.intervalMs,
        now = Date.now, setTimer = setTimeout } = {}) {
        const tasks = [];
        let active = 0;
        let nextStart = 0;
        let timer = null;
        function pump() {
            if (timer !== null || active >= concurrency || tasks.length === 0) return;
            const wait = Math.max(0, nextStart - now());
            if (wait > 0) {
                timer = setTimer(() => { timer = null; pump(); }, wait);
                return;
            }
            const task = tasks.shift();
            active += 1;
            nextStart = now() + intervalMs;
            Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => {
                active -= 1;
                pump();
            });
            pump();
        }
        return (run) => new Promise((resolve, reject) => {
            tasks.push({ run, resolve, reject });
            pump();
        });
    }

    function requestGender(username, gmRequest, { timeoutMs = CONFIG.timeoutMs,
        setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
        return new Promise((resolve) => {
            let settled = false;
            let handle;
            let timer;
            function finish(result) {
                if (settled) return;
                settled = true;
                clearTimer(timer);
                resolve(result);
            }
            // anonymous 会使用 fetch 模式；部分浏览器不执行 GM 的 timeout，故另设计时器。
            timer = setTimer(() => {
                finish(unknown('timeout'));
                try { handle?.abort(); } catch { /* 已完成或扩展不支持取消。 */ }
            }, timeoutMs);
            try {
                handle = gmRequest({
                    method: 'GET',
                    url: buildProfileUrl(username),
                    anonymous: true,
                    timeout: timeoutMs,
                    headers: { Accept: 'application/json' },
                    onload(response) {
                        if (settled) return;
                        if (response.status === 429) return finish(unknown('rate-limited'));
                        if (response.status === 401 || response.status === 403) return finish(unknown('access-denied'));
                        if (response.status !== 200) return finish(unknown('http-error'));
                        try {
                            const finalUrl = new URL(response.finalUrl || CONFIG.endpoint);
                            if (finalUrl.origin !== 'https://tieba.baidu.com' ||
                                finalUrl.pathname !== '/home/get/panel') return finish(unknown('redirected'));
                            const payload = JSON.parse(response.responseText);
                            finish(parsePanelResponse(payload, username));
                        } catch {
                            finish(unknown('invalid-response'));
                        }
                    },
                    onerror: () => finish(unknown('network-error')),
                    ontimeout: () => finish(unknown('timeout')),
                    onabort: () => finish(unknown('network-error'))
                });
            } catch {
                finish(unknown('network-error'));
            }
        });
    }

    function createLookup({ cache, request, enqueue, onCacheChange = () => {},
        now = Date.now } = {}) {
        const pending = new Map();
        let blockedUntil = 0;
        return (name) => {
            const saved = cache.get(name);
            if (saved) return Promise.resolve(saved);
            if (pending.has(name)) return pending.get(name);
            const promise = enqueue(async () => {
                const result = now() < blockedUntil ? unknown('cooldown') : await request(name);
                if (['rate-limited', 'access-denied', 'invalid-response', 'redirected'].includes(result.reason)) {
                    blockedUntil = now() + CONFIG.cooldownMs;
                }
                cache.set(name, result);
                onCacheChange();
                return result;
            }).catch(() => unknown('network-error')).finally(() => pending.delete(name));
            pending.set(name, promise);
            return promise;
        };
    }

    function bootstrap(env = globalThis, options = {}) {
        const doc = env.document;
        if (!doc?.body || env.location.hostname !== 'tieba.baidu.com' ||
            !/^\/p\/\d+\/?$/.test(env.location.pathname)) return null;
        const getValue = (key, fallback) => {
            try { return env.GM_getValue(key, fallback); } catch { return fallback; }
        };
        const setValue = (key, value) => {
            try { env.GM_setValue(key, value); } catch { /* 禁用存储时仍可临时工作。 */ }
        };
        let showUnknown = getValue(CONFIG.showUnknownKey, true) !== false;
        const cache = createCache({ initial: getValue(CONFIG.cacheKey, null) });
        const enqueue = createQueue({ ...options.queue,
            setTimer: env.setTimeout.bind(env) });
        let saveTimer = null;
        const save = () => {
            if (saveTimer !== null) env.clearTimeout(saveTimer);
            saveTimer = env.setTimeout(() => {
                saveTimer = null;
                setValue(CONFIG.cacheKey, cache.snapshot());
            }, 250);
        };
        const lookup = createLookup({ cache, enqueue, onCacheChange: save,
            request: (name) => requestGender(name, env.GM_xmlhttpRequest, {
                setTimer: env.setTimeout.bind(env), clearTimer: env.clearTimeout.bind(env)
            }) });
        const style = doc.createElement('style');
        style.textContent = `
            .${BADGE_CLASS} {
                display: inline-block !important; margin-left: 4px !important;
                padding: 0 4px !important; border: 1px solid currentColor !important;
                border-radius: 3px !important; font-size: 11px !important;
                line-height: 1.4 !important; vertical-align: baseline !important;
                white-space: nowrap !important; font-weight: normal !important;
                cursor: help !important;
            }
            .${BADGE_CLASS}[data-gender="male"] { color: #245a9c !important; }
            .${BADGE_CLASS}[data-gender="female"] { color: #9c315d !important; }
            .${BADGE_CLASS}[data-gender="unknown"],
            .${BADGE_CLASS}[data-gender="loading"] { color: #666 !important; }
            .${BADGE_CLASS}[hidden] { display: none !important; }
        `;
        (doc.head || doc.body).append(style);
        const states = new WeakMap();
        const badgeResults = new WeakMap();
        function paint(badge, result) {
            badge.dataset.gender = result.gender;
            badgeResults.set(badge, result);
            const labels = { male: '♂ 男', female: '♀ 女', unknown: '? 未知', loading: '…' };
            badge.textContent = labels[result.gender];
            const explanation = result.reason === 'public' ?
                `公开资料：${result.gender === 'male' ? '男' : '女'}（用户自行填写，不代表真实身份）` :
                result.gender === 'loading' ? '正在查询公开资料' : `未知：${REASONS[result.reason]}`;
            badge.title = explanation;
            badge.setAttribute('aria-label', explanation);
            badge.hidden = !showUnknown && ['unknown', 'loading'].includes(result.gender);
        }
        function scan() {
            // 页面可能单独移除昵称，或复制已经带标记的节点；清除失去对应关系的标记。
            for (const badge of doc.querySelectorAll(`.${BADGE_CLASS}`)) {
                const anchor = badge.previousElementSibling;
                if (!anchor?.matches(NAME_SELECTOR) || states.get(anchor)?.badge !== badge) badge.remove();
            }
            for (const anchor of doc.querySelectorAll(NAME_SELECTOR)) {
                const name = extractUsername(anchor);
                const old = states.get(anchor);
                if (old && old.name === name && old.badge.isConnected) {
                    // 某些页面会整体移动昵称节点，保持标记紧邻对应昵称。
                    if (anchor.nextElementSibling !== old.badge) anchor.after(old.badge);
                    continue;
                }
                old?.badge.remove();
                const badge = doc.createElement('span');
                badge.className = BADGE_CLASS;
                anchor.after(badge);
                const state = { name, badge };
                states.set(anchor, state);
                if (!name) {
                    paint(badge, unknown('missing-identity'));
                    continue;
                }
                paint(badge, { gender: 'loading' });
                lookup(name).then((result) => {
                    if (states.get(anchor) === state && badge.isConnected &&
                        extractUsername(anchor) === name) paint(badge, result);
                });
            }
        }
        let scanTimer = null;
        const scheduleScan = () => {
            if (scanTimer !== null) return;
            scanTimer = env.setTimeout(() => { scanTimer = null; scan(); }, CONFIG.scanDelayMs);
        };
        // 忽略脚本自身的标记变化，避免观察器反复触发自身扫描。
        const isBadge = (node) => node?.nodeType === 1 && node.classList.contains(BADGE_CLASS);
        const observer = new env.MutationObserver((records) => {
            if (records.some((record) => {
                if (record.target.closest?.(`.${BADGE_CLASS}`)) return false;
                if (record.type === 'attributes') return true;
                return [...record.addedNodes, ...record.removedNodes].some((node) =>
                    node.nodeType === 1 && !isBadge(node));
            })) scheduleScan();
        });
        observer.observe(doc.body, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['data-field', 'username', 'href', 'class'] });
        scan();
        if (typeof env.GM_registerMenuCommand === 'function') {
            env.GM_registerMenuCommand('显示/隐藏“未知”标记', () => {
                showUnknown = !showUnknown;
                setValue(CONFIG.showUnknownKey, showUnknown);
                for (const badge of doc.querySelectorAll(`.${BADGE_CLASS}`)) {
                    const result = badgeResults.get(badge);
                    if (result) paint(badge, result);
                }
            });
            env.GM_registerMenuCommand('清空性别资料缓存并刷新', () => {
                cache.clear();
                setValue(CONFIG.cacheKey, cache.snapshot());
                env.location.reload();
            });
        }
        env.addEventListener('pagehide', () => setValue(CONFIG.cacheKey, cache.snapshot()));
        return { scan, disconnect() {
            observer.disconnect();
            if (scanTimer !== null) env.clearTimeout(scanTimer);
            if (saveTimer !== null) env.clearTimeout(saveTimer);
        } };
    }

    // 开发测试直接加载同一份可安装脚本，无须生成另一份构建产物。
    if (typeof module === 'object' && module.exports && typeof process === 'object' && process.versions?.node) {
        module.exports = { CONFIG, NAME_SELECTOR, extractUsername, buildProfileUrl,
            parsePanelResponse, createCache, createQueue, requestGender, createLookup, bootstrap };
    } else {
        bootstrap();
    }
})();
