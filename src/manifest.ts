import fs from 'node:fs/promises';
import path from 'node:path';
import { FB_MIN_SCHEDULE_SECS, FB_MAX_SCHEDULE_SECS } from './config.js';
import { probeVideoDimensions } from './probe.js';

/** Supported upload target platform names. */
export type Platform = 'youtube' | 'facebook';

/**
 * A parsed upload target.
 * - `raw`      — the original string as written in meta.json (e.g. "youtube:mychannel").
 *                This is also the per-target ledger key.
 * - `platform` — the base platform.
 * - `account`  — the account/channel/page alias after the colon, or undefined for a
 *                bare platform (resolved to the sole authorized account at upload time).
 */
export interface Target {
  raw:      string;
  platform: Platform;
  account?: string;
}

/**
 * Content format.
 * - `video` — standard long-form upload (YouTube video, Facebook /videos post).
 * - `short` — vertical short-form: uploaded as a YouTube Short (auto-detected from the
 *   vertical ≤3-min file; a `#Shorts` hint is added) and as a Facebook **Reel**
 *   (the dedicated /video_reels endpoint).
 *
 * When `format` is omitted from meta.json it is auto-detected from the video's
 * display dimensions (portrait ⇒ `short`); an explicit value always wins.
 */
export type ContentFormat = 'video' | 'short';

/** Override fields applicable per platform/target (everything except structural keys). */
export type OverrideFields = Partial<Omit<RawMeta, 'targets' | 'overrides'>>;

/** Raw shape of a video meta.json as read from disk. */
interface RawMeta {
  title:         string;
  description:   string;
  tags?:         string[];
  categoryId?:   string;
  publishAt:     string;
  madeForKids?:  boolean;
  playlistId?:   string | null;
  format?:       ContentFormat;
  /**
   * Legacy/optional and IGNORED — targets now live in the channel meta.json.
   * Each entry would be "youtube", "facebook", or "<platform>:<account-alias>".
   */
  targets?:      string[];
  /** Keyed by platform ("youtube") or full target ("youtube:mychannel"); the latter wins. */
  overrides?:    Record<string, OverrideFields>;
}

/**
 * Validated channel-level meta.json (`queue/<channel>/meta.json`).
 * Declares the upload `targets` once for all child video folders, plus optional
 * shared content defaults and per-platform/target override blocks that fill gaps
 * the video meta.json leaves open.
 */
export interface ChannelMeta {
  /** The upload targets shared by every video folder in this channel. */
  targets:   Target[];
  /** Shared default content fields (any top-level key except `targets`/`overrides`). */
  defaults:  OverrideFields;
  /** Shared overrides, keyed by platform ("youtube") or full target ("youtube:mychannel"). */
  overrides: Record<string, OverrideFields>;
}

/** Validated and fully-resolved manifest for a single video × target. */
export interface ResolvedMeta {
  title:           string;
  description:     string;
  tags:            string[];
  categoryId:      string;
  publishAtUTC:    string;  // RFC 3339 UTC — for YouTube
  publishAtUnix:   number;  // Unix seconds — for Facebook
  madeForKids:     boolean;
  playlistId:      string | null;
  format:          ContentFormat;
}

/**
 * Parse a target string ("youtube", "facebook", "youtube:mychannel") into a Target.
 * @throws if the platform portion is not a known platform.
 */
export function parseTarget(raw: string): Target {
  const idx = raw.indexOf(':');
  const platform = (idx === -1 ? raw : raw.slice(0, idx)).trim();
  const account  = idx === -1 ? undefined : raw.slice(idx + 1).trim() || undefined;
  if (platform !== 'youtube' && platform !== 'facebook') {
    throw new Error(`Invalid target "${raw}": platform must be "youtube" or "facebook".`);
  }
  return { raw, platform, account };
}

/**
 * Read and validate a channel-level meta.json (`<channelPath>/meta.json`).
 *
 * The channel meta owns the upload `targets` (required, non-empty) shared by every
 * child video folder, plus optional shared content `defaults` (any top-level key
 * other than `targets`/`overrides`) and shared `overrides` blocks. These fill gaps
 * the per-video meta.json leaves open (the video layer always wins — see readManifest).
 *
 * @param channelPath - Absolute path to the channel folder.
 * @throws            If `targets` is missing/empty or any entry fails to parse, or a
 *                    `format` in the defaults/overrides is not "video" | "short".
 */
