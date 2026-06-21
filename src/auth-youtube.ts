/**
 * One-time YouTube OAuth 2.0 installed-app loopback flow.
 *
 * Run with: npm run auth:youtube              (alias derived from the channel title)
 *           npm run auth:youtube -- --name x  (explicit alias)
 *
 * Starts a local HTTP server, opens the consent URL in your browser, captures the
 * auth code, exchanges it for tokens, detects which channel was authorized, and
 * stores the refresh_token under an account alias in .secrets/tokens.json. Run it
 * once per channel — each channel is stored under its own alias.
 */

import http from 'node:http';
import { URL } from 'node:url';
import { exec } from 'node:child_process';
import { google } from 'googleapis';
import { loadGoogleClient, loadTokens, saveTokens } from './tokens.js';
import { YOUTUBE_SCOPES, YOUTUBE_OAUTH_PORT } from './config.js';

async function main(): Promise<void> {
  const creds       = await loadGoogleClient();
  const redirectUri = `http://127.0.0.1:${YOUTUBE_OAUTH_PORT}/oauth2callback`;

  const oauth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    redirectUri,
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope:       YOUTUBE_SCOPES as unknown as string[],
  });

  console.log('\nOpen this URL in your browser to authorise YouTube access:\n');
  console.log(authUrl);
  console.log();

  // Try to open the URL automatically on macOS/Linux/Windows.
  openBrowser(authUrl);

  // Wait for the redirect code on localhost.
  const code = await waitForAuthCode(YOUTUBE_OAUTH_PORT);
  console.log('\nAuth code received. Exchanging for tokens…');

  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh_token in response. Revoke app access in your Google Account settings and re-run.'
    );
  }
  oauth2Client.setCredentials(tokens);

  // Detect which channel this token authorizes, to label the account alias.
  console.log('Detecting authorized channel…');
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const chResp  = await youtube.channels.list({ part: ['snippet'], mine: true });
  const channel = chResp.data.items?.[0];
  const channelId    = channel?.id ?? undefined;
  const channelTitle = channel?.snippet?.title ?? undefined;

  // Alias: --name wins; otherwise a slug of the channel title; otherwise "default".
  const alias = argValue('--name') ?? slugify(channelTitle) ?? 'default';

  const store = await loadTokens();
  store.youtube = {
    ...store.youtube,
    [alias]: {
      refresh_token: tokens.refresh_token,
      channel_id:    channelId,
      channel_title: channelTitle,
    },
  };
  await saveTokens(store);

  console.log(`\n✓ Saved channel "${channelTitle ?? '(unknown)'}" as alias "${alias}".`);
  console.log(`  Use it in meta.json as a target: "youtube:${alias}"`);
  const all = Object.keys(store.youtube);
  if (all.length > 1) {
    console.log(`  Authorized YouTube channels: ${all.join(', ')}`);
  }
}

/** Extract the value after a named CLI argument (--flag value). */
function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

/** Slugify a channel title into a safe alias key (lowercase, alphanumerics + dashes). */
function slugify(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const slug = title.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || undefined;
}

/** Start a one-shot HTTP server that resolves with the OAuth code from the redirect. */
function waitForAuthCode(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url   = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const code  = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400);
        res.end(`OAuth error: ${error}`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorised! You can close this tab.</h1>');
        server.close();
        resolve(code);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`Waiting for OAuth redirect on http://127.0.0.1:${port}/oauth2callback …`);
    });

    server.on('error', reject);
  });
}

/** Attempt to open a URL in the system browser (best-effort). */
function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin'  ? `open "${url}"` :
              process.platform === 'win32'   ? `start "${url}"` :
              /* linux */                      `xdg-open "${url}"`;
  exec(cmd, () => { /* ignore errors */ });
}

main().catch((err) => {
  console.error('auth:youtube failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
