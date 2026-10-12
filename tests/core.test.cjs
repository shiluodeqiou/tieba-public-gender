'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    CONFIG, buildProfileUrl, parsePanelResponse, createCache,
    createQueue, requestGender, createLookup
} = require('../tieba-public-gender.user.js');

const turn = () => new Promise((resolve) => setImmediate(resolve));
const panel = (name, sex, extra = {}) => ({ no: 0, data: { name, sex, ...extra } });

test('查询参数完整编码，不能由账号名注入其他账号参数', () => {
    const name = '示例账号&un=别人+空格 #测试';
    const url = new URL(buildProfileUrl(name));
    assert.equal(url.origin, 'https://tieba.baidu.com');
    assert.equal(url.pathname, '/home/get/panel');
    assert.equal(url.searchParams.get('un'), name);
    assert.deepEqual(url.searchParams.getAll('un'), [name]);
    assert.equal(url.hash, '');
    assert.throws(() => buildProfileUrl(''), TypeError);
    assert.throws(() => buildProfileUrl('\n其他账号'), TypeError);
});

test('采用已核实的公开枚举，但错误账号、私密资料及数值枚举一律未知', () => {
    assert.deepEqual(parsePanelResponse(panel('账号甲', 'male'), '账号甲'),
        { gender: 'male', reason: 'public' });
    assert.deepEqual(parsePanelResponse(panel('账号甲', 'female'), '账号甲'),
        { gender: 'female', reason: 'public' });
    assert.equal(parsePanelResponse(panel('账号乙', 'female'), '账号甲').reason, 'identity-mismatch');
    assert.equal(parsePanelResponse({ no: 0, data: { sex: 'male' } }, '账号甲').gender, 'unknown');
    for (const is_private of [1, '1', true]) {
        assert.equal(parsePanelResponse(panel('账号甲', 'female', { is_private }), '账号甲').reason, 'not-public');
    }
    for (const sex of [1, 2, '1', '2', 'FEMALE', '保密']) {
        assert.equal(parsePanelResponse(panel('账号甲', sex), '账号甲').reason, 'unexpected-value');
    }
    for (const sex of [undefined, null, '', 0, '0', 'unknown']) {
        assert.equal(parsePanelResponse(panel('账号甲', sex), '账号甲').reason, 'not-public');
    }
    assert.equal(parsePanelResponse({ no: 1, data: { name: '账号甲', sex: 'male' } }, '账号甲').reason, 'api-error');
    assert.equal(parsePanelResponse({ data: { name: '账号甲', sex: 'male' } }, '账号甲').reason, 'api-error');
    assert.equal(parsePanelResponse({ no: 0, data: [] }, '账号甲').reason, 'api-error');
});

test('缓存按结果类别到期，错误不会长期保留，且总量受限', () => {
    let time = 1000;
    const cache = createCache({ now: () => time, maxEntries: 3 });
    cache.set('公开账号', { gender: 'male', reason: 'public' });
    cache.set('未公开账号', { gender: 'unknown', reason: 'not-public' });
    cache.set('暂时失败', { gender: 'unknown', reason: 'timeout' });
    const stored = cache.snapshot();
    assert.equal(stored.entries.length, 3);
    assert.deepEqual(Object.keys(stored.entries[0][1]).sort(), ['expiresAt', 'gender', 'reason']);
    const restored = createCache({ now: () => time, initial: stored });
    assert.equal(restored.get('公开账号').gender, 'male');
    time += CONFIG.errorTtlMs;
    assert.equal(cache.get('暂时失败'), null);
    assert.equal(cache.get('未公开账号').gender, 'unknown');
    time = 1000 + CONFIG.unknownTtlMs;
    assert.equal(cache.get('未公开账号'), null);
    assert.equal(cache.get('公开账号').gender, 'male');
    time = 1000 + CONFIG.knownTtlMs;
    assert.equal(cache.get('公开账号'), null);
    cache.set('一', { gender: 'female', reason: 'public' });
    cache.set('二', { gender: 'female', reason: 'public' });
    cache.set('三', { gender: 'female', reason: 'public' });
    cache.set('四', { gender: 'female', reason: 'public' });
    assert.equal(cache.get('一'), null);
    assert.equal(cache.snapshot().entries.length, 3);
    cache.clear();
    assert.equal(cache.snapshot().entries.length, 0);
});

test('损坏/过期存储及不符合语义的已知结果不显示为公开性别', () => {
    const now = 1000;
    const cache = createCache({ now: () => now, initial: {
        version: 1,
        entries: [
            ['过期', { gender: 'female', reason: 'public', expiresAt: 999 }],
            ['错字段', { gender: 'male', reason: 'timeout', expiresAt: 2000 }],
            ['超长缓存', { gender: 'male', reason: 'public', expiresAt: now + CONFIG.knownTtlMs + 1 }],
            ['未知值', { gender: 'unknown', reason: '伪造来源', expiresAt: 2000 }],
            ['损坏', null],
            null,
            ['有效', { gender: 'female', reason: 'public', expiresAt: 2000 }]
        ]
    } });
    assert.deepEqual(cache.snapshot().entries.map(([name]) => name), ['有效']);
    assert.equal(createCache({ initial: '损坏存储' }).get('有效'), null);
});

