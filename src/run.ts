/**
 * Main entry point — npm start
 *
 * Scans queue/ for video items. Each directory child of queue/ is a channel (with a
 * meta.json declaring the shared targets). A "video item" is a single video file plus
 * its meta file, and may live either directly under the channel folder or inside a
 * sub-folder; a folder may contain several items. Each item's meta is its stem-named
 * `<video>.json` (preferred), or — inside a sub-folder only — the shared `meta.json`.
 * For each item × channel-target it either uploads the video or skips it if ledgered.
 *
 * The ledger key for an item is the relative path to its video file's stem, e.g.
 * "<channel>/<video>" (channel-root item) or "<channel>/<sub>/<video>" (sub-folder item).
 * Legacy folder-level keys are migrated to this scheme on load (see migrateLedgerKeys).
 *
 * Flags:
 *   --dry-run                  List what WOULD upload; no network, no token loading.
 *   --force <key-or-prefix>    Re-post matching items even if already ledgered as posted.
 *                              Matches an exact item key or any key under that path prefix.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from './config.js';
import { listVideoFiles, resolveMetaForVideo } from './video.js';
import { loadState, saveState, isPosted, markPosted, markFailed, migrateLedgerKeys } from './state.js';
import { readChannelManifest, readManifest, type ChannelMeta } from './manifest.js';
import { uploadToYouTube } from './upload-youtube.js';
import { uploadToFacebook } from './upload-facebook.js';
import { uploadReelToFacebook } from './upload-facebook-reel.js';
import { loadTokens, getYouTubeAccount, getFacebookAccount } from './tokens.js';

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const isDryRun  = process.argv.includes('--dry-run');
const forceFlag = process.argv.indexOf('--force');
const forceArg: string | undefined =
  forceFlag !== -1 ? process.argv[forceFlag + 1] : undefined;

/**
 * Whether `--force` targets this item key — by exact match or as a path prefix
 * (so `--force <channel>/<sub>` forces every video under that folder, and the
 * pre-migration folder name still forces the videos now keyed beneath it).
 */
function isForced(key: string): boolean {
  return forceArg !== undefined && (key === forceArg || key.startsWith(forceArg + '/'));
}

// ---------------------------------------------------------------------------
// Quota warning threshold: YouTube costs 1600 units per upload; 10k/day limit ≈ 6 uploads.
// ---------------------------------------------------------------------------
const YT_DAILY_QUOTA_WARN = 6;

/**
 * A queued video item (one video + its meta) that passed validation, ready to upload or plan.
 * - `key`         — ledger key & display name: the relative path to the video stem.
 * - `videoPath`   — absolute path to the video file.
 * - `metaPath`    — absolute path to the resolved meta file (stem-named or shared).
 * - `channelMeta` — the parsed channel meta (supplies targets + shared layers).
 */
interface QueuedItem {
  key:         string;
  videoPath:   string;
  metaPath:    string;
  channelMeta: ChannelMeta;
}

