/**
 * Facebook Page **Reels** upload adapter.
 *
 * Reels use a different protocol from the long-form /videos endpoint
 * (see upload-facebook.ts). The three phases are:
 *   Phase 1 — start:  POST /{page-id}/video_reels?upload_phase=start  → video_id + upload_url
 *   Phase 2 — upload: POST the binary to the rupload host with offset/file_size headers
 *   Phase 3 — finish: POST /{page-id}/video_reels?upload_phase=finish with video_state + schedule
 *
 * Scheduling: video_state=SCHEDULED + scheduled_publish_time (Unix seconds).
 *
 * Reel requirements (enforced by Facebook, not validated here): 9:16 aspect,
 * 1080×1920 recommended, 3–90 s duration, .mp4.
 *
 * The whole file is read into memory for a single-shot upload. Reels are short,
 * so this is fine; long-form videos should use uploadToFacebook (chunked) instead.
 */

import fs from 'node:fs';
import { FB_GRAPH_BASE, FB_REELS_RUPLOAD_BASE } from './config.js';
import type { FacebookAccount } from './tokens.js';
import type { ResolvedMeta } from './manifest.js';

export interface FacebookReelUploadResult {
  videoId: string;
}

/**
 * Upload a video to a Facebook Page as a scheduled **Reel**.
 *
 * @param videoPath - Absolute path to the video file to upload.
 * @param meta      - Resolved manifest for the Facebook target.
 * @param account   - The authorized Page to post to (holds page_id + page_token).
 * @returns         Facebook Reel video ID.
 */
export async function uploadReelToFacebook(
  videoPath: string,
  meta: ResolvedMeta,
  account: FacebookAccount,
): Promise<FacebookReelUploadResult> {
  const { page_id, page_token } = account;
  const fileSize = fs.statSync(videoPath).size;

  // --------------------------------------------------------------------------
  // Phase 1: Start — initialize the Reel upload session.
  // --------------------------------------------------------------------------
  console.log(`  [facebook/reel] Starting upload session (${fileSize} bytes)…`);

  const startBody = new URLSearchParams({
    upload_phase: 'start',
    access_token: page_token,
  });

  const startResp = await fetch(`${FB_GRAPH_BASE}/${page_id}/video_reels`, {
    method: 'POST',
    body:   startBody,
  });
  await assertOk(startResp, 'reel start phase');

  const startData = (await startResp.json()) as {
    video_id?:   string;
    upload_url?: string;
  };

  const videoId   = startData.video_id;
  if (!videoId) {
    throw new Error(`Facebook reel start phase returned no video_id: ${JSON.stringify(startData)}`);
  }
  // Prefer the upload_url the API hands back; fall back to the documented host.
  const uploadUrl = startData.upload_url ?? `${FB_REELS_RUPLOAD_BASE}/${videoId}`;

  // --------------------------------------------------------------------------
  // Phase 2: Upload — single-shot binary POST to the rupload host.
  // --------------------------------------------------------------------------
  console.log('  [facebook/reel] Uploading video…');

  const fileBuffer = fs.readFileSync(videoPath);
  const uploadResp = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `OAuth ${page_token}`,
      'offset':        '0',
      'file_size':     String(fileSize),
      'Content-Type':  'application/octet-stream',
    },
    body: fileBuffer,
  });
  await assertOk(uploadResp, 'reel upload phase');

  // --------------------------------------------------------------------------
  // Phase 3: Finish — publish as SCHEDULED with the caption.
  // --------------------------------------------------------------------------
  console.log('  [facebook/reel] Finalising and scheduling…');

  const finishBody = new URLSearchParams({
    upload_phase:           'finish',
    video_id:               videoId,
    video_state:            'SCHEDULED',
    description:            meta.description,
    scheduled_publish_time: String(meta.publishAtUnix),
    access_token:           page_token,
  });

  const finishResp = await fetch(`${FB_GRAPH_BASE}/${page_id}/video_reels`, {
    method: 'POST',
    body:   finishBody,
  });
  await assertOk(finishResp, 'reel finish phase');

  console.log(
    `  [facebook/reel] Scheduled video_id=${videoId} ` +
    `for Unix=${meta.publishAtUnix} (${meta.publishAtUTC})`
  );

  return { videoId };
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function assertOk(resp: Response, phase: string): Promise<void> {
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Facebook API error during ${phase} (HTTP ${resp.status}): ${body}`);
  }
}
