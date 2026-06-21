import fs from 'node:fs/promises';

/** Display dimensions of a video track, after applying the rotation matrix. */
export interface VideoDimensions {
  width:  number;
  height: number;
}

/**
 * Read the display dimensions of an MP4 or QuickTime (.mov) file by parsing its
 * box structure. Both formats use the same ISO Base Media File Format atom
 * layout (`moov`→`trak`→`tkhd`), so this parser handles either transparently.
 *
 * Only the box *headers* and the (small) `moov` metadata box are read — never
 * the `mdat` payload — so this stays cheap even for large files. The track
 * rotation matrix is honoured: portrait phone footage is commonly stored as a
 * landscape frame plus a 90°/270° rotation, and the returned dimensions reflect
 * how the video is actually displayed.
 *
 * @param filePath - Absolute path to the .mp4/.mov file.
 * @returns        Display width/height in pixels.
 * @throws         If the file has no parseable `moov`/video track.
 */
export async function probeVideoDimensions(filePath: string): Promise<VideoDimensions> {
  const fh = await fs.open(filePath, 'r');
  try {
    const moov = await readMoovBox(fh);
    if (!moov) {
      throw new Error(`No "moov" box found in ${filePath} — not a valid MP4/MOV?`);
    }
    const dims = findVideoTrackDimensions(moov);
    if (!dims) {
      throw new Error(`No video track with dimensions found in ${filePath}.`);
    }
    return dims;
  } finally {
    await fh.close();
  }
}

/**
 * Walk the top-level boxes of an MP4, skipping over payload boxes (notably
 * `mdat`) by their declared size, and return the full `moov` box body.
 */
async function readMoovBox(fh: fs.FileHandle): Promise<Buffer | null> {
  const { size: fileSize } = await fh.stat();
  const header = Buffer.alloc(16);
  let offset = 0;

  while (offset + 8 <= fileSize) {
    const { bytesRead } = await fh.read(header, 0, 16, offset);
    if (bytesRead < 8) break;

    let boxSize = header.readUInt32BE(0);
    const type  = header.toString('latin1', 4, 8);
    let headerSize = 8;

    if (boxSize === 1) {
      // 64-bit largesize follows the type (bytes 8..16).
      boxSize    = header.readUInt32BE(8) * 2 ** 32 + header.readUInt32BE(12);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = fileSize - offset; // extends to end of file
    }
    if (boxSize < headerSize) break; // malformed

    if (type === 'moov') {
      const body = Buffer.alloc(boxSize - headerSize);
      await fh.read(body, 0, body.length, offset + headerSize);
      return body;
    }
    offset += boxSize;
  }
  return null;
}

/** Yield each immediate child box `{ type, body }` within a buffer. */
function* iterBoxes(buf: Buffer): Generator<{ type: string; body: Buffer }> {
  let offset = 0;
  while (offset + 8 <= buf.length) {
    let boxSize = buf.readUInt32BE(offset);
    const type  = buf.toString('latin1', offset + 4, offset + 8);
    let headerSize = 8;

    if (boxSize === 1) {
      boxSize    = buf.readUInt32BE(offset + 8) * 2 ** 32 + buf.readUInt32BE(offset + 12);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = buf.length - offset;
    }
    if (boxSize < headerSize || offset + boxSize > buf.length) break;

    yield { type, body: buf.subarray(offset + headerSize, offset + boxSize) };
    offset += boxSize;
  }
}

/**
 * Find the first track with non-zero dimensions (the video track; audio tracks
 * report 0×0) by descending moov → trak → tkhd.
 */
function findVideoTrackDimensions(moov: Buffer): VideoDimensions | null {
  for (const trak of iterBoxes(moov)) {
    if (trak.type !== 'trak') continue;
    for (const inner of iterBoxes(trak.body)) {
      if (inner.type !== 'tkhd') continue;
      const dims = parseTkhd(inner.body);
      if (dims && dims.width > 0 && dims.height > 0) return dims;
    }
  }
  return null;
}

/**
 * Parse a `tkhd` box body into display dimensions, swapping width/height when
 * the transform matrix encodes a 90°/270° rotation.
 */
function parseTkhd(body: Buffer): VideoDimensions | null {
  const version = body.readUInt8(0);
  // Skip version+flags (4), then the version-dependent time/id block:
  //   v0: creation(4) modification(4) trackID(4) reserved(4) duration(4) = 20
  //   v1: creation(8) modification(8) trackID(4) reserved(4) duration(8) = 32
  let p = 4 + (version === 1 ? 32 : 20);
  // reserved(8) layer(2) alternate_group(2) volume(2) reserved(2) = 16
  p += 16;
  if (p + 36 + 8 > body.length) return null;

  // Transform matrix: 9 fixed-point values. The upper-left 2×2 [a b; c d]
  // (matrix indices 0 and 1 here) determines rotation.
  const a = read1616(body, p);
  const b = read1616(body, p + 4);
  p += 36;

  const width  = body.readUInt32BE(p) / 65536;
  const height = body.readUInt32BE(p + 4) / 65536;

  const rotationDeg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  const swap = Math.abs(rotationDeg) === 90;

  return swap
    ? { width: Math.round(height), height: Math.round(width) }
    : { width: Math.round(width),  height: Math.round(height) };
}

/** Read a signed 16.16 fixed-point number. */
function read1616(buf: Buffer, off: number): number {
  return buf.readInt32BE(off) / 65536;
}
