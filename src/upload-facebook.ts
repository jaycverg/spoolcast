/**
 * Facebook Page video upload adapter.
 *
 * Implements the three-phase resumable upload protocol against
 * graph-video.facebook.com:
 *   Phase 1 — start:    declare file size, receive session ID + first offsets.
 *   Phase 2 — transfer: POST chunks until end_offset reaches file size.
 *   Phase 3 — finish:   commit with scheduling metadata.
 *
 * Uses global `fetch` + `FormData` (available in Node 18+).
 */

import fs from 'node:fs';
import path from 'node:path';
import { FB_VIDEO_UPLOAD_BASE, FB_GRAPH_VERSION } from './config.js';
import { videoMimeType } from './video.js';
import type { FacebookAccount } from './tokens.js';
import type { ResolvedMeta } from './manifest.js';

export interface FacebookUploadResult {
  videoId: string;
}

/** Chunk size for the transfer phase (10 MB). */
const CHUNK_SIZE = 10 * 1024 * 1024;

/**
 * Upload a video to a Facebook Page as a scheduled (unpublished) post.
 *
 * @param videoPath - Absolute path to the video file to upload.
 * @param meta      - Resolved manifest for the Facebook target.
 * @param account   - The authorized Page to post to (holds page_id + page_token).
 * @returns         Facebook video ID.
 */
export async function uploadToFacebook(
  videoPath: string,
  meta: ResolvedMeta,
  account: FacebookAccount,
): Promise<FacebookUploadResult> {
  const { page_id, page_token } = account;
  const fileSize = fs.statSync(videoPath).size;
  const mimeType = videoMimeType(videoPath);
  const chunkExt = path.extname(videoPath).toLowerCase();

  // --------------------------------------------------------------------------
  // Phase 1: Start — register the upload session.
  // --------------------------------------------------------------------------
  console.log(`  [facebook] Starting upload session (${fileSize} bytes)…`);

  const startForm = new FormData();
  startForm.append('upload_phase',  'start');
  startForm.append('file_size',     String(fileSize));
  startForm.append('access_token',  page_token);

  const startResp = await fetch(
    `${FB_VIDEO_UPLOAD_BASE}/${page_id}/videos`,
    { method: 'POST', body: startForm },
  );
  await assertOk(startResp, 'start phase');

  const startData = (await startResp.json()) as {
    upload_session_id: string;
    video_id:          string;
    start_offset:      string;
    end_offset:        string;
  };

  const { upload_session_id, video_id } = startData;
  if (!upload_session_id || !video_id) {
    throw new Error(`Facebook start phase returned incomplete data: ${JSON.stringify(startData)}`);
  }
  let startOffset = parseInt(startData.start_offset, 10);
  let endOffset   = parseInt(startData.end_offset,   10);

  // --------------------------------------------------------------------------
  // Phase 2: Transfer — send chunks.
  // --------------------------------------------------------------------------
  const fileHandle = fs.openSync(videoPath, 'r');
  try {
    let chunkIndex = 0;
    while (startOffset < fileSize) {
      const chunkLen = Math.min(endOffset - startOffset, CHUNK_SIZE);
      const buf      = Buffer.alloc(chunkLen);
      fs.readSync(fileHandle, buf, 0, chunkLen, startOffset);

      const pct = Math.round((startOffset / fileSize) * 100);
      process.stdout.write(`\r  [facebook] Transfer chunk ${++chunkIndex} (${pct}%)  `);

      const transferForm = new FormData();
      transferForm.append('upload_phase',        'transfer');
      transferForm.append('upload_session_id',   upload_session_id);
      transferForm.append('start_offset',        String(startOffset));
      transferForm.append('video_file_chunk',    new Blob([buf], { type: mimeType }), `chunk${chunkExt}`);
      transferForm.append('access_token',        page_token);

      const transferResp = await fetch(
        `${FB_VIDEO_UPLOAD_BASE}/${page_id}/videos`,
        { method: 'POST', body: transferForm },
      );
      await assertOk(transferResp, `transfer chunk at offset ${startOffset}`);

      const transferData = (await transferResp.json()) as {
        start_offset: string;
        end_offset:   string;
      };
      startOffset = parseInt(transferData.start_offset, 10);
      endOffset   = parseInt(transferData.end_offset,   10);
    }
  } finally {
    fs.closeSync(fileHandle);
  }

  process.stdout.write('\n');

  // --------------------------------------------------------------------------
  // Phase 3: Finish — commit with schedule metadata.
  // --------------------------------------------------------------------------
  console.log('  [facebook] Finalising and scheduling…');

  const finishForm = new FormData();
  finishForm.append('upload_phase',            'finish');
  finishForm.append('upload_session_id',       upload_session_id);
  finishForm.append('title',                   meta.title);
  finishForm.append('description',             meta.description);
  finishForm.append('published',               'false');
  finishForm.append('scheduled_publish_time',  String(meta.publishAtUnix));
  finishForm.append('access_token',            page_token);

  const finishResp = await fetch(
    `https://graph.facebook.com/${FB_GRAPH_VERSION}/${page_id}/videos`,
    { method: 'POST', body: finishForm },
  );
  await assertOk(finishResp, 'finish phase');

  console.log(
    `  [facebook] Scheduled video_id=${video_id} ` +
    `for Unix=${meta.publishAtUnix} (${meta.publishAtUTC})`
  );

  return { videoId: video_id };
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
