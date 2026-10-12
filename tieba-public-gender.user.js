// ==UserScript==
// @name         百度贴吧公开性别标记
// @namespace    local.tieba-public-gender
// @version      1.0.3
// @description  在帖子昵称旁显示用户公开资料中的性别；未公开或无法获取时显示未知。
// @homepageURL  https://github.com/shiluodeqiou/tieba-public-gender
// @supportURL   https://github.com/shiluodeqiou/tieba-public-gender/issues
// @updateURL    https://raw.githubusercontent.com/shiluodeqiou/tieba-public-gender/main/tieba-public-gender.user.js
// @downloadURL  https://raw.githubusercontent.com/shiluodeqiou/tieba-public-gender/main/tieba-public-gender.user.js
// @match        https://tieba.baidu.com/*
// @match        http://tieba.baidu.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @connect      tieba.baidu.com
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = Object.freeze({
        endpoint: 'https://tieba.baidu.com/home/get/panel',
        cacheKey: 'tieba-public-gender:cache:v2',
        enabledKey: 'tieba-public-gender:enabled',
        showUnknownKey: 'tieba-public-gender:show-unknown',
        knownTtlMs: 24 * 60 * 60 * 1000,
        unknownTtlMs: 60 * 60 * 1000,
        errorTtlMs: 5 * 60 * 1000,
        timeoutMs: 10 * 1000,
        intervalMs: 900,
        concurrency: 2,
        cooldownMs: 60 * 1000,
        maxCacheEntries: 500,
        scanDelayMs: 120,
        routeCheckMs: 1000
    });
    const BADGE_CLASS = 'tb-public-gender-badge';
    const COOLDOWN_REASONS = new Set(['rate-limited', 'access-denied', 'invalid-response', 'redirected']);
    const TRANSIENT_REASONS = new Set(['disabled', 'cooldown', ...COOLDOWN_REASONS]);
    // 楼中楼只选正文的第一个用户链接，排除头像、被回复者和正文中的 @ 提及。
    const NAME_SELECTOR = [
        'a.p_author_name',
        '.lzl_cnt > a.j_user_card:first-child',
        '.lzl_cnt > a.at:first-child',
        '.user-info .name-info > a.head-name'
    ].join(',');
    const REASONS = Object.freeze({
        'not-public': '用户未公开可识别的性别资料',
        'missing-identity': '页面未提供可靠的账号标识，未使用显示昵称猜测',
        'identity-mismatch': '资料返回的账号与请求账号不一致，已忽略',
        'unexpected-value': '接口返回了未支持的性别值，已忽略',
        'api-error': '贴吧资料接口未返回成功结果',
        'invalid-response': '资料接口未返回预期的 JSON，可能需要验证',
        'rate-limited': '贴吧限制了请求频率，已暂停新请求一分钟',
        'access-denied': '公开资料接口拒绝访问，未尝试使用登录凭据',
        'http-error': '公开资料接口暂时不可用',
        'network-error': '网络请求失败或油猴未允许请求',
        'api-unavailable': '油猴请求接口不可用，请重新安装脚本或检查扩展权限',
        timeout: '公开资料请求超时',
        cooldown: '接口暂时不可用，正在等待恢复',
        redirected: '资料请求被重定向到其他地址，已忽略',
        disabled: '标记功能已关闭，未发送新请求'
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

    function normalizePortrait(value) {
        // 公开接口的 portrait 会附带 ?t=时间戳；时间戳不是账号标识的一部分。
        if (typeof value !== 'string' || value.length > 280) return null;
        const match = /^(tb\.\d{1,3}\.[A-Za-z0-9._-]{1,240})(?:\?t=\d{1,20})?$/.exec(value);
        return match ? match[1] : null;
    }

    function normalizeIdentity(identity) {
        if (validUsername(identity)) return { kind: 'username', value: identity };
        if (identity?.kind === 'username' && validUsername(identity.value)) return identity;
        if (identity?.kind === 'portrait') {
            const value = normalizePortrait(identity.value);
            if (value) return { kind: 'portrait', value };
        }
        return null;
    }

    function extractIdentity(anchor) {
        const username = extractUsername(anchor);
        if (username) return { kind: 'username', value: username };
        try {
            const url = new URL(anchor.getAttribute('href') || '', 'https://tieba.baidu.com');
            if (['https:', 'http:'].includes(url.protocol) && url.hostname === 'tieba.baidu.com' &&
                url.pathname === '/home/main') {
                const portrait = normalizePortrait(url.searchParams.get('id'));
                if (portrait) return { kind: 'portrait', value: portrait };
            }
        } catch { /* 无效链接按未知处理。 */ }
        return null;
    }

    function identityKey(identity) {
        const normalized = normalizeIdentity(identity);
        if (!normalized) return null;
        // 保留旧接口传入的账号字符串；页面使用带类型的键，防止两类标识碰撞。
        return typeof identity === 'string' ? identity : JSON.stringify([normalized.kind, normalized.value]);
    }

    function validCacheKey(key) {
        if (validUsername(key)) return true;
        try {
            const value = JSON.parse(key);
            return Array.isArray(value) && value.length === 2 &&
                !!normalizeIdentity({ kind: value[0], value: value[1] });
        } catch { return false; }
    }

    function buildProfileUrl(identity) {
        const normalized = normalizeIdentity(identity);
        if (!normalized) throw new TypeError('无效账号标识');
        const url = new URL(CONFIG.endpoint);
        url.searchParams.set('ie', 'utf-8');
        url.searchParams.set(normalized.kind === 'portrait' ? 'id' : 'un', normalized.value);
        return url.href;
    }

    function parsePanelResponse(payload, identity) {
        if (!payload || typeof payload !== 'object' ||
            (payload.no !== 0 && payload.no !== '0')) return unknown('api-error');
        const data = payload.data;
        if (!data || typeof data !== 'object' || Array.isArray(data)) return unknown('api-error');
        // 当前接口的 data.name 是账号名，data.name_show/show_nickname 是显示昵称。
        // 必须有账号名且完全匹配；不把第三方或错误账号的资料展示给当前作者。
        const requested = normalizeIdentity(identity);
        if (!requested || !validUsername(data.name) || (requested.kind === 'username' ?
            data.name !== requested.value : normalizePortrait(data.portrait) !== requested.value)) {
            return unknown('identity-mismatch');
        }
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
                    (value.gender === 'unknown' && Object.hasOwn(REASONS, value.reason) &&
                        !TRANSIENT_REASONS.has(value.reason))
                );
                if (validCacheKey(name) && validResult && Number.isFinite(value.expiresAt) &&
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
                // 优先保留最近遇到的吧友；读取不延长资料本身的有效期。
                entries.delete(name);
                entries.set(name, entry);
                return { gender: entry.gender, reason: entry.reason };
            },
            set(name, result) {
                if (TRANSIENT_REASONS.has(result.reason)) return;
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
        now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
        const tasks = [];
        let active = 0;
        let nextStart = 0;
        let pausedUntil = 0;
        let timer = null;
        function pump() {
            if (timer !== null) { clearTimer(timer); timer = null; }
            if (active >= concurrency || tasks.length === 0) return;
            const wait = Math.max(0, nextStart - now(), pausedUntil - now());
            if (wait > 0) {
                timer = setTimer(() => { timer = null; pump(); }, wait);
                return;
            }
            const task = tasks.shift();
            task.signal?.removeEventListener('abort', task.cancel);
            active += 1;
            nextStart = now() + intervalMs;
            Promise.resolve().then(() => task.signal?.aborted ? unknown('disabled') : task.run())
                .then(task.resolve, task.reject).finally(() => {
                active -= 1;
                pump();
            });
            pump();
        }
        const enqueue = (run, { signal } = {}) => new Promise((resolve, reject) => {
            if (signal?.aborted) { resolve(unknown('disabled')); return; }
            const task = { run, resolve, reject, signal };
            task.cancel = () => {
                const index = tasks.indexOf(task);
                if (index < 0) return;
                tasks.splice(index, 1);
                signal.removeEventListener('abort', task.cancel);
                resolve(unknown('disabled'));
                // 一次失效操作可能取消整批任务，待这一批取消完成后再调度。
                Promise.resolve().then(pump);
            };
            signal?.addEventListener('abort', task.cancel, { once: true });
            tasks.push(task);
            pump();
        });
        enqueue.pauseUntil = (time) => { pausedUntil = Math.max(pausedUntil, time); pump(); };
        return enqueue;
    }

    function requestGender(username, gmRequest, { timeoutMs = CONFIG.timeoutMs,
        setTimer = setTimeout, clearTimer = clearTimeout, signal } = {}) {
        return new Promise((resolve) => {
            let settled = false;
            let handle;
            let timer;
            function finish(result) {
                if (settled) return;
                settled = true;
                clearTimer(timer);
                signal?.removeEventListener('abort', cancel);
                resolve(result);
            }
            function cancel() {
                finish(unknown('disabled'));
                try { handle?.abort(); } catch { /* 即使扩展取消失败，也忽略迟到响应。 */ }
            }
            if (signal?.aborted) { cancel(); return; }
            signal?.addEventListener('abort', cancel, { once: true });
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
        shouldRequest = () => true, onCooldown = () => {}, now = Date.now } = {}) {
        const pending = new Map();
        let generation = 0;
        const lookup = (name) => {
            const key = identityKey(name);
            if (!key) return Promise.resolve(unknown('missing-identity'));
            const saved = cache.get(key);
            if (saved) { onCacheChange(); return Promise.resolve(saved); }
            if (pending.has(key)) return pending.get(key).promise;
            const controller = new AbortController();
            const epoch = generation;
            const current = () => epoch === generation && !controller.signal.aborted && shouldRequest(name);
            const promise = enqueue(async () => {
                if (!current()) return unknown('disabled');
                const result = await request(name, { signal: controller.signal });
                if (!current()) return unknown('disabled');
                if (COOLDOWN_REASONS.has(result.reason)) {
                    const retryAt = now() + CONFIG.cooldownMs;
                    enqueue.pauseUntil(retryAt);
                    onCooldown(retryAt);
                    return { ...result, retryAt };
                }
                cache.set(key, result);
                onCacheChange();
                return result;
            }, { signal: controller.signal }).catch(() => unknown('network-error')).finally(() => {
                if (pending.get(key)?.promise === promise) pending.delete(key);
            });
            pending.set(key, { promise, controller });
            return promise;
        };
        lookup.invalidate = () => {
            generation += 1;
            const obsolete = [...pending.values()];
            pending.clear();
            for (const { controller } of obsolete) controller.abort();
        };
        return lookup;
    }

    function bootstrap(env = globalThis, options = {}) {
        const doc = env.document;
        if (!doc?.body || env.location.hostname !== 'tieba.baidu.com') return null;
        const isPostPage = () => /^\/p\/\d+\/?$/.test(env.location.pathname);
        const now = options.now || Date.now;
        const route = () => env.location.pathname + env.location.search;
        let previousRoute = route();
        let stopped = false;
        // 油猴可能把 GM 接口注入词法作用域，而不挂在 globalThis/window 上。
        const api = options.gm || {
            getValue: typeof GM_getValue === 'function' ? GM_getValue : env.GM_getValue,
            setValue: typeof GM_setValue === 'function' ? GM_setValue : env.GM_setValue,
            request: typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : env.GM_xmlhttpRequest,
            registerMenu: typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand : env.GM_registerMenuCommand,
            unregisterMenu: typeof GM_unregisterMenuCommand === 'function' ? GM_unregisterMenuCommand : env.GM_unregisterMenuCommand
        };
        const getValue = (key, fallback) => {
            try { return api.getValue(key, fallback); } catch { return fallback; }
        };
        const setValue = (key, value) => {
            try { api.setValue(key, value); } catch { /* 禁用存储时仍可临时工作。 */ }
        };
        let enabled = getValue(CONFIG.enabledKey, true) !== false;
        let showUnknown = getValue(CONFIG.showUnknownKey, true) !== false;
        const cache = createCache({ initial: getValue(CONFIG.cacheKey, null), now });
        const enqueue = createQueue({ now, ...options.queue,
            setTimer: env.setTimeout.bind(env), clearTimer: env.clearTimeout.bind(env) });
        let saveTimer = null;
        let recoveryTimer = null;
        const save = () => {
            if (saveTimer !== null) env.clearTimeout(saveTimer);
            saveTimer = env.setTimeout(() => {
                saveTimer = null;
                setValue(CONFIG.cacheKey, cache.snapshot());
            }, 250);
        };
        const lookup = createLookup({ cache, enqueue, now, onCacheChange: save,
            shouldRequest: (name) => !stopped && enabled && isPostPage() && route() === previousRoute &&
                [...doc.querySelectorAll(NAME_SELECTOR)].some(anchor => identityKey(extractIdentity(anchor)) === identityKey(name)),
            onCooldown: (retryAt) => {
                if (recoveryTimer !== null) env.clearTimeout(recoveryTimer);
                recoveryTimer = env.setTimeout(() => {
                    recoveryTimer = null;
                    if (stopped || !enabled || !isPostPage()) return;
                    for (const anchor of doc.querySelectorAll(NAME_SELECTOR)) {
                        const state = states.get(anchor);
                        const result = state && badgeResults.get(state.badge);
                        if (result?.retryAt <= now()) {
                            state.badge.remove();
                            states.delete(anchor);
                        }
                    }
                    scan();
                }, Math.max(0, retryAt - now()));
            },
            request: (name, { signal }) => typeof api.request !== 'function' ? Promise.resolve(unknown('api-unavailable')) :
                requestGender(name, api.request, {
                signal, setTimer: env.setTimeout.bind(env), clearTimer: env.clearTimeout.bind(env)
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
        let states = new WeakMap();
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
            badge.hidden = !enabled || (!showUnknown && ['unknown', 'loading'].includes(result.gender));
        }
        function clearBadges() {
            for (const badge of doc.querySelectorAll(`.${BADGE_CLASS}`)) badge.remove();
            states = new WeakMap();
        }
        function scan() {
            if (stopped) return;
            if (route() !== previousRoute) {
                previousRoute = route();
                lookup.invalidate();
                clearBadges();
            }
            if (!isPostPage()) {
                clearBadges();
                return;
            }
            if (!enabled) {
                clearBadges();
                return;
            }
            // 页面可能单独移除昵称，或复制已经带标记的节点；清除失去对应关系的标记。
            for (const badge of doc.querySelectorAll(`.${BADGE_CLASS}`)) {
                const anchor = badge.previousElementSibling;
                if (!anchor?.matches(NAME_SELECTOR) || states.get(anchor)?.badge !== badge) badge.remove();
            }
            for (const anchor of doc.querySelectorAll(NAME_SELECTOR)) {
                const identity = extractIdentity(anchor);
                const name = identityKey(identity);
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
                lookup(identity).then((result) => {
                    if (states.get(anchor) === state && badge.isConnected &&
                        identityKey(extractIdentity(anchor)) === name && enabled && isPostPage()) {
                        if (result.reason === 'disabled') {
                            states.delete(anchor);
                            badge.remove();
                            scheduleScan();
                        } else paint(badge, result);
                    }
                });
            }
        }
        let scanTimer = null;
        const scheduleScan = () => {
            if (stopped || scanTimer !== null) return;
            scanTimer = env.setTimeout(() => { scanTimer = null; scan(); }, CONFIG.scanDelayMs);
        };
        // 忽略脚本自身的标记变化，避免观察器反复触发自身扫描。
        const isOwn = (node) => node?.nodeType === 1 && node.classList.contains(BADGE_CLASS);
        const observer = new env.MutationObserver((records) => {
            if (!isPostPage()) return;
            if (records.some((record) => {
                if (record.target.closest?.(`.${BADGE_CLASS}`)) return false;
                if (record.type === 'attributes') return true;
                return [...record.addedNodes, ...record.removedNodes].some((node) =>
                    node.nodeType === 1 && !isOwn(node));
            })) scheduleScan();
        });
        observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['data-field', 'username', 'href', 'class'] });
        let menuIds = [];
        function updateMenus() {
            if (typeof api.registerMenu !== 'function') return;
            if (menuIds.length && typeof api.unregisterMenu !== 'function') return;
            for (const id of menuIds) {
                try { api.unregisterMenu(id); } catch { /* 管理器不支持时，刷新后显示最新菜单状态。 */ }
            }
            menuIds = [
                api.registerMenu(`标记功能：${enabled ? '已开启（点击关闭）' : '已关闭（点击开启）'}`, toggleEnabled),
                api.registerMenu(`未知标记：${showUnknown ? '显示（点击隐藏）' : '隐藏（点击显示）'}`, toggleUnknown),
                api.registerMenu('清空性别资料缓存并重新查询', retry)
            ];
        }
        function toggleEnabled() {
            enabled = !enabled;
            setValue(CONFIG.enabledKey, enabled);
            if (!enabled) lookup.invalidate();
            scan();
            updateMenus();
        }
        function toggleUnknown() {
            showUnknown = !showUnknown;
            setValue(CONFIG.showUnknownKey, showUnknown);
            for (const badge of doc.querySelectorAll(`.${BADGE_CLASS}`)) {
                const result = badgeResults.get(badge);
                if (result) paint(badge, result);
            }
            updateMenus();
        }
        function retry() {
            lookup.invalidate();
            cache.clear();
            setValue(CONFIG.cacheKey, cache.snapshot());
            clearBadges();
            scan();
        }
        const checkRoute = () => {
            if (route() !== previousRoute) scan();
        };
        const routeTimer = env.setInterval(checkRoute, CONFIG.routeCheckMs);
        env.addEventListener('popstate', checkRoute);
        scan();
        updateMenus();
        const saveOnHide = () => setValue(CONFIG.cacheKey, cache.snapshot());
        env.addEventListener('pagehide', saveOnHide);
        return { scan, toggleEnabled, toggleUnknown, retry, disconnect() {
            stopped = true;
            lookup.invalidate();
            observer.disconnect();
            env.clearInterval(routeTimer);
            env.removeEventListener('popstate', checkRoute);
            env.removeEventListener('pagehide', saveOnHide);
            if (scanTimer !== null) env.clearTimeout(scanTimer);
            if (saveTimer !== null) env.clearTimeout(saveTimer);
            if (recoveryTimer !== null) env.clearTimeout(recoveryTimer);
        } };
    }

    // 开发测试直接加载同一份可安装脚本，无须生成另一份构建产物。
    if (typeof module === 'object' && module.exports && typeof process === 'object' && process.versions?.node) {
        module.exports = { CONFIG, NAME_SELECTOR, extractUsername, extractIdentity, normalizePortrait, identityKey, buildProfileUrl,
            parsePanelResponse, createCache, createQueue, requestGender, createLookup, bootstrap };
    } else {
        if (globalThis.document?.body) bootstrap();
        else globalThis.addEventListener('DOMContentLoaded', () => bootstrap(), { once: true });
    }
})();