async function main(): Promise<void> {
  // Scan queue/ two levels deep. Top level: each directory child is a channel
  // (the queue/state.json file is naturally excluded by the isDirectory filter).
  const queueEntries = await fs.readdir(PATHS.queue, { withFileTypes: true }).catch(() => {
    console.error(`Queue directory not found: ${PATHS.queue}`);
    console.error('Create it with at least one channel folder before running.');
    process.exit(1);
  });

  const channels = queueEntries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  if (channels.length === 0) {
    console.log('Queue is empty — nothing to do.');
    return;
  }

  // Collect valid video items across all channels, keyed by their video stem path.
  const items: QueuedItem[] = [];
  for (const channel of channels) {
    const channelPath = path.join(PATHS.queue, channel);

    // Read + validate the channel meta. Missing/invalid meta or empty targets
    // skips the whole channel.
    let channelMeta: ChannelMeta;
    try {
      channelMeta = await readChannelManifest(channelPath);
    } catch (err) {
      console.warn(`[skip] ${channel}: ${errMsg(err)}`);
      continue;
    }

    // Two sources of video items per channel:
    //   1. videos directly under the channel folder (channel-root items), and
    //   2. videos inside each immediate sub-folder.
    // The channel-root `meta.json` is the channel manifest, so a channel-root video
    // must carry its own `<stem>.json` (no shared-meta fallback). Sub-folder videos
    // may fall back to the sub-folder's `meta.json`.
    const locations: Array<{ dir: string; allowSharedMeta: boolean }> = [
      { dir: channelPath, allowSharedMeta: false },
    ];
    const channelEntries = await fs.readdir(channelPath, { withFileTypes: true }).catch(() => []);
    for (const sub of channelEntries.filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      locations.push({ dir: path.join(channelPath, sub), allowSharedMeta: true });
    }

    for (const { dir, allowSharedMeta } of locations) {
      for (const videoPath of await listVideoFiles(dir)) {
        const key = ledgerKey(videoPath);
        const metaPath = await resolveMetaForVideo(videoPath, allowSharedMeta);
        if (!metaPath) {
          const want = allowSharedMeta ? 'meta.json or <video-name>.json' : '<video-name>.json';
          console.warn(`[skip] ${key}: missing ${want} for ${path.basename(videoPath)}`);
          continue;
        }
        items.push({ key, videoPath, metaPath, channelMeta });
      }
    }
  }

  if (items.length === 0) {
    console.log('No valid queue items found — nothing to do.');
    return;
  }

  // Load ledger. This is a local file read (no tokens, no network), so it is
  // safe in --dry-run and lets the plan reflect what is already posted.
  const ledger = await loadState();

  // Migrate any legacy folder-level keys to the per-video key scheme so existing
  // posted history still matches. This only reads the local queue (no tokens/network),
  // so it is safe in --dry-run; we persist the migration only on a live run.
  const migrated = await migrateLedgerKeys(ledger, PATHS.queue);
  if (migrated > 0) {
    console.log(`Migrated ${migrated} legacy ledger key(s) to per-video format${isDryRun ? ' (not persisted in --dry-run)' : ''}.`);
    if (!isDryRun) await saveState(ledger);
  }

  // --------------------------------------------------------------------------
  // Dry-run: just print the plan table and exit.
  // --------------------------------------------------------------------------
  if (isDryRun) {
    console.log('\n--- DRY RUN --- (no uploads will be performed)\n');
    const rows: Array<{ folder: string; target: string; action: string; scheduledAt: string }> = [];

    for (const { key, videoPath, metaPath, channelMeta } of items) {
      const forced = isForced(key);
      let publishAtUTC = '(parse error)';
      let isShort = false;

      try {
        const meta = await readManifest(metaPath, videoPath, channelMeta, null);
        publishAtUTC = meta.publishAtUTC;
        isShort      = meta.format === 'short';
      } catch (err) {
        console.error(`  [${key}] Could not parse meta: ${errMsg(err)}`);
        continue;
      }

      for (const target of channelMeta.targets) {
        const kind = isShort
          ? (target.platform === 'youtube' ? ' (short)' : ' (reel)')
          : '';
        const posted = isPosted(ledger, key, target.raw);
        // Mirror live-run logic: a posted target is skipped unless --force names
        // this item; a failed (or never-attempted) target would upload.
        const action = posted && !forced
          ? 'skip (posted)'
          : `would-upload${kind}${posted ? ' (forced)' : ''}`;
        rows.push({
          folder:      key,
          target:      target.raw,
          action,
          scheduledAt: publishAtUTC,
        });
      }
    }

    // Print a clean aligned table.
    const colWidths = {
      folder:      Math.max(6,  ...rows.map((r) => r.folder.length)),
      target:      Math.max(6,  ...rows.map((r) => r.target.length)),
      action:      Math.max(6,  ...rows.map((r) => r.action.length)),
      scheduledAt: Math.max(11, ...rows.map((r) => r.scheduledAt.length)),
    };

    const header =
      pad('ITEM', colWidths.folder)       + '  ' +
      pad('TARGET', colWidths.target)     + '  ' +
      pad('ACTION', colWidths.action)     + '  ' +
      pad('SCHEDULED AT', colWidths.scheduledAt);

    const sep = '-'.repeat(header.length);
    console.log(header);
    console.log(sep);

    for (const r of rows) {
      console.log(
        pad(r.folder,      colWidths.folder)      + '  ' +
        pad(r.target,      colWidths.target)      + '  ' +
        pad(r.action,      colWidths.action)      + '  ' +
        pad(r.scheduledAt, colWidths.scheduledAt),
      );
    }

    const plannedCount = rows.filter((r) => r.action.startsWith('would-upload')).length;
    const skippedCount = rows.length - plannedCount;
    console.log(
      `\nTotal: ${plannedCount} upload(s) planned, ${skippedCount} already posted, ` +
      `across ${items.length} item(s).`,
    );
    console.log('\n--- END DRY RUN ---\n');
    return;
  }

  // --------------------------------------------------------------------------
  // Live run: upload item × target pairs not yet posted.
  // --------------------------------------------------------------------------
  const tokens = await loadTokens();
  let ytAttempts = 0;

  for (const { key: itemKey, videoPath, metaPath, channelMeta } of items) {
    const forced = isForced(itemKey);

    for (const target of channelMeta.targets) {
      // The full target string ("youtube:mychannel") is the per-target ledger key,
      // scoped under the item's video-stem key.
      const targetKey = target.raw;
      const alreadyPosted = isPosted(ledger, itemKey, targetKey);

      if (alreadyPosted && !forced) {
        console.log(`[${itemKey}/${targetKey}] Already posted — skipping. (use --force ${itemKey} to re-post)`);
        continue;
      }
      if (alreadyPosted && forced) {
        console.log(`[${itemKey}/${targetKey}] --force: re-posting…`);
      }

      const now = new Date().toISOString();

      try {
        const meta = await readManifest(metaPath, videoPath, channelMeta, target);

        if (target.platform === 'youtube') {
          ytAttempts++;
          const { key: channel, account } = getYouTubeAccount(tokens, target.account);
          const result = await uploadToYouTube(videoPath, meta, account);
          await markPosted(ledger, itemKey, targetKey, result.videoId, result.url, now);
          const ytKind = meta.format === 'short' ? 'Short' : 'video';
          console.log(`[${itemKey}/${targetKey}] ✓ posted ${ytKind} to channel "${channel}" — videoId=${result.videoId}`);
        } else {
          const { key: page, account } = getFacebookAccount(tokens, target.account);
          const result = meta.format === 'short'
            ? await uploadReelToFacebook(videoPath, meta, account)
            : await uploadToFacebook(videoPath, meta, account);
          await markPosted(ledger, itemKey, targetKey, result.videoId, undefined, now);
          const kind = meta.format === 'short' ? 'reel' : 'video';
          console.log(`[${itemKey}/${targetKey}] ✓ posted ${kind} to page "${page}" — videoId=${result.videoId}`);
        }
      } catch (err) {
        const msg = errMsg(err);
        console.error(`[${itemKey}/${targetKey}] ✗ failed: ${msg}`);
        await markFailed(ledger, itemKey, targetKey, msg, now);
      }
    }
  }

  // YouTube daily quota warning.
  if (ytAttempts > YT_DAILY_QUOTA_WARN) {
    console.warn(
      `\nWARN: ${ytAttempts} YouTube upload(s) attempted this run. ` +
      'Default quota is ~6/day (10k units, 1600 per upload). Monitor your GCP quota dashboard.'
    );
  }

  console.log('\nDone.');
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * The ledger key for a video item: the queue-relative path to the video file with
 * its extension stripped, using POSIX separators (e.g. "channel/sub/clip").
 */
function ledgerKey(videoPath: string): string {
  const rel   = path.relative(PATHS.queue, videoPath);
  const noExt = rel.slice(0, rel.length - path.extname(rel).length);
  return noExt.split(path.sep).join('/');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pad(s: string, len: number): string {
  return s.padEnd(len, ' ');
}

main().catch((err) => {
  console.error('Fatal error:', errMsg(err));
  process.exit(1);
});
