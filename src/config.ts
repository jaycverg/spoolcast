import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** Absolute paths used throughout the tool. */
export const PATHS = {
  root:           ROOT,
  secrets:        path.join(ROOT, '.secrets'),
  googleClient:   path.join(ROOT, '.secrets', 'google-client.json'),
  fbApp:          path.join(ROOT, '.secrets', 'fb-app.json'),
  tokens:         path.join(ROOT, '.secrets', 'tokens.json'),
  state:          path.join(ROOT, 'queue', 'state.json'),
  queue:          path.join(ROOT, 'queue'),
} as const;

/**
 * Accepted video file extensions (lowercase, leading dot), in preference order.
 * One video per queue folder; the file is resolved by extension regardless of
 * its stem (see `resolveVideoFile` in `video.ts`).
 */
export const VIDEO_EXTENSIONS = ['.mp4', '.mov'] as const;

/** YouTube OAuth 2.0 scopes needed for upload and channel management. */
export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
] as const;

/** Facebook Graph API version — pin so breaking changes don't hit silently. */
export const FB_GRAPH_VERSION = 'v21.0';

/** Base URL for the standard Graph API (used for Reels start/finish phases). */
export const FB_GRAPH_BASE = `https://graph.facebook.com/${FB_GRAPH_VERSION}`;

/** Base URL for resumable Facebook video uploads (long-form /videos endpoint). */
export const FB_VIDEO_UPLOAD_BASE = `https://graph-video.facebook.com/${FB_GRAPH_VERSION}`;

/** Base URL for the Reels binary upload host (rupload), used in the Reels upload phase. */
export const FB_REELS_RUPLOAD_BASE = `https://rupload.facebook.com/video-upload/${FB_GRAPH_VERSION}`;

/** Loopback port used during YouTube OAuth flow. */
export const YOUTUBE_OAUTH_PORT = 8080;

/**
 * Minimum seconds a Facebook scheduled post must be in the future.
 * The platform requires at least 10 minutes from now.
 */
export const FB_MIN_SCHEDULE_SECS = 10 * 60;

/**
 * Maximum seconds a Facebook scheduled post can be in the future.
 * The platform caps at 6 months.
 */
export const FB_MAX_SCHEDULE_SECS = 6 * 30 * 24 * 60 * 60;
