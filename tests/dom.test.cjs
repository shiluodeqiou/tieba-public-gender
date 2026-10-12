'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const createClock = require('./clock.cjs');
const { extractUsername, extractIdentity, bootstrap, CONFIG } = require('../tieba-public-gender.user.js');

const BADGE = '.tb-public-gender-badge';
const field = (value) => JSON.stringify(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const main = (name, display = '显示昵称') => `
    <div class="l_post" data-field="${field({ author: { user_name: name } })}">
        <div class="p_author"><a class="p_author_face j_user_card" href="/home/main?id=portrait">头像</a>
            <a class="p_author_name j_user_card" href="/home/main?id=portrait">${display}</a></div>
    </div>`;
const reply = (name) => `
    <li class="lzl_single_post" data-field="${field({ user_name: name })}">
        <a class="j_user_card lzl_p_p" username="${name}" href="/home/main?id=portrait">头像</a>
        <div class="lzl_cnt"><a class="at j_user_card" href="/home/main?id=portrait">楼中楼显示昵称</a>
            ：回复 <a class="at j_user_card" data-field="${field({ un: '被提及账号' })}">被提及昵称</a></div>
    </li>`;

function setup(html, customRequest, options = {}) {
    const virtualConsole = new VirtualConsole();
    const dom = new JSDOM(`<html><head></head><body>${html}</body></html>`, {
        url: options.url || 'https://tieba.baidu.com/p/123456789?pn=1', virtualConsole
    });
    const window = dom.window;
    if (options.clock) {
        window.setTimeout = options.clock.setTimer;
        window.clearTimeout = options.clock.clearTimer;
    }
    const requests = [];
    const menus = new Map();
    const values = new Map(options.values);
    window.GM_getValue = (key, fallback) => values.has(key) ? values.get(key) : fallback;
    window.GM_setValue = (key, value) => values.set(key, value);
    window.GM_registerMenuCommand = (label, callback) => { menus.set(label, callback); return label; };
    window.GM_unregisterMenuCommand = (label) => menus.delete(label);
    window.GM_xmlhttpRequest = (details) => {
        const name = new URL(details.url).searchParams.get('un');
        requests.push(name);
        if (customRequest) return customRequest(details, name);
        window.setTimeout(() => details.onload({ status: 200, finalUrl: details.url,
            responseText: JSON.stringify({ no: 0, data: { name, sex:
                name === '账号甲' ? 'male' : name === '账号乙' ? 'female' : '' } }) }), 1);
        return { abort() {} };
    };
    let runtime;
    return { window, requests, menus, values, virtualConsole,
        start() { runtime = bootstrap(window, { now: options.clock?.now,
            queue: { intervalMs: 0, ...options.queue } }); return runtime; },
        close() { runtime?.disconnect(); window.close(); } };
}

async function waitFor(check, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('等待页面状态超时');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test('真实账号字段优先于显示昵称，且楼中楼缺账号时不查询外层作者', () => {
    const fixture = setup(`${main('账号甲', '完全不同的昵称')}
        <li class="lzl_single_post"><div class="lzl_cnt"><a class="j_user_card">只剩昵称</a></div></li>`);
    try {
        const anchor = fixture.window.document.querySelector('.p_author_name');
        assert.equal(extractUsername(anchor), '账号甲');
        anchor.setAttribute('data-field', JSON.stringify({ un: '明确账号' }));
        assert.equal(extractUsername(anchor), '明确账号');
        anchor.removeAttribute('data-field');
        const holder = fixture.window.document.createElement('div');
        holder.className = 'lzl_single_post';
        holder.innerHTML = '<div class="lzl_cnt"><a class="j_user_card" href="/home/main?id=opaque">昵称</a></div>';
        fixture.window.document.querySelector('.l_post').append(holder);
        assert.equal(extractUsername(holder.querySelector('a')), null);
        const fallback = fixture.window.document.querySelector('li a');
        fallback.href = '/home/main?un=%E8%B4%A6%E5%8F%B7%E4%B9%99';
        assert.equal(extractUsername(fallback), '账号乙');
        fallback.href = 'https://example.com/home/main?un=%E8%B4%A6%E5%8F%B7%E4%B9%99';
        assert.equal(extractUsername(fallback), null);
    } finally { fixture.close(); }
});

test('主楼、楼中楼均紧邻作者标记，重复账号合并，头像和 @ 提及不加标记', async () => {
    const fixture = setup(main('账号甲') + reply('账号乙') + main('账号甲'));
    try {
        const runtime = fixture.start();
        const doc = fixture.window.document;
        await waitFor(() => doc.querySelectorAll(`${BADGE}[data-gender="male"]`).length === 2 &&
            doc.querySelectorAll(`${BADGE}[data-gender="female"]`).length === 1);
        assert.deepEqual(fixture.requests.sort(), ['账号乙', '账号甲'].sort());
        assert.equal(doc.querySelector('.p_author_face').nextElementSibling.matches(BADGE), false);
        assert.equal(doc.querySelector('.lzl_p_p').nextElementSibling.matches(BADGE), false);
        const mention = doc.querySelector('.lzl_cnt a[data-field]');
        assert.equal(mention.nextElementSibling?.matches(BADGE) || false, false);
        const first = doc.querySelector('.p_author_name').nextElementSibling;
        assert.equal(first.textContent, '♂ 男');
        assert.match(first.title, /公开资料.*用户自行填写/);
        assert.equal(first.getAttribute('aria-label'), first.title);
        runtime.scan();
        runtime.scan();
        assert.equal(doc.querySelectorAll(BADGE).length, 3);
        assert.equal(fixture.requests.length, 2);
        await new Promise((resolve) => setTimeout(resolve, 280));
        assert.equal(fixture.values.get(CONFIG.cacheKey).entries.length, 2);
    } finally { fixture.close(); }
});

test('动态插入的楼中楼由观察器处理，复制已标记节点不会生成重复标记', async () => {
    const fixture = setup(main('账号甲'));
    try {
        fixture.start();
        const doc = fixture.window.document;
        await waitFor(() => doc.querySelector(`${BADGE}[data-gender="male"]`));
        doc.body.insertAdjacentHTML('beforeend', reply('账号乙'));
        await waitFor(() => doc.querySelector(`${BADGE}[data-gender="female"]`));
        doc.body.append(doc.querySelector('.l_post').cloneNode(true));
        await waitFor(() => doc.querySelectorAll(`${BADGE}[data-gender="male"]`).length === 2);
        assert.equal(doc.querySelectorAll(BADGE).length, 3);
        assert.equal(fixture.requests.filter((name) => name === '账号甲').length, 1);
        const removed = doc.querySelector('.p_author_name');
        removed.remove();
        await waitFor(() => doc.querySelectorAll(BADGE).length === 2);
    } finally { fixture.close(); }
});

test('没有可靠账号标识只显示未知，菜单能隐藏未知并原地重新查询', async () => {
    const fixture = setup(main('账号甲') + `
        <li class="lzl_single_post"><div class="lzl_cnt">
            <a class="j_user_card" href="/home/main?id=opaque">无法查询的显示昵称</a>
        </div></li>` + main('未公开账号'));
    try {
        fixture.start();
        const doc = fixture.window.document;
        await waitFor(() => doc.querySelectorAll(`${BADGE}[data-gender="unknown"]`).length === 2 &&
            doc.querySelector(`${BADGE}[data-gender="male"]`));
        assert.equal(fixture.requests.includes('无法查询的显示昵称'), false);
        const unknownBadges = [...doc.querySelectorAll(`${BADGE}[data-gender="unknown"]`)];
        assert.match(unknownBadges[0].title, /可靠的账号标识/);
        fixture.menus.get('未知标记：显示（点击隐藏）')();
        assert.ok(unknownBadges.every((badge) => badge.hidden));
        assert.equal(doc.querySelector(`${BADGE}[data-gender="male"]`).hidden, false);
        assert.equal(fixture.values.get(CONFIG.showUnknownKey), false);
        assert.ok(fixture.menus.has('未知标记：隐藏（点击显示）'));
        fixture.menus.get('未知标记：隐藏（点击显示）')();
        assert.ok(unknownBadges.every((badge) => !badge.hidden));
        fixture.menus.get('清空性别资料缓存并重新查询')();
        assert.equal(fixture.values.get(CONFIG.cacheKey).entries.length, 0);
        await waitFor(() => fixture.requests.length === 4 &&
            doc.querySelector(`${BADGE}[data-gender="male"]`));
        assert.equal(fixture.window.location.href, 'https://tieba.baidu.com/p/123456789?pn=1');
    } finally { fixture.close(); }
});

test('昵称节点被新作者复用时，迟到的旧资料不会覆盖新作者标记', async () => {
    const responses = new Map();
    const fixture = setup(main('账号甲'), (details, name) => {
        responses.set(name, details);
        return { abort() {} };
    });
    try {
        const runtime = fixture.start();
        const doc = fixture.window.document;
        await waitFor(() => responses.has('账号甲'));
        const anchor = doc.querySelector('.p_author_name');
        anchor.setAttribute('data-field', JSON.stringify({ un: '账号乙' }));
        runtime.scan();
        await waitFor(() => responses.has('账号乙'));
        responses.get('账号乙').onload({ status: 200, responseText:
            JSON.stringify({ no: 0, data: { name: '账号乙', sex: 'female' } }) });
        await waitFor(() => doc.querySelector(`${BADGE}[data-gender="female"]`));
        responses.get('账号甲').onload({ status: 200, responseText:
            JSON.stringify({ no: 0, data: { name: '账号甲', sex: 'male' } }) });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(doc.querySelectorAll(BADGE).length, 1);
        assert.equal(anchor.nextElementSibling.dataset.gender, 'female');
    } finally { fixture.close(); }
});

test('浏览器直接执行可安装脚本时会启动；其他站点不启动', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const script = fs.readFileSync(path.join(__dirname, '../tieba-public-gender.user.js'), 'utf8');
    const dom = new JSDOM(`<body>${main('账号甲')}</body>`, {
        url: 'https://tieba.baidu.com/p/123', runScripts: 'outside-only'
    });
    try {
        const window = dom.window;
        window.GM_getValue = (key, fallback) => fallback;
        window.GM_setValue = () => {};
        window.GM_registerMenuCommand = () => {};
        window.GM_xmlhttpRequest = (details) => {
            queueMicrotask(() => details.onload({ status: 200, responseText:
                JSON.stringify({ no: 0, data: { name: '账号甲', sex: 'male' } }) }));
            return { abort() {} };
        };
        window.eval(script);
        await waitFor(() => window.document.querySelector(`${BADGE}[data-gender="male"]`));
    } finally { dom.window.close(); }
    for (const url of ['https://example.com/p/123']) {
        const other = new JSDOM(`<body>${main('账号甲')}</body>`, { url });
        try {
            assert.equal(bootstrap(other.window), null);
            assert.equal(other.window.document.querySelector(BADGE), null);
        } finally { other.window.close(); }
    }
});

// Vue 可创建嵌套链接；用 DOM 方法保留这种结构，避免 HTML 解析器自动拆开 a 标签。
function appendModernAuthor(doc, portrait, display, kind = 'pb-comment-item') {
    const wrapper = doc.createElement('section');
    wrapper.className = kind;
    wrapper.innerHTML = `<div class="head-line user-info"><a class="head-avatar">头像</a>
        <div class="head-info"></div></div><p>回复 <a class="head-name mention">被提及昵称</a></p>`;
    const outer = doc.createElement('a');
    outer.className = 'name-info-link';
    outer.href = `/home/main?id=${encodeURIComponent(portrait)}&fr=pb`;
    const info = doc.createElement('div');
    info.className = 'name-info';
    const author = doc.createElement('a');
    author.className = 'head-name';
    author.href = outer.href;
    author.textContent = display;
    info.append(author);
    outer.append(info);
    wrapper.querySelector('.head-info').append(outer);
    wrapper.querySelector('.head-avatar').href = outer.href;
    doc.body.append(wrapper);
    return author;
}

test('新版主楼、回复和楼中楼使用 portrait 查询；不标记外层链接、头像或提及', async () => {
    const fixture = setup('', (details, name) => {
        assert.equal(name, null);
        const portrait = new URL(details.url).searchParams.get('id');
        fixture.window.setTimeout(() => details.onload({ status: 200, finalUrl: details.url,
            responseText: JSON.stringify({ no: 0, data: { name: '真实账号与显示昵称不同',
                portrait: `${portrait}?t=1773053660`, sex: portrait.endsWith('beta') ? 'female' : 'male' } }) }), 1);
        return { abort() {} };
    });
    try {
        const doc = fixture.window.document;
        const first = appendModernAuthor(doc, 'tb.1.fixture.alpha', '甲的显示昵称', 'image-text');
        const second = appendModernAuthor(doc, 'tb.1.fixture.beta', '乙的显示昵称');
        const nested = appendModernAuthor(doc, 'tb.1.fixture.alpha', '甲再次回复', 'lzl-item');
        assert.deepEqual(extractIdentity(first), { kind: 'portrait', value: 'tb.1.fixture.alpha' });
        fixture.start();
        await waitFor(() => doc.querySelectorAll(`${BADGE}[data-gender="male"]`).length === 2 &&
            doc.querySelectorAll(`${BADGE}[data-gender="female"]`).length === 1);
        assert.equal(fixture.requests.length, 2);
        assert.equal(first.nextElementSibling.textContent, '♂ 男');
        assert.equal(second.nextElementSibling.textContent, '♀ 女');
        assert.equal(nested.nextElementSibling.textContent, '♂ 男');
        assert.equal(doc.querySelectorAll('.name-info > .tb-public-gender-badge').length, 3);
        for (const anchor of doc.querySelectorAll('.head-avatar, .mention, .name-info-link')) {
            assert.equal(anchor.nextElementSibling?.matches(BADGE) || false, false);
        }
        assert.equal(doc.querySelector('#tb-public-gender-status'), null);
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.equal(fixture.requests.length, 2, '脚本自身修改不能触发重复查询');
    } finally { fixture.close(); }
});

test('初始关闭不查询；菜单切换状态并保存设置，页面不显示浮窗', async () => {
    const fixture = setup(main('账号甲'), null, { values: [[CONFIG.enabledKey, false]] });
    try {
        fixture.start();
        const doc = fixture.window.document;
        assert.equal(doc.querySelector('#tb-public-gender-status'), null);
        assert.equal(doc.querySelector(BADGE), null);
        assert.equal(fixture.requests.length, 0);
        assert.ok(fixture.menus.has('标记功能：已关闭（点击开启）'));
        fixture.menus.get('标记功能：已关闭（点击开启）')();
        await waitFor(() => doc.querySelector(`${BADGE}[data-gender="male"]`));
        assert.equal(fixture.values.get(CONFIG.enabledKey), true);
        assert.ok(fixture.menus.has('标记功能：已开启（点击关闭）'));
        fixture.menus.get('标记功能：已开启（点击关闭）')();
        assert.equal(doc.querySelector(BADGE), null);
        assert.equal(fixture.values.get(CONFIG.enabledKey), false);
        assert.ok(fixture.menus.has('标记功能：已关闭（点击开启）'));
        assert.equal(fixture.menus.size, 3);
        assert.equal(doc.querySelector('#tb-public-gender-status'), null);
    } finally { fixture.close(); }
});

test('关闭后不发送排队请求，迟到响应不恢复标记，重新开启后恢复', async () => {
    const responses = new Map();
    const fixture = setup(main('账号甲') + main('账号乙'), (details, name) => {
        responses.set(name, details);
        return { abort() {} };
    }, { queue: { concurrency: 1 } });
    try {
        const runtime = fixture.start();
        const doc = fixture.window.document;
        await waitFor(() => responses.has('账号甲'));
        runtime.toggleEnabled();
        responses.get('账号甲').onload({ status: 200, responseText:
            JSON.stringify({ no: 0, data: { name: '账号甲', sex: 'male' } }) });
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.deepEqual(fixture.requests, ['账号甲']);
        assert.equal(doc.querySelector(BADGE), null);
        runtime.toggleEnabled();
        await waitFor(() => fixture.requests.length === 2);
        responses.get('账号甲').onload({ status: 200, responseText:
            JSON.stringify({ no: 0, data: { name: '账号甲', sex: 'male' } }) });
        await waitFor(() => responses.has('账号乙'));
        responses.get('账号乙').onload({ status: 200, responseText:
            JSON.stringify({ no: 0, data: { name: '账号乙', sex: 'female' } }) });
        await waitFor(() => doc.querySelector(`${BADGE}[data-gender="female"]`));
        assert.ok(doc.querySelector(`${BADGE}[data-gender="male"]`));
        assert.equal(doc.querySelector(`${BADGE}[data-gender="unknown"]`), null);
        assert.deepEqual(fixture.requests, ['账号甲', '账号甲', '账号乙']);
    } finally { fixture.close(); }
});

test('无作者时不查询；请求接口缺失和请求失败可通过标记查看原因', async () => {
    const empty = setup('帖子内容尚未载入');
    const missing = setup(main('账号甲'));
    const denied = setup(main('账号甲'), (details) => {
        queueMicrotask(() => details.onload({ status: 403 }));
        return { abort() {} };
    });
    try {
        empty.start();
        assert.equal(empty.requests.length, 0);
        assert.equal(empty.window.document.querySelector(BADGE), null);
        delete missing.window.GM_xmlhttpRequest;
        missing.start();
        await waitFor(() => missing.window.document.querySelector(`${BADGE}[data-gender="unknown"]`));
        assert.match(missing.window.document.querySelector(BADGE).title, /油猴请求接口不可用/);
        denied.start();
        const doc = denied.window.document;
        await waitFor(() => doc.querySelector(`${BADGE}[data-gender="unknown"]`));
        assert.match(doc.querySelector(BADGE).title, /拒绝访问/);
        denied.menus.get('未知标记：显示（点击隐藏）')();
        assert.equal(doc.querySelector(BADGE).hidden, true);
        assert.ok(denied.menus.has('未知标记：隐藏（点击显示）'));
    } finally { empty.close(); missing.close(); denied.close(); }
});

test('从列表通过 SPA 进入帖子会启动，离开帖子后清理标记', async () => {
    const fixture = setup(main('账号甲'), null, { url: 'https://tieba.baidu.com/f?kw=测试' });
    try {
        fixture.start();
        const { window } = fixture;
        const doc = window.document;
        assert.equal(doc.querySelector('#tb-public-gender-status'), null);
        assert.equal(fixture.requests.length, 0);
        window.history.pushState({}, '', '/p/123');
        await waitFor(() => doc.querySelector(`${BADGE}[data-gender="male"]`));
        window.history.pushState({}, '', '/f?kw=测试');
        window.dispatchEvent(new window.PopStateEvent('popstate'));
        assert.equal(doc.querySelector(BADGE), null);
        assert.equal(doc.querySelector('#tb-public-gender-status'), null);
        assert.equal(fixture.requests.length, 1);
    } finally { fixture.close(); }
});

test('油猴接口只存在词法作用域而不在 window 上时也能正常标记', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '../tieba-public-gender.user.js'), 'utf8');
    const dom = new JSDOM(`<body>${main('账号甲')}</body>`, {
        url: 'https://tieba.baidu.com/p/123', runScripts: 'outside-only'
    });
    let requests = 0;
    const values = new Map();
    const menus = new Map();
    try {
        const run = dom.window.Function('GM_getValue', 'GM_setValue', 'GM_registerMenuCommand',
            'GM_xmlhttpRequest', 'GM_unregisterMenuCommand', source);
        run((key, fallback) => values.has(key) ? values.get(key) : fallback,
            (key, value) => values.set(key, value),
            (label, callback) => { menus.set(label, callback); return label; },
            (details) => {
                requests += 1;
                queueMicrotask(() => details.onload({ status: 200, finalUrl: details.url,
                    responseText: JSON.stringify({ no: 0, data: { name: '账号甲', sex: 'male' } }) }));
                return { abort() {} };
            }, (label) => menus.delete(label));
        const doc = dom.window.document;
        await waitFor(() => doc.querySelector(`${BADGE}[data-gender="male"]`));
        assert.equal(dom.window.GM_xmlhttpRequest, undefined);
        assert.equal(requests, 1);
        assert.equal(menus.size, 3);
        menus.get('标记功能：已开启（点击关闭）')();
        assert.equal(values.get(CONFIG.enabledKey), false);
        assert.ok(menus.has('标记功能：已关闭（点击开启）'));
    } finally { dom.window.close(); }
});

