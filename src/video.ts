import fs from 'node:fs/promises';
import path from 'node:path';
import { VIDEO_EXTENSIONS } from './config.js';

/**
 * List every video file (by accepted extension) directly inside a folder,
 * regardless of stem, as absolute paths sorted by name. A folder may now hold
 * **multiple** videos — each one is its own upload unit (paired with its meta
 * file via `resolveMetaForVideo`).
 *
 * @param folderPath - Absolute path to the folder to scan (non-recursive).
 * @returns          Absolute paths to the video files (possibly empty).
 */
export async function listVideoFiles(folderPath: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(folderPath);
  } catch {
    return [];
  }

  return entries
    .filter((name) => (VIDEO_EXTENSIONS as readonly string[]).includes(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => path.join(folderPath, name));
}

/**
 * Resolve the meta file for a single video. The meta may be named after the
 * video's stem (`video1.mp4` ⇒ `video1.json`) or be the shared sibling
 * `meta.json`. A stem-named file **wins** over the shared `meta.json` when both
 * are present (so per-video metadata overrides a folder default).
 *
 * The shared `meta.json` fallback is only consulted when `allowSharedMeta` is
 * true. At the channel root the sibling `meta.json` is the *channel* manifest
 * (targets/defaults), not a video meta, so callers there pass `false` and a
 * channel-root video must carry its own `<stem>.json`.
 *
 * @param videoPath       - Absolute path to the video file.
 * @param allowSharedMeta - Whether the sibling `meta.json` may serve as a fallback.
 * @returns               Absolute path to the meta file, or null if none applies.
 */
export async function resolveMetaForVideo(
  videoPath: string,
  allowSharedMeta: boolean,
): Promise<string | null> {
  const dir  = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));

  const named = path.join(dir, `${stem}.json`);
  if (await fileExists(named)) return named;

  if (allowSharedMeta) {
    const shared = path.join(dir, 'meta.json');
    if (await fileExists(shared)) return shared;
  }

  return null;
}

/**
 * MIME type for a video file, derived from its extension.
 * `.mov` ⇒ `video/quicktime`, everything else ⇒ `video/mp4`.
 */
export function videoMimeType(filePath: string): string {
  return path.extname(filePath).toLowerCase() === '.mov' ? 'video/quicktime' : 'video/mp4';
}

/** True if a path exists and is accessible. */
async function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}
