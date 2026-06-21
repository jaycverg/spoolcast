import fs from 'node:fs/promises';
import { PATHS } from './config.js';

/** A single authorized YouTube channel. */
export interface YouTubeAccount {
  refresh_token: string;
  channel_id?:   string;
  channel_title?: string;
}

/** A single authorized Facebook Page. */
export interface FacebookAccount {
  page_id:    string;
  page_token: string;
  page_name?: string;
}

/**
 * Shape of .secrets/tokens.json — keyed by platform, then by a user-chosen
 * account alias (e.g. "mychannel", "gaming"). Multiple channels/pages are supported.
 */
export interface TokenStore {
  youtube?:  Record<string, YouTubeAccount>;
  facebook?: Record<string, FacebookAccount>;
}

/** Resolved account plus the alias key it was found under. */
export interface ResolvedAccount<T> {
  key:     string;
  account: T;
}

/**
 * Load the token store from disk.
 * Returns an empty object if the file does not exist yet.
 * Tolerates the legacy single-account shape ({ youtube: { refresh_token } })
 * by wrapping it under a "default" alias.
 */
export async function loadTokens(): Promise<TokenStore> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(PATHS.tokens, 'utf8'));
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return {};
    throw err;
  }
  return migrateLegacyShape(parsed as Record<string, unknown>);
}

/**
 * Persist the token store to disk (atomic: temp file + rename).
 * Creates .secrets/ directory if it doesn't exist.
 */
export async function saveTokens(tokens: TokenStore): Promise<void> {
  await fs.mkdir(PATHS.secrets, { recursive: true });
  const tmp = PATHS.tokens + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(tokens, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, PATHS.tokens);
}

/**
 * Resolve a YouTube account by alias. If no alias is given and exactly one
 * channel is authorized, that one is used; otherwise the caller must qualify.
 */
export function getYouTubeAccount(store: TokenStore, key?: string): ResolvedAccount<YouTubeAccount> {
  return resolveAccount(store.youtube, 'youtube', key);
}

/** Resolve a Facebook account (Page) by alias — same fallback rules as YouTube. */
export function getFacebookAccount(store: TokenStore, key?: string): ResolvedAccount<FacebookAccount> {
  return resolveAccount(store.facebook, 'facebook', key);
}

/** List the authorized alias keys for a platform. */
export function listAccountKeys(store: TokenStore, platform: 'youtube' | 'facebook'): string[] {
  return Object.keys(store[platform] ?? {});
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

function resolveAccount<T>(
  map: Record<string, T> | undefined,
  platform: string,
  key?: string,
): ResolvedAccount<T> {
  const keys = Object.keys(map ?? {});
  if (keys.length === 0) {
    throw new Error(`No ${platform} accounts authorized. Run: npm run auth:${platform}`);
  }
  if (key) {
    const account = map![key];
    if (!account) {
      throw new Error(
        `No ${platform} account "${key}". Authorized: ${keys.join(', ')}. ` +
        `Run "npm run auth:${platform}" to add it.`
      );
    }
    return { key, account };
  }
  if (keys.length === 1) {
    return { key: keys[0]!, account: map![keys[0]!]! };
  }
  throw new Error(
    `Multiple ${platform} accounts authorized (${keys.join(', ')}). ` +
    `Qualify the target as "${platform}:<key>" in meta.json.`
  );
}

/**
 * Convert the legacy flat shape to the keyed shape, in memory.
 * - { youtube: { refresh_token } }        → { youtube: { default: { refresh_token } } }
 * - { facebook: { page_id, page_token } } → { facebook: { default: { … } } }
 * Already-keyed stores pass through unchanged.
 */
function migrateLegacyShape(raw: Record<string, unknown>): TokenStore {
  const store: TokenStore = {};
  const yt = raw['youtube'] as Record<string, unknown> | undefined;
  if (yt) {
    store.youtube = 'refresh_token' in yt
      ? { default: yt as unknown as YouTubeAccount }
      : (yt as Record<string, YouTubeAccount>);
  }
  const fb = raw['facebook'] as Record<string, unknown> | undefined;
  if (fb) {
    store.facebook = 'page_token' in fb
      ? { default: fb as unknown as FacebookAccount }
      : (fb as Record<string, FacebookAccount>);
  }
  return store;
}

// ---------------------------------------------------------------------------
// External credential files (shared across all accounts of a platform)
// ---------------------------------------------------------------------------

/**
 * Read YouTube OAuth client credentials from google-client.json.
 * The same OAuth client is reused for every channel — only the per-channel
 * refresh token differs.
 */
export async function loadGoogleClient(): Promise<{
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
}> {
  let raw: string;
  try {
    raw = await fs.readFile(PATHS.googleClient, 'utf8');
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      throw new Error(
        `Missing ${PATHS.googleClient}.\n` +
        'Download your OAuth 2.0 Desktop client JSON from GCP Console → ' +
        'APIs & Services → Credentials and save it there.'
      );
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as { installed?: { client_id: string; client_secret: string; redirect_uris: string[] } };
  const creds = parsed.installed;
  if (!creds?.client_id || !creds.client_secret) {
    throw new Error('google-client.json is malformed — expected top-level "installed" key.');
  }
  return creds;
}

/**
 * Read Facebook app credentials, preferring env vars over fb-app.json.
 * FB_APP_ID and FB_APP_SECRET override the file.
 */
export async function loadFbAppCreds(): Promise<{ app_id: string; app_secret: string }> {
  const envId     = process.env['FB_APP_ID'];
  const envSecret = process.env['FB_APP_SECRET'];
  if (envId && envSecret) return { app_id: envId, app_secret: envSecret };

  try {
    const raw = await fs.readFile(PATHS.fbApp, 'utf8');
    const parsed = JSON.parse(raw) as { app_id?: string; app_secret?: string };
    if (!parsed.app_id || !parsed.app_secret) {
      throw new Error('fb-app.json must contain "app_id" and "app_secret".');
    }
    return { app_id: parsed.app_id, app_secret: parsed.app_secret };
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      throw new Error(
        `Missing FB app credentials.\n` +
        'Either set FB_APP_ID + FB_APP_SECRET env vars, or create .secrets/fb-app.json with {"app_id":"...","app_secret":"..."}.'
      );
    }
    throw err;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