test('重新查询取消旧请求，旧回调不会覆盖新标记或回写缓存', async () => {
    const responses = [];
    let aborts = 0;
    const fixture = setup(main('账号甲'), details => {
        responses.push(details);
        return { abort() { aborts += 1; } };
    }, { queue: { concurrency: 1 } });
    try {
        const runtime = fixture.start();
        await waitFor(() => responses.length === 1);
        runtime.retry();
        await waitFor(() => responses.length === 2);
        assert.equal(aborts, 1);
        responses[1].onload({ status: 200, responseText:
            JSON.stringify({ no: 0, data: { name: '账号甲', sex: 'female' } }) });
        const doc = fixture.window.document;
        await waitFor(() => doc.querySelector(`${BADGE}[data-gender="female"]`));
        responses[0].onload({ status: 200, responseText:
            JSON.stringify({ no: 0, data: { name: '账号甲', sex: 'male' } }) });
        responses[0].onerror();
        fixture.window.dispatchEvent(new fixture.window.Event('pagehide'));
        assert.equal(doc.querySelector(BADGE).dataset.gender, 'female');
        assert.equal(fixture.values.get(CONFIG.cacheKey).entries[0][1].gender, 'female');
    } finally { fixture.close(); }
});

test('站内切换帖子后清除旧排队任务，旧响应不写缓存，新帖作者优先查询', async () => {
    const responses = [];
    const fixture = setup(main('旧甲') + main('旧乙') + main('旧丙'), (details, name) => {
        responses.push({ details, name });
        return { abort() {} };
    }, { queue: { concurrency: 1 } });
    try {
        fixture.start();
        await waitFor(() => responses.length === 1);
        const { window } = fixture;
        window.document.body.innerHTML = main('新丁');
        window.history.pushState({}, '', '/p/987');
        window.dispatchEvent(new window.PopStateEvent('popstate'));
        await waitFor(() => responses.length === 2);
        assert.deepEqual(fixture.requests, ['旧甲', '新丁']);
        responses[0].details.onload({ status: 200, responseText:
            JSON.stringify({ no: 0, data: { name: '旧甲', sex: 'male' } }) });
        responses[1].details.onload({ status: 200, responseText:
            JSON.stringify({ no: 0, data: { name: '新丁', sex: 'female' } }) });
        await waitFor(() => window.document.querySelector(`${BADGE}[data-gender="female"]`));
        window.dispatchEvent(new window.Event('pagehide'));
        const entries = fixture.values.get(CONFIG.cacheKey).entries;
        assert.equal(entries.length, 1);
        assert.match(entries[0][0], /新丁/);
    } finally { fixture.close(); }
});