test('队列遵守启动间隔与最大并发，慢请求不会挤出第三个并发请求', async () => {
    let time = 0;
    const timers = [];
    const started = [];
    const releases = [];
    let running = 0;
    let maxRunning = 0;
    const enqueue = createQueue({ concurrency: 2, intervalMs: 900, now: () => time,
        setTimer(fn, delay) {
            const timer = { fn, due: time + delay };
            timers.push(timer);
            return timer;
        } });
    const advance = async (newTime) => {
        time = newTime;
        for (let index = 0; index < timers.length;) {
            if (timers[index].due <= time) timers.splice(index, 1)[0].fn();
            else index += 1;
        }
        await turn();
    };
    const tasks = Array.from({ length: 3 }, () => enqueue(() => {
        started.push(time);
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        return new Promise((resolve) => releases.push(() => { running -= 1; resolve(); }));
    }));
    await turn();
    assert.deepEqual(started, [0]);
    await advance(899);
    assert.deepEqual(started, [0]);
    await advance(900);
    assert.deepEqual(started, [0, 900]);
    await advance(1800);
    assert.equal(started.length, 2);
    releases[0]();
    await turn();
    assert.deepEqual(started, [0, 900, 1800]);
    releases[1]();
    releases[2]();
    await Promise.all(tasks);
    assert.equal(maxRunning, 2);
});

test('重复账号合并正在进行的请求，并在成功后复用缓存', async () => {
    const cache = createCache();
    let requests = 0;
    let release;
    const lookup = createLookup({ cache, enqueue: createQueue({ intervalMs: 0 }),
        request: () => {
            requests += 1;
            return new Promise((resolve) => { release = resolve; });
        } });
    const first = lookup('重复账号');
    const second = lookup('重复账号');
    assert.equal(first, second);
    await turn();
    assert.equal(requests, 1);
    release({ gender: 'female', reason: 'public' });
    const results = await Promise.all([first, second]);
    assert.deepEqual(results[0], results[1]);
    assert.equal((await lookup('重复账号')).gender, 'female');
    assert.equal(requests, 1);
});

test('遭遇限流时，已排队账号不再继续联网；暂停结束后新账号可以查询', async () => {
    let time = 0;
    const names = [];
    const lookup = createLookup({ cache: createCache({ now: () => time }), now: () => time,
        enqueue: createQueue({ concurrency: 1, intervalMs: 0 }),
        request: async (name) => {
            names.push(name);
            return name === '限流账号' ? { gender: 'unknown', reason: 'rate-limited' } :
                { gender: 'male', reason: 'public' };
        } });
    const results = await Promise.all([lookup('限流账号'), lookup('排队账号'), lookup('第二个排队账号')]);
    assert.deepEqual(names, ['限流账号']);
    assert.deepEqual(results.map((result) => result.reason), ['rate-limited', 'cooldown', 'cooldown']);
    time = CONFIG.cooldownMs;
    assert.equal((await lookup('新账号')).gender, 'male');
    assert.deepEqual(names, ['限流账号', '新账号']);
});

test('匿名请求可解析资料，且没有添加 Cookie 或身份认证头', async () => {
    let details;
    const result = await requestGender('匿名测试', (options) => {
        details = options;
        queueMicrotask(() => options.onload({ status: 200, finalUrl: options.url,
            responseText: JSON.stringify(panel('匿名测试', 'female')) }));
        return { abort() {} };
    });
    assert.deepEqual(result, { gender: 'female', reason: 'public' });
    assert.equal(details.anonymous, true);
    assert.equal(details.method, 'GET');
    assert.deepEqual(details.headers, { Accept: 'application/json' });
    assert.equal(details.cookie, undefined);
});

test('访问拒绝、HTTP 错误、验证 HTML 和其他地址的重定向均不显示性别', async () => {
    const cases = [
        [{ status: 429 }, 'rate-limited'],
        [{ status: 403 }, 'access-denied'],
        [{ status: 401 }, 'access-denied'],
        [{ status: 500 }, 'http-error'],
        [{ status: 200, responseText: '<html>验证页面</html>' }, 'invalid-response'],
        [{ status: 200, finalUrl: 'https://wappass.baidu.com/', responseText: JSON.stringify(panel('测试账号', 'male')) }, 'redirected'],
        [{ status: 200, finalUrl: 'https://tieba.baidu.com/home/main', responseText: JSON.stringify(panel('测试账号', 'male')) }, 'redirected']
    ];
    for (const [response, reason] of cases) {
        const result = await requestGender('测试账号', (options) => {
            queueMicrotask(() => options.onload(response));
            return { abort() {} };
        });
        assert.deepEqual(result, { gender: 'unknown', reason });
    }
    const throwing = await requestGender('测试账号', () => { throw new Error('未授权联网'); });
    assert.equal(throwing.reason, 'network-error');
});

test('扩展不触发自身超时回调时仍取消请求；迟到的响应不能改写超时结果', async () => {
    let options;
    let aborted = 0;
    const result = await requestGender('超时账号', (details) => {
        options = details;
        return { abort() { aborted += 1; details.onabort(); } };
    }, { timeoutMs: 20 });
    assert.deepEqual(result, { gender: 'unknown', reason: 'timeout' });
    assert.equal(aborted, 1);
    options.onload({ status: 200, responseText: JSON.stringify(panel('超时账号', 'male')) });
    assert.equal(result.gender, 'unknown');
});
