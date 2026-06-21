/**
 * One-time Facebook Page token exchange flow.
 *
 * Run with: npm run auth:facebook
 *
 * Steps:
 *   1. Get a short-lived user token from Graph API Explorer
 *      (scopes: pages_show_list, pages_manage_posts, pages_read_engagement).
 *   2. Pass it as --token <value> or let the script prompt for it.
 *   3. The script exchanges it for a long-lived user token, lists your pages,
 *      and stores the selected page_id + page_token in .secrets/tokens.json.
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadFbAppCreds, loadTokens, saveTokens } from './tokens.js';
import { FB_GRAPH_VERSION } from './config.js';

interface GraphAccountsResponse {
  data: Array<{ id: string; name: string; access_token: string }>;
}

interface GraphTokenResponse {
  access_token: string;
  token_type:   string;
}

async function main(): Promise<void> {
  const tokenArg = argValue('--token');
  const appCreds = await loadFbAppCreds();

  // --------------------------------------------------------------------------
  // 1. Collect the short-lived user token.
  // --------------------------------------------------------------------------
  let shortToken: string;
  if (tokenArg) {
    shortToken = tokenArg;
  } else {
    const rl = readline.createInterface({ input, output });
    console.log('\nGet a short-lived user token from:');
    console.log('  https://developers.facebook.com/tools/explorer');
    console.log('Required scopes: pages_show_list, pages_manage_posts, pages_read_engagement\n');
    shortToken = (await rl.question('Paste your short-lived user token: ')).trim();
    rl.close();
  }

  if (!shortToken) {
    throw new Error('No user token provided.');
  }

  // --------------------------------------------------------------------------
  // 2. Exchange for a long-lived user token.
  // --------------------------------------------------------------------------
  console.log('\nExchanging for a long-lived user token…');
  const longTokenUrl =
    `https://graph.facebook.com/${FB_GRAPH_VERSION}/oauth/access_token` +
    `?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(appCreds.app_id)}` +
    `&client_secret=${encodeURIComponent(appCreds.app_secret)}` +
    `&fb_exchange_token=${encodeURIComponent(shortToken)}`;

  const ltResp = await fetch(longTokenUrl);
  if (!ltResp.ok) {
    const body = await ltResp.text();
    throw new Error(`Long-lived token exchange failed (HTTP ${ltResp.status}): ${body}`);
  }
  const ltData = (await ltResp.json()) as GraphTokenResponse;
  const longToken = ltData.access_token;
  console.log('Long-lived user token obtained ✓');

  // --------------------------------------------------------------------------
  // 3. List managed pages.
  // --------------------------------------------------------------------------
  console.log('Fetching managed pages…');
  const accountsUrl =
    `https://graph.facebook.com/${FB_GRAPH_VERSION}/me/accounts` +
    `?fields=id,name,access_token` +
    `&access_token=${encodeURIComponent(longToken)}`;

  const acctResp = await fetch(accountsUrl);
  if (!acctResp.ok) {
    const body = await acctResp.text();
    throw new Error(`Failed to fetch /me/accounts (HTTP ${acctResp.status}): ${body}`);
  }
  const accounts = (await acctResp.json()) as GraphAccountsResponse;

  if (!accounts.data.length) {
    throw new Error(
      'No pages found for this user token. ' +
      'Make sure you selected the pages_show_list scope.'
    );
  }

  // --------------------------------------------------------------------------
  // 4. Select a page (auto-select if only one; otherwise prompt).
  // --------------------------------------------------------------------------
  let selectedPage: { id: string; name: string; access_token: string };

  if (accounts.data.length === 1) {
    selectedPage = accounts.data[0]!;
    console.log(`\nUsing the only available page: "${selectedPage.name}" (${selectedPage.id})`);
  } else {
    console.log('\nAvailable pages:');
    accounts.data.forEach((p, i) => {
      console.log(`  [${i + 1}] ${p.name} (${p.id})`);
    });
    const rl2 = readline.createInterface({ input, output });
    const choice = parseInt(await rl2.question('\nEnter page number: '), 10);
    rl2.close();
    const page = accounts.data[choice - 1];
    if (!page) throw new Error(`Invalid selection: ${choice}`);
    selectedPage = page;
  }

  // --------------------------------------------------------------------------
  // 5. Persist the page token under an account alias.
  // --------------------------------------------------------------------------
  const alias = argValue('--name') ?? slugify(selectedPage.name) ?? 'default';

  const store = await loadTokens();
  store.facebook = {
    ...store.facebook,
    [alias]: {
      page_id:    selectedPage.id,
      page_token: selectedPage.access_token,
      page_name:  selectedPage.name,
    },
  };
  await saveTokens(store);

  console.log(`\n✓ Saved page "${selectedPage.name}" as alias "${alias}".`);
  console.log(`  Use it in meta.json as a target: "facebook:${alias}"`);
  const all = Object.keys(store.facebook);
  if (all.length > 1) {
    console.log(`  Authorized Facebook pages: ${all.join(', ')}`);
  }
}

/** Slugify a page name into a safe alias key (lowercase, alphanumerics + dashes). */
function slugify(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const slug = name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || undefined;
}

/** Extract the value after a named CLI argument (--flag value). */
function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

main().catch((err) => {
  console.error('auth:facebook failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