test('昵称已从页面移除时，其排队请求在发送前会被跳过', async () => {
    const responses = [];
    const fixture = setup(main('账号甲') + main('账号乙'), details => {
        responses.push(details);
        return { abort() {} };
    }, { queue: { concurrency: 1 } });
    try {
        fixture.start();
        await waitFor(() => responses.length === 1);
        fixture.window.document.querySelectorAll('.l_post')[1].remove();
        responses[0].onload({ status: 200, responseText:
            JSON.stringify({ no: 0, data: { name: '账号甲', sex: 'male' } }) });
        await waitFor(() => fixture.window.document.querySelector(`${BADGE}[data-gender="male"]`));
        assert.deepEqual(fixture.requests, ['账号甲']);
    } finally { fixture.close(); }
});

test('冷却结束后当前页自动恢复查询，无需刷新或点击菜单', async () => {
    const clock = createClock();
    let failed = false;
    const fixture = setup(main('账号甲') + main('账号乙'), (details, name) => {
        if (!failed) {
            failed = true;
            queueMicrotask(() => details.onload({ status: 429 }));
        } else {
            queueMicrotask(() => details.onload({ status: 200, responseText:
                JSON.stringify({ no: 0, data: { name, sex: 'female' } }) }));
        }
        return { abort() {} };
    }, { clock, queue: { concurrency: 1 } });
    try {
        fixture.start();
        const doc = fixture.window.document;
        await clock.advance(0);
        assert.deepEqual(fixture.requests, ['账号甲']);
        assert.match(doc.querySelector(BADGE).title, /一分钟/);
        await clock.advance(CONFIG.cooldownMs - 1);
        assert.deepEqual(fixture.requests, ['账号甲']);
        assert.equal(fixture.values.has(CONFIG.cacheKey), false);
        await clock.advance(1);
        assert.equal(doc.querySelectorAll(`${BADGE}[data-gender="female"]`).length, 2);
        assert.deepEqual(fixture.requests, ['账号甲', '账号乙', '账号甲']);
        await clock.advance(250);
        assert.ok(fixture.values.get(CONFIG.cacheKey).entries.every(([, value]) => value.reason === 'public'));
    } finally { fixture.close(); }
});

test('已缓存吧友在新的帖子或刷新后直接显示，缺少网络权限也无需重新请求', async () => {
    const first = setup(main('账号甲'));
    let second;
    try {
        first.start();
        await waitFor(() => first.window.document.querySelector(`${BADGE}[data-gender="male"]`));
        first.window.dispatchEvent(new first.window.Event('pagehide'));
        second = setup(main('账号甲', '同一账号的新显示昵称'), null,
            { values: first.values, url: 'https://tieba.baidu.com/p/999' });
        delete second.window.GM_xmlhttpRequest;
        second.start();
        await waitFor(() => second.window.document.querySelector(`${BADGE}[data-gender="male"]`));
        assert.equal(second.requests.length, 0);
        assert.equal(second.window.document.querySelector(BADGE).textContent, '♂ 男');
    } finally { first.close(); second?.close(); }
});
