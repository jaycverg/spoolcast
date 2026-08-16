#!/usr/bin/env node
/**
 * `spoolcast` command dispatcher.
 *
 * Subcommands are loaded with dynamic `import()` rather than a static one: each
 * entry module invokes its own `main()` at import time, so importing it *is*
 * running it, and a static import would run every command on every invocation.
 * Flags are left in `process.argv` for the entry module to parse.
 */

import fs from 'node:fs';

const USAGE = `spoolcast — spool folder → scheduled YouTube & Facebook uploads

Usage
  spoolcast run [--dry-run] [--force <key>]   Upload every queued item not yet posted
  spoolcast auth youtube [--alias <name>]     Authorize a YouTube channel
  spoolcast auth facebook [--alias <name>]    Authorize a Facebook Page
  spoolcast help                              Show this message
  spoolcast --version                         Print the installed version

Layout
  Reads ./queue and ./.secrets relative to the current directory.
  Set SPOOLCAST_HOME to point at a different working root.

Docs
  https://github.com/jaycverg/spoolcast
`;

/** The package's own version, read from the manifest shipped alongside dist/. */
function version(): string {
  const manifest = new URL('../package.json', import.meta.url);
  return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
}

function fail(message: string): never {
  console.error(message);
  console.error(`\nRun \`spoolcast help\` for usage.`);
  process.exit(1);
}

const [command, subcommand] = process.argv.slice(2);

switch (command) {
  case 'run':
    await import('./run.js');
    break;

  case 'auth':
    if (subcommand === 'youtube') await import('./auth-youtube.js');
    else if (subcommand === 'facebook') await import('./auth-facebook.js');
    else fail(`Unknown auth target: ${subcommand ?? '(none)'}. Expected "youtube" or "facebook".`);
    break;

  case 'help':
  case '--help':
  case '-h':
  case undefined:
    console.log(USAGE);
    break;

  case '--version':
  case '-v':
    console.log(version());
    break;

  default:
    fail(`Unknown command: ${command}`);
}
