// ==UserScript==
// @name         薪火任务雷达
// @namespace    https://xinhuo123.com
// @version      1.0.0
// @description  实时监控薪火平台新任务，发现后桌面弹窗提醒，页面内标记新增
// @author       x_hunt
// @match        https://xinhuo123.com/tasks
// @match        https://xinhuo123.com/tasks?*
// @icon         https://xinhuo123.com/xinhuo-mark-v2.png
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-end
// ==/UserScript==

/* global GM_notification, GM_setValue, GM_getValue, GM_deleteValue */

(function () {
    'use strict';

    // ── 配置 ────────────────────────────────────────
    const CONFIG = {
        POLL_INTERVAL: 15_000,        // 轮询间隔 ms（15秒）
        INITIAL_DELAY: 2_000,         // 首次扫描延迟（等 SPA 渲染）
        STORAGE_KEY: 'xinhuo_known_ids', // localStorage 键名
        GM_STORAGE_KEY: 'xinhuo_notif_count', // GM 存储：累计通知数
        MAX_STORED_IDS: 500,          // 最多记住多少个任务 ID
        PAGE_INDICATOR: true,         // 是否在页面展示已发现任务数
    };

    // ── 状态 ────────────────────────────────────────
    let knownIds = new Set();
    let running = false;
    let pollingTimer = null;

    // ── 从 localStorage 恢复已知 ID ──────────────────
    function loadKnownIds() {
        try {
            const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
            if (raw) {
                const arr = JSON.parse(raw);
                knownIds = new Set(arr);
                log(`已加载 ${knownIds.size} 个已知任务 ID`);
            } else {
                log('首次运行，暂无已知任务');
            }
        } catch (e) {
            log('加载已知 ID 失败，从零开始', e);
            knownIds = new Set();
        }
    }

    // ── 持久化已知 ID ───────────────────────────────
    function saveKnownIds() {
        const arr = [...knownIds].slice(-CONFIG.MAX_STORED_IDS);
        try {
            localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(arr));
        } catch (e) {
            // localStorage 满了，裁剪
            const trimmed = arr.slice(-200);
            localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(trimmed));
        }
    }

    // ── 桌面通知 ─────────────────────────────────────
    function notify(task) {
        const title = `🔥 薪火新任务 · ${task.project_name}`;
        const body = [
            `类型: ${task.type === 'COMMENT' ? '评论互动' : task.type}`,
            `等级区间: ${formatTiers(task.tier_config)}`,
            `状态: ${task.status === 'ACTIVE' ? '进行中' : task.status}`,
            `发布者: @${task.publisher_handle || '未知'}`,
        ].join('\n');

        // 优先用 GM_notification（可跨标签页），退化到标准 Notification
        if (typeof GM_notification !== 'undefined') {
            GM_notification({
                title,
                text: body,
                timeout: 8000,
                onclick: () => {
                    // 点击通知直接切回薪火页面
                    window.focus();
                },
                silent: false,
            });
        } else if (Notification.permission === 'granted') {
            const n = new Notification(title, {
                body,
                icon: 'https://xinhuo123.com/xinhuo-mark-v2.png',
                tag: `xinhuo-task-${task.id}`,
                requireInteraction: false,
            });
            n.onclick = () => window.focus();
            setTimeout(() => n.close(), 8000);
        }

        // 累计计数
        try {
            if (typeof GM_getValue !== 'undefined') {
                const count = (GM_getValue(CONFIG.GM_STORAGE_KEY, 0) || 0) + 1;
                GM_setValue(CONFIG.GM_STORAGE_KEY, count);
            }
        } catch (_) { /* ignore */ }

        log(`🔔 通知已发送: ${task.project_name} (${task.id})`);
    }

    // ── 注册新发现的任务 ─────────────────────────────
    function registerNewTask(task) {
        if (knownIds.has(task.id)) return false;
        knownIds.add(task.id);
        saveKnownIds();
        return true;
    }

    // ── 请求通知权限 ─────────────────────────────────
    function requestNotificationPermission() {
        if (typeof GM_notification !== 'undefined') {
            // GM_notification 不需要浏览器权限
            return Promise.resolve(true);
        }
        if (Notification.permission === 'granted') return Promise.resolve(true);
        if (Notification.permission === 'denied') {
            log('⚠️ 通知权限已被拒绝，请在浏览器设置中允许');
            return Promise.resolve(false);
        }
        return Notification.requestPermission().then(perm => {
            const ok = perm === 'granted';
            if (!ok) log('⚠️ 未获得通知权限');
            return ok;
        });
    }

    // ── 格式化等级区间 ───────────────────────────────
    function formatTiers(tierConfig) {
        if (!tierConfig) return '未知';
        const tiers = ['S', 'A', 'B', 'C', 'D', 'E'];
        const active = tiers.filter(t => tierConfig[t] && tierConfig[t].seats > 0);
        if (active.length === 0) {
            const priced = tiers.filter(t => tierConfig[t] && tierConfig[t].price > 0);
            return priced.join('/');
        }
        return active.join('/');
    }

    // ── 获取任务唯一指纹 ─────────────────────────────
    // 有些平台可能复用 ID，用 id + created_at 组合更保险
    function getTaskFingerprint(task) {
        return task.id;
    }

    // ── 核心：扫描新任务 ─────────────────────────────
    async function scan() {
        try {
            const resp = await fetch('/api/tasks', {
                credentials: 'include',
                headers: { 'Accept': 'application/json' },
            });

            if (!resp.ok) {
                log(`API 返回 ${resp.status}，跳过本轮`);
                return;
            }

            const data = await resp.json();
            if (!data.tasks || !Array.isArray(data.tasks)) {
                log('API 响应格式异常');
                return;
            }

            const tasks = data.tasks;
            log(`扫描完成: ${tasks.length} 个任务`);

            const newTasks = [];
            for (const task of tasks) {
                const fp = getTaskFingerprint(task);
                // 首次运行：只收录不通知，避免刷屏
                if (knownIds.size === 0) {
                    knownIds.add(fp);
                    continue;
                }
                if (!knownIds.has(fp)) {
                    knownIds.add(fp);
                    newTasks.push(task);
                }
            }

            saveKnownIds();

            if (knownIds.size === 0 && tasks.length > 0) {
                // 首次运行：静默收录所有任务
                log(`✅ 首次收录 ${tasks.length} 个任务，后续有新任务会通知你`);
            }

            if (newTasks.length > 0) {
                for (const task of newTasks) {
                    notify(task);
                    // 间隔 500ms 避免通知轰炸
                    await sleep(500);
                }
                updateIndicator();
            }
        } catch (err) {
            log('扫描出错:', err.message);
        }
    }

    // ── 页面指示器（在页面右上角显示监控状态）───────
    let indicatorEl = null;

    function createIndicator() {
        if (!CONFIG.PAGE_INDICATOR) return;

        const el = document.createElement('div');
        el.id = 'xinhuo-radar-indicator';
        el.innerHTML = `
            <div style="
                position: fixed;
                bottom: 24px;
                right: 24px;
                z-index: 99999;
                background: linear-gradient(135deg, #1a1a2e, #16213e);
                color: #e0e0e0;
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 12px;
                padding: 10px 16px;
                font-size: 13px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                box-shadow: 0 4px 24px rgba(0,0,0,0.3);
                cursor: default;
                user-select: none;
                transition: all 0.3s ease;
            ">
                <span id="xinhuo-radar-dot" style="
                    display: inline-block;
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: #22c55e;
                    margin-right: 8px;
                    animation: xinhuo-pulse 2s infinite;
                "></span>
                <span id="xinhuo-radar-text">薪火雷达 · 监控中 · ${knownIds.size} 个已知任务</span>
            </div>
            <style>
                @keyframes xinhuo-pulse {
                    0%, 100% { opacity: 1; transform: scale(1); }
                    50% { opacity: 0.5; transform: scale(0.85); }
                }
            </style>
        `;
        document.body.appendChild(el);
        indicatorEl = el;
    }

    function updateIndicator() {
        if (!indicatorEl) return;
        const textEl = indicatorEl.querySelector('#xinhuo-radar-text');
        if (textEl) {
            textEl.textContent = `薪火雷达 · 监控中 · ${knownIds.size} 个已知任务`;
        }
        // 闪烁一下绿点表示活动
        const dot = indicatorEl.querySelector('#xinhuo-radar-dot');
        if (dot) {
            dot.style.background = '#f59e0b';
            setTimeout(() => { dot.style.background = '#22c55e'; }, 600);
        }
    }

    // ── 工具函数 ─────────────────────────────────────
    function log(...args) {
        console.log('[薪火雷达]', ...args);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ── 启动 / 停止 ──────────────────────────────────
    async function start() {
        if (running) return;
        running = true;

        log('🚀 启动薪火任务雷达');

        const permOk = await requestNotificationPermission();
        if (!permOk && typeof GM_notification === 'undefined') {
            log('⚠️ 无通知权限，将以静默模式运行（仅收录不提醒）');
        }

        loadKnownIds();
        createIndicator();

        // 首次延迟扫描（等 SPA 渲染完成）
        setTimeout(async () => {
            await scan();
        }, CONFIG.INITIAL_DELAY);

        // 定时轮询
        pollingTimer = setInterval(scan, CONFIG.POLL_INTERVAL);
    }

    function stop() {
        running = false;
        if (pollingTimer) {
            clearInterval(pollingTimer);
            pollingTimer = null;
        }
        log('⏹️ 已停止');
    }

    // ── SPA 路由检测 ─────────────────────────────────
    // 薪火是 Next.js 客户端路由，用户可能从其他页面切到 /tasks
    // 用 MutationObserver 监听 URL 变化
    function watchRouteChange() {
        let lastUrl = location.href;

        // 方法1：劫持 history API
        const origPush = history.pushState;
        history.pushState = function (...args) {
            origPush.apply(this, args);
            onUrlChange();
        };
        const origReplace = history.replaceState;
        history.replaceState = function (...args) {
            origReplace.apply(this, args);
            onUrlChange();
        };
        window.addEventListener('popstate', onUrlChange);

        // 方法2：body class 变化（Next.js 路由切换时会变）
        const observer = new MutationObserver(() => {
            if (location.href !== lastUrl) onUrlChange();
        });
        observer.observe(document.body, { attributes: true, subtree: false });

        function onUrlChange() {
            if (location.href === lastUrl) return;
            lastUrl = location.href;
            if (/\/tasks(\?|$|#)/.test(location.href)) {
                log('检测到路由切换到 /tasks，重新扫描');
                loadKnownIds();
                setTimeout(scan, CONFIG.INITIAL_DELAY);
            } else {
                log('已离开 /tasks，暂停');
                stop();
            }
        }
    }

    // ── 全局控制台命令 ───────────────────────────────
    // 在浏览器控制台中可用:
    //   __xinhuoRadar.status()   — 查看状态
    //   __xinhuoRadar.reset()    — 重置已知任务（下次所有任务都算新）
    //   __xinhuoRadar.scan()     — 立即扫描一次
    window.__xinhuoRadar = {
        status() {
            console.table({
                '运行状态': running ? '监控中 ✅' : '已停止 ⏹️',
                '已知任务数': knownIds.size,
                '轮询间隔': `${CONFIG.POLL_INTERVAL / 1000}s`,
                '通知权限': typeof GM_notification !== 'undefined' ? 'GM_notification' : Notification.permission,
                '当前 URL': location.href,
            });
        },
        reset() {
            knownIds.clear();
            localStorage.removeItem(CONFIG.STORAGE_KEY);
            if (typeof GM_deleteValue !== 'undefined') {
                GM_deleteValue(CONFIG.GM_STORAGE_KEY);
            }
            log('✅ 已重置，下次扫描所有任务将被视为新任务');
        },
        async scan() {
            log('🔍 手动触发扫描...');
            await scan();
        },
    };

    // ── 入口 ─────────────────────────────────────────
    log('脚本已加载，等待页面就绪...');
    watchRouteChange();

    // 页面加载后启动
    if (document.readyState === 'complete') {
        start();
    } else {
        window.addEventListener('load', start);
    }
})();
