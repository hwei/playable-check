'use strict';
/*
 * Static checks for a playable ad zip package.
 * Mirrors the rules enforced by Mintegral's official self-service test tool
 * (https://www.playturbo.com/review), reimplemented locally so they can run
 * in CI without depending on Mintegral's server-side API.
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const MAX_ZIP_BYTES = 5 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9_]+$/;

function fmtKB(n) {
  return (n / 1024).toFixed(1) + ' KB';
}

function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function runStaticChecks(zipPath) {
  const checks = [];
  const push = (id, name, status, detail) =>
    checks.push({ id, name, status, detail: detail || '' });
  const base = path.basename(zipPath, path.extname(zipPath));

  const done = (htmlRelPath) => {
    const failed = checks.filter((c) => c.status === 'fail').length;
    const warned = checks.filter((c) => c.status === 'warn').length;
    return { checks, failed, warned, htmlRelPath: htmlRelPath || null };
  };

  let stat = null;
  try {
    stat = fs.statSync(zipPath);
  } catch (e) {
    push('zip-readable', 'ZIP is readable', 'fail', e.message);
    return done();
  }
  push('zip-size', 'ZIP size <= 5MB',
    stat.size <= MAX_ZIP_BYTES ? 'pass' : 'fail', fmtKB(stat.size));
  push('zip-name', 'ZIP name charset [A-Za-z0-9_]', NAME_RE.test(base) ? 'pass' : 'fail', base);

  let entries;
  try {
    entries = new AdmZip(zipPath).getEntries()
      .filter((e) => !e.isDirectory)
      .map((e) => e.entryName);
  } catch (e) {
    push('zip-parse', 'ZIP is parseable', 'fail', e.message);
    return done();
  }
  push('zip-parse', 'ZIP is parseable', 'pass', entries.length + ' file(s)');

  const tops = [...new Set(entries.map((n) => n.split('/')[0]))];
  const singleFolder = tops.length === 1 && entries.every((n) => n.includes('/'));
  push('folder-name', 'Single top-level folder, name == zip name',
    singleFolder && tops[0] === base ? 'pass' : 'fail',
    tops.join(', ') || '(none)');

  const htmls = entries.filter((n) => n.toLowerCase().endsWith('.html'));
  const htmlOk = htmls.length === 1 && path.basename(htmls[0], '.html') === base;
  push('single-html', 'Exactly one HTML, name == zip name',
    htmlOk ? 'pass' : 'fail', htmls.join(', ') || '(none)');

  const others = entries.filter((n) => !n.toLowerCase().endsWith('.html'));
  if (others.length) {
    push('extra-files', 'No extra files besides the HTML', 'warn', others.join(', '));
  }

  let html = '';
  let htmlRelPath = htmlOk ? htmls[0] : null;
  if (htmlRelPath) {
    try {
      html = new AdmZip(zipPath).readAsText(htmlRelPath);
      push('html-readable', 'HTML is readable', 'pass', fmtKB(html.length));
    } catch (e) {
      push('html-readable', 'HTML is readable', 'fail', e.message);
      return done();
    }
  }

  if (html) {
    const code = stripComments(html);

    const extRes = [
      /src\s*=\s*["']https?:\/\//i,
      /href\s*=\s*["']https?:\/\//i,
      /src\s*=\s*["']\/\//,
      /href\s*=\s*["']\/\//,
      /url\(\s*["']?https?:\/\//i,
      /\bfetch\s*\(\s*["']https?:\/\//i,
      /\bimport\s*\(\s*["']https?:\/\//i,
    ];
    const hits = extRes
      .map((re) => { const m = code.match(re); return m ? m[0].slice(0, 48) : null; })
      .filter(Boolean);
    push('no-external-requests', 'No external network requests',
      hits.length ? 'fail' : 'pass', hits.length ? hits.join(' | ') : 'none found');

    push('charset', 'meta charset=utf-8',
      /<meta[^>]+charset\s*=\s*["']?utf-8/i.test(code) ? 'pass' : 'fail', '');
    push('viewport', 'meta viewport present',
      /<meta[^>]+name\s*=\s*["']viewport/i.test(code) ? 'pass' : 'fail', '');

    push('no-console-override', 'Global console not overridden',
      /\bconsole\s*=(?!=)/.test(code) ? 'fail' : 'pass', '');

    const redirRes = [
      /location\s*=\s*["']/,
      /location\.href\s*=/,
      /location\.(replace|assign)\s*\(/,
      /window\.open\s*\(/,
      /<meta[^>]+http-equiv\s*=\s*["']refresh/i,
    ];
    const rhits = redirRes
      .map((re) => { const m = code.match(re); return m ? m[0].slice(0, 48) : null; })
      .filter(Boolean);
    push('no-auto-redirect', 'No auto-redirect outside click path',
      rhits.length ? 'fail' : 'pass', rhits.length ? rhits.join(' | ') : 'none found');

    push('cta-method', 'CTA method present (install / mraid.open)',
      /install\s*\(|mraid\.open\s*\(/.test(code) ? 'pass' : 'warn', '');

    // --- MRAID 3.0 best-practice checks (IAB MRAID 3.0 Best Practices Guide) ---
    // Only active when the creative actually uses MRAID; Mintegral-style
    // packages (no mraid usage) are unaffected.
    const usesMraid = /\bmraid\./.test(code);

    // IAB: hyperlinks must not be used with MRAID ads; always mraid.open().
    const linkHits = [...code.matchAll(/<a\b[^>]*\bhref\s*=\s*["']https?:[^"']*["'][^>]*>/gi)]
      .map((m) => m[0].slice(0, 60));
    push('mraid-no-hyperlink', 'No hyperlinks when MRAID is used (use mraid.open())',
      !usesMraid ? 'pass' : (linkHits.length ? 'fail' : 'pass'),
      linkHits.length ? linkHits.join(' | ')
        : (usesMraid ? 'mraid used, no <a href=http>' : 'mraid not used'));

    // IAB: creative must add an MRAID ready event listener before calling MRAID APIs.
    const hasReadyGate = /addEventListener\s*\(\s*["']ready["']/.test(code)
      || /\bmraid\.getState\s*\(\s*\)/.test(code)
      || /function\s+\w*[Rr]eady\w*\s*\(/.test(code);
    const mraidCalls = (code.match(/\bmraid\.[a-zA-Z]+\s*\(/g) || []).length;
    push('mraid-ready-gate', 'MRAID calls gated behind ready listener',
      !usesMraid ? 'pass' : (hasReadyGate ? 'pass' : 'warn'),
      mraidCalls + ' mraid.*() call(s)'
        + (hasReadyGate ? ', ready gate found' : ', no ready gate found'));
  }

  return done(htmlRelPath);
}

module.exports = { runStaticChecks };
