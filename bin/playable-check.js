#!/usr/bin/env node
'use strict';
/*
 * playable-check <playable.zip> [--skip-dynamic] [--fail-on-warn]
 *
 * Static package checks always run. Dynamic checks (headless Chromium)
 * run unless --skip-dynamic is given. Exit 0 on pass, 1 on fail.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { runStaticChecks } = require('../checks/static');
const { runDynamicChecks } = require('../checks/dynamic');

function printSection(title, checks) {
  console.log('## ' + title);
  for (const c of checks) {
    const mark = c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'WARN';
    console.log(`  ${mark}  ${c.id} — ${c.name}${c.detail ? ' (' + c.detail + ')' : ''}`);
  }
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  const zipArg = args.find((a) => !a.startsWith('--'));
  const skipDynamic = args.includes('--skip-dynamic');
  const failOnWarn = args.includes('--fail-on-warn');
  if (!zipArg) {
    console.error('Usage: playable-check <playable.zip> [--skip-dynamic] [--fail-on-warn]');
    process.exit(2);
  }
  const abs = path.resolve(zipArg);
  console.log('# playable-check  ' + abs + '\n');

  const s = runStaticChecks(abs);
  printSection('Static checks', s.checks);
  let failed = s.failed;
  let warned = s.warned;

  if (!skipDynamic && s.failed === 0 && s.htmlRelPath) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playable-check-'));
    try {
      new AdmZip(abs).extractAllTo(dir, true);
      const d = await runDynamicChecks(path.join(dir, s.htmlRelPath));
      printSection('Dynamic checks (headless Chromium)', d.checks);
      failed += d.failed;
      warned += d.warned;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } else if (!skipDynamic) {
    console.log('(dynamic checks skipped: static checks failed or no HTML found)\n');
  }

  const effectiveFailed = failed + (failOnWarn ? warned : 0);
  console.log(`Result: ${effectiveFailed === 0 ? 'PASS' : 'FAIL'}  (${failed} failed, ${warned} warnings)`);
  process.exit(effectiveFailed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('playable-check crashed: ' + (e && e.message));
  process.exit(1);
});
