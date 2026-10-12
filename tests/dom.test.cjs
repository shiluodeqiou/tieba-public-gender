'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { extractUsername, bootstrap, CONFIG } = require('../tieba-public-gender.user.js');

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

function setup(html, customRequest) {
    const virtualConsole = new VirtualConsole();
    const dom = new JSDOM(`<html><head></head><body>${html}</body></html>`, {
        url: 'https://tieba.baidu.com/p/123456789?pn=1', virtualConsole
    });
    const window = dom.window;
    const requests = [];
    const menus = new Map();
    const values = new Map();
    window.GM_getValue = (key, fallback) => values.has(key) ? values.get(key) : fallback;
    window.GM_setValue = (key, value) => values.set(key, value);
    window.GM_registerMenuCommand = (label, callback) => menus.set(label, callback);
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
        start() { runtime = bootstrap(window, { queue: { intervalMs: 0 } }); return runtime; },
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

test('没有可靠账号只显示未知，菜单能隐藏未知但保留公开资料标记', async () => {
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
        assert.match(unknownBadges[0].title, /可靠的账号名/);
        const toggle = fixture.menus.get('显示/隐藏“未知”标记');
        toggle();
        assert.ok(unknownBadges.every((badge) => badge.hidden));
        assert.equal(doc.querySelector(`${BADGE}[data-gender="male"]`).hidden, false);
        assert.equal(fixture.values.get(CONFIG.showUnknownKey), false);
        toggle();
        assert.ok(unknownBadges.every((badge) => !badge.hidden));
        assert.ok(fixture.menus.has('清空性别资料缓存并刷新'));
        // jsdom 不导航；仍可核对菜单在导航前已清空持久化缓存。
        const errors = [];
        fixture.virtualConsole.on('jsdomError', (error) => errors.push(error));
        fixture.menus.get('清空性别资料缓存并刷新')();
        assert.equal(fixture.values.get(CONFIG.cacheKey).entries.length, 0);
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

test('浏览器直接执行可安装脚本时会启动；其他站点与列表页不会启动', async () => {
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
    for (const url of ['https://tieba.baidu.com/f?kw=测试', 'https://example.com/p/123']) {
        const other = new JSDOM(`<body>${main('账号甲')}</body>`, { url });
        try {
            assert.equal(bootstrap(other.window), null);
            assert.equal(other.window.document.querySelector(BADGE), null);
        } finally { other.window.close(); }
    }
});
