#!/usr/bin/env node
/**
 * Fails when a tracked file contains a string shaped like a real vendor API key.
 *
 * GitHub's push protection already catches these, but only at push time — after a
 * commit is made, which then has to be amended. This catches it in `pnpm verify`,
 * seconds after writing it.
 *
 * The rule is about SHAPE, not about whether a particular string is live. A test
 * fixture with a real key's exact shape is indistinguishable from a leaked key to a
 * scanner and to the next person who reads the file, so it does not belong in the
 * repo even when it is invented. Use an obviously-fake prefix instead
 * (`key_live_EXAMPLEONLY…`), or a short placeholder body.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Vendor prefixes followed by a long, high-entropy-looking body. The length
 * thresholds are what separate a plausible key from a placeholder: our own tests
 * legitimately need `sk_test_abcdefghijklmnop` to check that the SDK constructor
 * rejects a publishable key, and that is nowhere near a real key's length.
 */
const PATTERNS = [
  { name: 'Stripe-style secret key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/ },
  { name: 'Stripe-style publishable key', pattern: /\bpk_(?:live|test)_[A-Za-z0-9]{24,}\b/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

/** Files whose whole job is to describe these patterns. */
const ALLOWED = new Set(['scripts/check-fixtures.mjs', 'packages/engine/src/mapping/scrub.ts']);

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => !ALLOWED.has(file))
  .filter((file) => !/\.(png|jpe?g|gif|webp|ico|woff2?|pdf)$/i.test(file));

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // binary or unreadable; nothing to scan
  }
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    for (const { name, pattern } of PATTERNS) {
      if (pattern.test(line)) findings.push({ file, line: index + 1, name });
    }
  }
}

if (findings.length > 0) {
  console.error('Strings shaped like real API keys found in tracked files:\n');
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line} — looks like a ${finding.name}`);
  }
  console.error(
    '\nEven an invented one does not belong here: a scanner and the next reader cannot\n' +
      'tell it from a leak. Use an obviously-fake prefix (key_live_EXAMPLEONLY…) or a\n' +
      'short placeholder body.',
  );
  process.exit(1);
}

console.log(`Fixture check passed: ${files.length} tracked files, no key-shaped strings.`);