export async function readChannelManifest(channelPath: string): Promise<ChannelMeta> {
  const metaPath = path.join(channelPath, 'meta.json');
  let raw: string;
  try {
    raw = await fs.readFile(metaPath, 'utf8');
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      throw new Error(`Missing channel meta.json in ${channelPath}`);
    }
    throw err;
  }

  const parsed = JSON.parse(raw) as { targets?: unknown; overrides?: unknown; [key: string]: unknown };
  const targets = validateTargets(parsed.targets, `channel meta.json at ${metaPath}`);

  const overrides = (parsed.overrides ?? {}) as Record<string, OverrideFields>;
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error(`channel meta.json at ${metaPath}: "overrides" must be an object.`);
  }

  // Everything except the structural keys is a shared default content field.
  const { targets: _t, overrides: _o, ...defaults } = parsed;

  // Validate any `format` present in the shared defaults or override blocks.
  validateFormatFields(defaults as OverrideFields, overrides, `channel meta.json at ${metaPath}`);

  return { targets, defaults: defaults as OverrideFields, overrides };
}

/**
 * Read and validate a video meta file and resolve it for one target. The meta file
 * (named `meta.json` or after the video's stem — see `resolveMetaForVideo`) and the
 * video file are resolved by the caller and passed in explicitly, since a folder may
 * now hold several video × meta pairs.
 *
 * The merged content fields layer the channel meta beneath the video meta, weakest first:
 * `{ ...channel.defaults, ...channel.overrides[platform], ...channel.overrides[target.raw],
 *    ...videoBase, ...video.overrides[platform], ...video.overrides[target.raw] }`.
 * Net precedence (highest → lowest): video target-override > video platform-override >
 * video base > channel target-override > channel platform-override > channel default.
 * The video's own `targets` (if any) is optional and ignored — targets are a channel concern.
 *
 * @param metaPath   - Absolute path to the video meta file.
 * @param videoPath  - Absolute path to the video file (used for `format` auto-detection).
 * @param channel    - The parsed channel meta (supplies targets and shared layers).
 * @param target     - Which target to resolve overrides for (or null for base/dry-run).
 *                     When null, only `channel.defaults` + the video base are merged.
 * @throws           If required fields are missing, or the schedule window violates
 *                   Facebook's 10-minute minimum / 6-month maximum.
 */
