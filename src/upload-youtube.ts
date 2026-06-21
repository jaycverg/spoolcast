/**
 * YouTube video upload adapter.
 *
 * Uses the Data API v3 `videos.insert` endpoint with a resumable upload
 * (googleapis handles the chunked transfer and retry internally).
 *
 * After a successful video upload it optionally:
 *   - Sets a custom thumbnail (thumbnails.set).
 *   - Adds the video to a playlist (playlistItems.insert).
 */

import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { videoMimeType } from './video.js';
import { loadGoogleClient, type YouTubeAccount } from './tokens.js';
import type { ResolvedMeta } from './manifest.js';

export interface YouTubeUploadResult {
  videoId: string;
  url:     string;
}

/**
 * Upload a video to YouTube as a private scheduled post.
 *
 * @param videoPath - Absolute path to the video file to upload.
 * @param meta      - Resolved manifest for the YouTube target.
 * @param account   - The authorized channel to upload to (holds the refresh token).
 * @returns         Video ID and canonical URL.
 */
export async function uploadToYouTube(
  videoPath: string,
  meta: ResolvedMeta,
  account: YouTubeAccount,
): Promise<YouTubeUploadResult> {
  const thumbnailPath = resolveThumbnail(videoPath);

  // --------------------------------------------------------------------------
  // Build an authenticated OAuth2 client (same client, per-channel refresh token).
  // --------------------------------------------------------------------------
  const creds = await loadGoogleClient();

  const oauth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret);
  oauth2Client.setCredentials({ refresh_token: account.refresh_token });

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  // --------------------------------------------------------------------------
  // Upload the video.
  // --------------------------------------------------------------------------
  const isShort = meta.format === 'short';
  console.log(`  [youtube] Uploading "${meta.title}"${isShort ? ' (Short)' : ''}…`);

  // YouTube has no Shorts API — a vertical (≤1:1) video ≤3 min is auto-classified
  // as a Short. Appending #Shorts is a long-standing hint and is harmless otherwise.
  const description = isShort ? appendShortsTag(meta.description) : meta.description;

  const videoStat = fs.statSync(videoPath);
  const response  = await youtube.videos.insert({
    part:          ['snippet', 'status'],
    notifySubscribers: false,
    requestBody: {
      snippet: {
        title:       meta.title,
        description,
        tags:        meta.tags,
        categoryId:  meta.categoryId,
      },
      status: {
        privacyStatus:             'private',
        publishAt:                 meta.publishAtUTC,
        selfDeclaredMadeForKids:   meta.madeForKids,
      },
    },
    media: {
      mimeType: videoMimeType(videoPath),
      body:     fs.createReadStream(videoPath),
    },
  }, {
    // Pass content-length so the API can show upload progress.
    onUploadProgress: (evt: { bytesRead: number }) => {
      const pct = Math.round((evt.bytesRead / videoStat.size) * 100);
      process.stdout.write(`\r  [youtube] Upload progress: ${pct}%  `);
    },
  });

  process.stdout.write('\n');

  const videoId = response.data.id;
  if (!videoId) throw new Error('YouTube API did not return a video ID.');

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`  [youtube] Uploaded: ${url} (scheduled ${meta.publishAtUTC})`);

  // --------------------------------------------------------------------------
  // Optionally set thumbnail.
  // --------------------------------------------------------------------------
  if (thumbnailPath) {
    console.log('  [youtube] Setting thumbnail…');
    await youtube.thumbnails.set({
      videoId,
      media: {
        mimeType: 'image/jpeg',
        body:     fs.createReadStream(thumbnailPath),
      },
    });
    console.log('  [youtube] Thumbnail set ✓');
  }

  // --------------------------------------------------------------------------
  // Optionally add to playlist.
  // --------------------------------------------------------------------------
  if (meta.playlistId) {
    console.log(`  [youtube] Adding to playlist ${meta.playlistId}…`);
    await youtube.playlistItems.insert({
      part: ['snippet'],
      requestBody: {
        snippet: {
          playlistId: meta.playlistId,
          resourceId: {
            kind:    'youtube#video',
            videoId,
          },
        },
      },
    });
    console.log('  [youtube] Added to playlist ✓');
  }

  return { videoId, url };
}

/**
 * Resolve the JPEG thumbnail for a video: prefer one named after the video's stem
 * (`clip.mp4` ⇒ `clip.jpg`) so per-video thumbnails work when a folder holds several
 * videos, then fall back to a shared sibling `thumbnail.jpg`. Returns null if neither
 * exists.
 */
function resolveThumbnail(videoPath: string): string | null {
  const dir  = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));
  const named  = path.join(dir, `${stem}.jpg`);
  if (fs.existsSync(named)) return named;
  const shared = path.join(dir, 'thumbnail.jpg');
  if (fs.existsSync(shared)) return shared;
  return null;
}

/** Append a "#Shorts" hashtag to the description if not already present (case-insensitive). */
function appendShortsTag(description: string): string {
  if (/#shorts\b/i.test(description)) return description;
  return description.trim().length > 0 ? `${description}\n\n#Shorts` : '#Shorts';
}
