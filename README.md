# playable-check

CI-friendly validator for HTML5 playable ads. Static package checks, headless
container-API checks, and perf scoring — runnable locally and in GitHub Actions,
with no dependency on any ad network's server-side test tool.

## Why

Official self-service test tools (e.g. Mintegral's) are free but single-channel,
server-side, and manual. This reimplements their check logic locally so it can
run on every push:

- **Static checks** — zip size ≤ 5MB, naming rules (`zip == folder == html`,
  `[A-Za-z0-9_]`), single HTML, no external network requests, `charset`/`viewport`
  metas, no `console` override, no auto-redirect, CTA method present,
  plus IAB MRAID 3.0 best practices when MRAID is used (no `<a href>` hyperlinks,
  MRAID calls gated behind a ready listener).
- **Dynamic checks (headless Chromium)** — simulates the ad container: asserts
  `gameReady()` on load, drives `gameStart()` → auto-play to completion → asserts
  `gameEnd()`, clicks the real CTA button and asserts `install()` fires **only**
  from that click (anti auto-redirect), asserts `gameClose()` handling, and fails
  on any uncaught exception / console error.
- **Perf scoring** — FPS sampled during gameplay + JS heap after playthrough
  (warnings, not failures; thresholds are yours to tune).

## Quick start

```bash
npm install
npx playwright install chromium
node bin/playable-check.js path/to/sampleA.zip
```

Opt-in Vungle/Liftoff profile (adds 12 network-specific static rules and relaxes
the Mintegral `zip==folder==html` layout rules; Adaptive-Creative-only items
report as warnings until a real submission confirms their scope):

```bash
node bin/playable-check.js path/to/creative.zip --profile vungle --skip-dynamic
```

As a GitHub Action in your creative repo:

```yaml
- uses: hwei/playable-check@v1
  with:
    zip: dist/sampleA.zip
```

## The `window.__qa` hook convention

Dynamic checks auto-play the creative through an optional, inert-unless-called
hook. Add this to your playable to get full CI coverage:

```js
window.__qa = {
  popAll: function () { /* eliminate on-screen targets; return count */ },
  clickCTA: function () { /* click the currently visible CTA */ },
  state: function () { return { playing: true, score: 0, target: 10 }; }
};
```

Without the hook, the tool still runs load / console-error / perf checks and
warns that the dynamic sequence was skipped.

## Test fixtures

This repo's own CI (`self-check` workflow) builds a minimal single-file
playable from `test/fixtures/minimal.html` into `fixture.zip` on the fly and
runs the full check suite against it — no binaries are committed.

For local dogfooding against real creatives, drop sample zips into
`test/fixtures/` (gitignored, `*.zip`) and run:

```bash
npm test   # runs the checker against test/fixtures/sampleA.zip and sampleB.zip
```

## License

MIT — see [LICENSE](LICENSE).
