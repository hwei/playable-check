'use strict';
/*
 * Dynamic checks: load the playable in headless Chromium, simulate the ad
 * container (gameReady/gameStart/gameClose/gameEnd/install shims), auto-play
 * it to completion, and assert the container-API call sequence.
 *
 * Auto-play uses the optional `window.__qa` hook convention (see README.md):
 *   __qa.state()    -> { playing: bool, ... }
 *   __qa.popAll()   -> eliminate on-screen targets, return count
 *   __qa.clickCTA() -> click the currently visible CTA
 * Without the hook, dynamic sequence checks are skipped (warn), but load,
 * console-error and perf checks still run.
 */
const { chromium } = require('playwright');

const PAGE_APIS = ['gameStart', 'gameClose']; // defined BY the playable; wrapped after load

async function runDynamicChecks(htmlPath, opts = {}) {
  const checks = [];
  const push = (id, name, status, detail) =>
    checks.push({ id, name, status, detail: detail || '' });
  const done = () => {
    const failed = checks.filter((c) => c.status === 'fail').length;
    const warned = checks.filter((c) => c.status === 'warn').length;
    return { checks, failed, warned };
  };

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push('console.error: ' + msg.text().slice(0, 200));
    });

    // Container shims installed BEFORE page scripts run. The playable calls
    // these (guarded by existence checks); we record every call with a timestamp.
    await page.addInitScript(() => {
      window.__pc_calls = [];
      const rec = (name) => (...args) => {
        window.__pc_calls.push({ name, t: Date.now(), args: args.length });
      };
      window.gameReady = rec('gameReady');
      window.gameEnd = rec('gameEnd');
      window.gameRetry = rec('gameRetry');
      window.install = rec('install');
    });

    const t0 = Date.now();
    await page.goto('file://' + htmlPath, { waitUntil: 'load' });
    push('load', 'Page loads without exception', 'pass', Date.now() - t0 + ' ms');

    // Wrap page-defined globals AFTER load so the page's own assignments win first.
    await page.evaluate((apis) => {
      const rec = (name, orig) => {
        const w = function (...args) {
          window.__pc_calls.push({ name, t: Date.now(), args: args.length });
          return orig.apply(this, args);
        };
        w.__pc_wrapped = true;
        return w;
      };
      for (const name of apis) {
        if (typeof window[name] === 'function' && !window[name].__pc_wrapped) {
          window[name] = rec(name, window[name]);
        }
      }
    }, PAGE_APIS);

    const callCount = (name) =>
      page.evaluate((n) => window.__pc_calls.filter((c) => c.name === n).length, name);

    await page.waitForTimeout(1500);
    let n = await callCount('gameReady');
    push('game-ready', 'gameReady() called after load', n > 0 ? 'pass' : 'fail', n + ' call(s)');

    // Simulate the container starting the playable.
    const hasGameStart = await page.evaluate(() => typeof window.gameStart === 'function');
    if (hasGameStart) await page.evaluate(() => window.gameStart());
    else await page.waitForTimeout(2000); // rely on local fallback auto-start
    push('game-start', 'gameStart() invoked (container simulation)',
      hasGameStart ? 'pass' : 'warn',
      hasGameStart ? 'called by harness' : 'no gameStart exposed; used fallback wait');

    const hasQa = await page.evaluate(() =>
      !!(window.__qa && window.__qa.popAll && window.__qa.state && window.__qa.clickCTA));

    let played = false;
    if (hasQa) {
      // FPS sample DURING gameplay: sample for 3s while popping targets.
      const fpsP = page.evaluate(() => new Promise((resolve) => {
        let frames = 0;
        const t0 = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
          else resolve(Math.round(frames / 3));
        };
        requestAnimationFrame(tick);
      }));
      const fpsDeadline = Date.now() + 3300;
      while (Date.now() < fpsDeadline) {
        await page.evaluate(() => window.__qa.popAll());
        await page.waitForTimeout(300);
      }
      const fps = await fpsP;
      push('perf-fps', 'Render FPS during gameplay (3s sample, headless)',
        fps >= 30 ? 'pass' : 'warn', fps + ' fps');

      // Finish the game.
      const deadline = Date.now() + 60000;
      for (;;) {
        const st = await page.evaluate(() => window.__qa.state());
        if (!st.playing) break;
        await page.evaluate(() => window.__qa.popAll());
        if (Date.now() > deadline) break;
        await page.waitForTimeout(300);
      }
      played = true;
      const st = await page.evaluate(() => window.__qa.state());
      push('autoplay', 'Auto-play to completion via __qa',
        st.playing ? 'fail' : 'pass',
        st.playing ? 'timed out before game end' : 'reached end screen, score ' + st.score + '/' + st.target);
    } else {
      push('autoplay', 'Auto-play hook (__qa) present', 'warn',
        'skipped dynamic sequence; add window.__qa (see README) for full CI');
    }

    if (played) {
      n = await callCount('gameEnd');
      push('game-end', 'gameEnd() called on finish', n > 0 ? 'pass' : 'fail', n + ' call(s)');

      // Real trusted mouse click on the visible end-screen CTA.
      const pt = await page.evaluate(() => {
        const btn = document.getElementById('winCta') ||
                    document.getElementById('loseCta') ||
                    document.getElementById('ctaPersist');
        if (!btn || btn.offsetParent === null) return null;
        const r = btn.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      let clickT = 0;
      if (pt) {
        await page.mouse.click(pt.x, pt.y);
        clickT = Date.now();
      } else {
        await page.evaluate(() => window.__qa.clickCTA());
        clickT = Date.now();
      }
      await page.waitForTimeout(800);

      const installs = await page.evaluate(() => window.__pc_calls.filter((c) => c.name === 'install'));
      const before = installs.filter((c) => c.t < clickT - 200).length;
      const after = installs.filter((c) => c.t >= clickT - 200).length;
      push('cta-click', 'install() fired from CTA click', after > 0 ? 'pass' : 'fail', after + ' call(s) after click');
      push('no-auto-redirect', 'install() never fired before any click', before === 0 ? 'pass' : 'fail', before + ' call(s) before click');

      await page.evaluate(() => { if (typeof window.gameClose === 'function') window.gameClose(); });
      n = await callCount('gameClose');
      push('game-close', 'gameClose() handled', n > 0 ? 'pass' : 'warn', n + ' call(s)');

      const heapMB = await page.evaluate(() =>
        performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1);
      push('perf-heap', 'JS heap after playthrough',
        heapMB < 0 ? 'warn' : heapMB < 100 ? 'pass' : 'warn',
        heapMB < 0 ? 'n/a in this browser' : heapMB + ' MB');
    }

    push('code-exception', 'No uncaught exceptions / console errors',
      errors.length === 0 ? 'pass' : 'fail',
      errors.length === 0 ? 'clean' : errors.slice(0, 5).join(' | '));
  } finally {
    await browser.close();
  }
  return done();
}

module.exports = { runDynamicChecks };