export async function readManifest(
  metaPath: string,
  videoPath: string,
  channel: ChannelMeta,
  target: Target | null = null,
): Promise<ResolvedMeta> {
  const raw = await fs.readFile(metaPath, 'utf8');

  const base = JSON.parse(raw) as RawMeta;
  validateRequired(base, metaPath);
  validateFormatFields(base, base.overrides ?? {}, `meta.json at ${metaPath}`);

  // Channel layers (weakest) — only the target-specific lookups depend on `target`.
  const channelTargetLayer: OverrideFields = target
    ? { ...channel.overrides[target.platform], ...channel.overrides[target.raw] }
    : {};
  // Video layers (strongest) — full-target key wins over platform.
  const videoTargetLayer: OverrideFields = target
    ? { ...base.overrides?.[target.platform], ...base.overrides?.[target.raw] }
    : {};

  // Single ordered spread, weakest first; later wins. The video layer overrides
  // the channel layer entirely; the channel only fills fields the video omits.
  const merged: RawMeta = {
    ...channel.defaults,
    ...channelTargetLayer,
    ...base,
    ...videoTargetLayer,
  };

  // Resolve format: an explicit value from any layer always wins; otherwise
  // auto-detect from the video's display dimensions (portrait ⇒ short).
  const format = merged.format ?? await detectFormat(videoPath);

  // Parse publishAt — supports offsets like "+08:00" via native Date (ISO 8601 extended).
  const publishDate = parsePublishAt(merged.publishAt, metaPath);
  const publishAtUTC  = toRfc3339Utc(publishDate);
  const publishAtUnix = Math.floor(publishDate.getTime() / 1000);

  // Validate Facebook scheduling window if this is for Facebook.
  if (target?.platform === 'facebook') {
    const nowSecs  = Math.floor(Date.now() / 1000);
    const diffSecs = publishAtUnix - nowSecs;
    if (diffSecs < FB_MIN_SCHEDULE_SECS) {
      throw new Error(
        `publishAt "${merged.publishAt}" is less than 10 minutes in the future ` +
        `(diff=${diffSecs}s). Facebook requires at least 10 minutes.`
      );
    }
    if (diffSecs > FB_MAX_SCHEDULE_SECS) {
      throw new Error(
        `publishAt "${merged.publishAt}" is more than 6 months in the future ` +
        `(diff=${diffSecs}s). Facebook does not allow scheduling beyond 6 months.`
      );
    }
  }

  return {
    title:         merged.title.trim(),
    description:   merged.description,
    tags:          merged.tags ?? [],
    categoryId:    merged.categoryId ?? '22',
    publishAtUTC,
    publishAtUnix,
    madeForKids:   merged.madeForKids ?? false,
    playlistId:    merged.playlistId ?? null,
    format,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Auto-detect the content format from a video file: a portrait frame
 * (height > width, after rotation) is treated as a `short`, otherwise `video`.
 *
 * Detection is best-effort and fully offline (local file headers only) — if the
 * file can't be probed we warn and fall back to `video`, the safe default,
 * rather than blocking an otherwise-valid upload.
 */
async function detectFormat(videoPath: string): Promise<ContentFormat> {
  try {
    const { width, height } = await probeVideoDimensions(videoPath);
    return height > width ? 'short' : 'video';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[${path.basename(videoPath)}] Could not detect format from video; defaulting to "video". (${msg})`);
    return 'video';
  }
}

function validateRequired(meta: Partial<RawMeta>, metaPath: string): asserts meta is RawMeta {
  // `targets` is no longer required on a video meta — it is owned by the channel meta.
  const required: Array<keyof RawMeta> = ['title', 'description', 'publishAt'];
  for (const key of required) {
    if (meta[key] === undefined || meta[key] === null || meta[key] === '') {
      throw new Error(`meta.json at ${metaPath} is missing required field: "${key}"`);
    }
  }
}

/**
 * Validate that `value` is a present, non-empty array whose entries each parse to a
 * known platform via `parseTarget`, and return the parsed targets.
 * Used for the channel meta's required `targets` field.
 *
 * @param where - A label for the error message (e.g. "channel meta.json at <path>").
 * @throws      If `value` is not a non-empty array, or any entry fails to parse.
 */
function validateTargets(value: unknown, where: string): Target[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${where}: "targets" must be a present, non-empty array.`);
  }
  // Each target must parse to a known platform (throws with a clear message otherwise).
  return value.map((entry) => parseTarget(entry as string));
}

/**
 * Validate every `format` field present in the given base fields and override blocks.
 * Must be "video" or "short" wherever present.
 *
 * @param base      - The base/default content fields to check `format` on.
 * @param overrides - Override blocks (keyed by platform/target) to check `format` on.
 * @param where     - A label for the error message (e.g. "meta.json at <path>").
 */
function validateFormatFields(
  base: OverrideFields,
  overrides: Record<string, OverrideFields>,
  where: string,
): void {
  const allowed: ContentFormat[] = ['video', 'short'];
  const check = (value: unknown, what: string): void => {
    if (value !== undefined && !allowed.includes(value as ContentFormat)) {
      throw new Error(
        `${where}: "${what}" must be one of ${allowed.join(' | ')} (got "${String(value)}").`
      );
    }
  };
  check(base.format, 'format');
  for (const [key, fields] of Object.entries(overrides)) {
    check(fields.format, `overrides.${key}.format`);
  }
}

/**
 * Parse publishAt string into a Date.
 * Accepts ISO 8601 strings with timezone offsets, e.g. "2026-06-20 22:00 +08:00".
 * Normalises the space before the offset to "T" and removes internal spaces.
 */
function parsePublishAt(raw: string, metaPath: string): Date {
  // Normalise "2026-06-20 22:00 +08:00" → "2026-06-20T22:00+08:00"
  const cleaned = raw.trim()
    .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2}:\d{2}|Z)$/, '$1T$2$3');

  const d = new Date(cleaned);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid publishAt: "${raw}"`);
  }
  return d;
}

/** Format a Date as an RFC 3339 UTC string (e.g. "2026-06-20T14:00:00.000Z"). */
function toRfc3339Utc(d: Date): string {
  return d.toISOString();
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
