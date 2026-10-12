'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createClock = require('./clock.cjs');
const {
    CONFIG, normalizePortrait, identityKey, buildProfileUrl, parsePanelResponse, createCache,
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

test('新版 portrait 仅采用已核实格式；编码后使用 id，返回时间戳后缀可规范化', () => {
    const id = 'tb.1.fixture.Abc_123-test';
    const identity = { kind: 'portrait', value: id };
    const url = new URL(buildProfileUrl(identity));
    assert.equal(url.searchParams.get('id'), id);
    assert.equal(url.searchParams.has('un'), false);
    assert.equal(normalizePortrait(`${id}?t=1773053660`), id);
    assert.equal(parsePanelResponse(panel('实际账号', 'male', { portrait: `${id}?t=1773053660` }), identity).gender, 'male');
    assert.equal(parsePanelResponse(panel('实际账号', 'female', { portrait: 'tb.1.fixture.other' }), identity).reason, 'identity-mismatch');
    assert.equal(parsePanelResponse(panel('实际账号', 'male'), identity).reason, 'identity-mismatch');
    assert.equal(parsePanelResponse(panel('实际账号', 'female', { portrait: id, is_private: 1 }), identity).reason, 'not-public');
    for (const value of ['opaque', `${id}?t=abc`, `${id}&un=其他账号`, 'tb.1.', `tb.1234.test`, `${id}?t=1&x=2`]) {
        assert.equal(normalizePortrait(value), null);
        assert.throws(() => buildProfileUrl({ kind: 'portrait', value }), TypeError);
    }
});

test('账号名和 portrait 同字面值也不会共用缓存；长 portrait 可持久化恢复', async () => {
    const id = `tb.1.${'a'.repeat(160)}`;
    const username = { kind: 'username', value: 'tb.1.same' };
    const portrait = { kind: 'portrait', value: 'tb.1.same' };
    assert.notEqual(identityKey(username), identityKey(portrait));
    const cache = createCache();
    cache.set(identityKey({ kind: 'portrait', value: id }), { gender: 'female', reason: 'public' });
    const restored = createCache({ initial: cache.snapshot() });
    assert.equal(restored.get(identityKey({ kind: 'portrait', value: id })).gender, 'female');
    const calls = [];
    const lookup = createLookup({ cache, enqueue: createQueue({ intervalMs: 0 }), request: async (identity) => {
        calls.push(identity.kind);
        return { gender: identity.kind === 'username' ? 'male' : 'female', reason: 'public' };
    } });
    assert.equal((await lookup(username)).gender, 'male');
    assert.equal((await lookup(portrait)).gender, 'female');
    assert.deepEqual(calls, ['username', 'portrait']);
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

test('关闭后跳过未发出的排队请求且不缓存关闭状态；恢复后可查询', async () => {
    const cache = createCache();
    let enabled = true;
    let release;
    const calls = [];
    const lookup = createLookup({ cache, shouldRequest: () => enabled,
        enqueue: createQueue({ concurrency: 1, intervalMs: 0 }), request: (name) => {
            calls.push(name);
            return new Promise((resolve) => { release = resolve; });
        } });
    const first = lookup('首个账号');
    const waiting = lookup('排队账号');
    await turn();
    enabled = false;
    release({ gender: 'male', reason: 'public' });
    await first;
    assert.equal((await waiting).reason, 'disabled');
    assert.deepEqual(calls, ['首个账号']);
    assert.equal(cache.get('排队账号'), null);
    enabled = true;
    const resumed = lookup('排队账号');
    await turn();
    release({ gender: 'female', reason: 'public' });
    assert.equal((await resumed).gender, 'female');
    assert.deepEqual(calls, ['首个账号', '排队账号']);
});

test('限流时整条队列暂停一分钟，到期后原排队账号自动查询且不缓存冷却状态', async () => {
    const clock = createClock();
    const names = [];
    const cache = createCache({ now: clock.now });
    const lookup = createLookup({ cache, now: clock.now,
        enqueue: createQueue({ concurrency: 1, intervalMs: 0, ...clock }),
        request: async (name) => {
            names.push(name);
            return names.length === 1 ? { gender: 'unknown', reason: 'rate-limited' } :
                { gender: 'male', reason: 'public' };
        } });
    const first = lookup('限流账号');
    const waiting = lookup('排队账号');
    const another = lookup('第二个排队账号');
    await clock.advance(0);
    assert.equal((await first).retryAt, CONFIG.cooldownMs);
    assert.deepEqual(names, ['限流账号']);
    assert.equal(cache.snapshot().entries.length, 0);
    await clock.advance(CONFIG.cooldownMs - 1);
    assert.deepEqual(names, ['限流账号']);
    await clock.advance(1);
    assert.equal((await waiting).gender, 'male');
    assert.equal((await another).gender, 'male');
    assert.equal((await lookup('限流账号')).gender, 'male');
    assert.deepEqual(names, ['限流账号', '排队账号', '第二个排队账号', '限流账号']);
});

test('最近使用的吧友优先保留，顺序可持久化，但读取不延长资料到期时间', () => {
    let time = 0;
    const cache = createCache({ maxEntries: 2, now: () => time });
    cache.set('常见吧友', { gender: 'male', reason: 'public' });
    cache.set('偶遇吧友', { gender: 'female', reason: 'public' });
    time = 1000;
    assert.equal(cache.get('常见吧友').gender, 'male');
    const restored = createCache({ maxEntries: 2, now: () => time, initial: cache.snapshot() });
    restored.set('新吧友', { gender: 'unknown', reason: 'not-public' });
    assert.equal(restored.get('偶遇吧友'), null);
    assert.equal(restored.get('常见吧友').gender, 'male');
    time = CONFIG.knownTtlMs;
    assert.equal(restored.get('常见吧友'), null);
});

test('升级时保留有效资料，丢弃旧版缓存中的冷却和取消状态', () => {
    const entries = ['public', 'cooldown', 'disabled', 'rate-limited', 'access-denied', 'invalid-response', 'redirected']
        .map(reason => [reason, { gender: reason === 'public' ? 'female' : 'unknown', reason, expiresAt: 5000 }]);
    const cache = createCache({ now: () => 0, initial: { version: 1, entries } });
    assert.deepEqual(cache.snapshot().entries.map(([key]) => key), ['public']);
    cache.set('cold', { gender: 'unknown', reason: 'cooldown' });
    assert.equal(cache.get('cold'), null);
});

test('整批旧任务取消后不消耗启动间隔，新请求仍遵守原有速率限制', async () => {
    const clock = createClock();
    const enqueue = createQueue({ intervalMs: 900, concurrency: 1, ...clock });
    const calls = [];
    const first = enqueue(() => calls.push(['first', clock.now()]));
    const controllers = Array.from({ length: 20 }, () => new AbortController());
    const stale = controllers.map(controller => enqueue(() => calls.push(['stale', clock.now()]),
        { signal: controller.signal }));
    await clock.advance(0);
    for (const controller of controllers) controller.abort();
    const fresh = enqueue(() => calls.push(['fresh', clock.now()]));
    await clock.advance(899);
    assert.deepEqual(calls, [['first', 0]]);
    await clock.advance(1);
    await Promise.all([first, fresh, ...stale]);
    assert.deepEqual(calls, [['first', 0], ['fresh', 900]]);
});

test('重试不会绕过冷却，旧请求迟到结果不会回写或删除新请求的去重记录', async () => {
    const clock = createClock();
    const cache = createCache({ now: clock.now });
    const responses = [];
    const lookup = createLookup({ cache, now: clock.now,
        enqueue: createQueue({ concurrency: 2, intervalMs: 0, ...clock }),
        request: () => new Promise(resolve => responses.push(resolve)) });
    const old = lookup('同一账号');
    await clock.advance(0);
    lookup.invalidate();
    const fresh = lookup('同一账号');
    await clock.advance(0);
    responses[0]({ gender: 'male', reason: 'public' });
    await clock.advance(0);
    assert.equal((await old).reason, 'disabled');
    assert.equal(cache.get('同一账号'), null);
    assert.equal(lookup('同一账号'), fresh);
    responses[1]({ gender: 'unknown', reason: 'rate-limited' });
    await clock.advance(0);
    assert.equal((await fresh).retryAt, CONFIG.cooldownMs);
    lookup.invalidate();
    const retry = lookup('同一账号');
    await clock.advance(CONFIG.cooldownMs - 1);
    assert.equal(responses.length, 2);
    await clock.advance(1);
    assert.equal(responses.length, 3);
    responses[2]({ gender: 'female', reason: 'public' });
    await clock.advance(0);
    assert.equal((await retry).gender, 'female');
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
