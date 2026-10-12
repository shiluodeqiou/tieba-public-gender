'use strict';

// 虚拟时钟让一分钟冷却、请求间隔和缓存到期在测试中确定性运行。
module.exports = function createClock() {
    let time = 0;
    let serial = 0;
    const timers = new Map();
    const now = () => time;
    const setTimer = (fn, delay = 0) => {
        const id = ++serial;
        timers.set(id, { fn, due: time + Math.max(0, Number(delay)) });
        return id;
    };
    const clearTimer = id => timers.delete(id);
    async function advance(delta) {
        const target = time + delta;
        for (let count = 0; count < 10000; count++) {
            await new Promise(resolve => setImmediate(resolve));
            const next = [...timers].filter(([, timer]) => timer.due <= target)
                .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
            if (!next) {
                time = target;
                await new Promise(resolve => setImmediate(resolve));
                return;
            }
            timers.delete(next[0]);
            time = next[1].due;
            next[1].fn();
        }
        throw new Error('虚拟时钟任务未能收敛');
    }
    return { now, setTimer, clearTimer, advance };
};
