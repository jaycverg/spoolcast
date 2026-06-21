import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from './config.js';
import { listVideoFiles } from './video.js';

export type UploadStatus = 'posted' | 'failed';

export interface PostedEntry {
  status:   'posted';
  videoId:  string;
  url?:     string;
  at:       string; // ISO 8601
}

export interface FailedEntry {
  status: 'failed';
  error:  string;
  at:     string; // ISO 8601
}

export type LedgerEntry = PostedEntry | FailedEntry;

/** Map of folder name → target name → ledger entry. */
export type Ledger = Record<string, Record<string, LedgerEntry>>;

/**
 * Load state.json from disk.
 * Returns an empty ledger if the file does not exist yet.
 */
export async function loadState(): Promise<Ledger> {
  try {
    const raw = await fs.readFile(PATHS.state, 'utf8');
    return JSON.parse(raw) as Ledger;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return {};
    throw err;
  }
}

/**
 * Atomically write state.json (write to a temp file, then rename).
 * This prevents corruption if the process is interrupted mid-write.
 */
export async function saveState(ledger: Ledger): Promise<void> {
  const tmp = PATHS.state + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, PATHS.state);
}

/** Returns true if the given folder+target combination is already posted. */
export function isPosted(ledger: Ledger, folder: string, target: string): boolean {
  return ledger[folder]?.[target]?.status === 'posted';
}

/**
 * Record a successful upload in the ledger and persist immediately.
 *
 * @param folder  - Queue folder name (ledger key).
 * @param target  - Platform name ("youtube" | "facebook").
 * @param videoId - Platform-assigned video ID.
 * @param url     - Optional canonical URL for the uploaded video.
 * @param at      - ISO 8601 timestamp of when this was recorded.
 */
export async function markPosted(
  ledger: Ledger,
  folder: string,
  target: string,
  videoId: string,
  url: string | undefined,
  at: string,
): Promise<void> {
  if (!ledger[folder]) ledger[folder] = {};
  ledger[folder]![target] = { status: 'posted', videoId, url, at };
  await saveState(ledger);
}

/**
 * Record a failed upload attempt in the ledger and persist immediately.
 *
 * @param folder - Queue folder name (ledger key).
 * @param target - Platform name ("youtube" | "facebook").
 * @param error  - Human-readable error message.
 * @param at     - ISO 8601 timestamp of when this was recorded.
 */
export async function markFailed(
  ledger: Ledger,
  folder: string,
  target: string,
  error: string,
  at: string,
): Promise<void> {
  if (!ledger[folder]) ledger[folder] = {};
  ledger[folder]![target] = { status: 'failed', error, at };
  await saveState(ledger);
}

/**
 * Migrate legacy folder-level ledger keys to the per-video key scheme in place.
 *
 * Originally each ledger key was a video *folder* ("<channel>/<video>"), because a
 * folder held exactly one video. Keys are now the relative path to the video file's
 * stem ("<channel>/<video>/<stem>") so a folder can hold several videos. This rewrites
 * each legacy key whose path is still an existing directory containing exactly one
 * video, mapping it to that video's stem key — preserving posted/failed history so the
 * affected videos are not re-uploaded.
 *
 * Conservative by design: a key is only migrated when the directory holds a single,
 * unambiguous video and the target stem key is free. Keys that are already stem-based
 * (their path is not a directory) are left untouched, so this is idempotent. The caller
 * decides whether to persist the result (skip persistence in `--dry-run`).
 *
 * @param ledger    - The loaded ledger, mutated in place.
 * @param queuePath - Absolute path to the queue/ directory.
 * @returns         The number of keys migrated.
 */
export async function migrateLedgerKeys(ledger: Ledger, queuePath: string): Promise<number> {
  let migrated = 0;
  for (const key of Object.keys(ledger)) {
    const dirPath = path.join(queuePath, key);
    let isDir: boolean;
    try {
      isDir = (await fs.stat(dirPath)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue; // already a stem-based key (or a stale entry) — leave it.

    const videos = await listVideoFiles(dirPath);
    if (videos.length !== 1) continue; // 0 or ambiguous — can't safely remap.

    const stem   = path.basename(videos[0]!, path.extname(videos[0]!));
    const newKey = `${key}/${stem}`;
    if (ledger[newKey]) continue; // never clobber an existing entry.

    ledger[newKey] = ledger[key]!;
    delete ledger[key];
    migrated++;
  }
  return migrated;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
