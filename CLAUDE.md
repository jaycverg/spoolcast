# CLAUDE.md — social-uploader

Guidance for Claude Code (and other agents) working in this project. Read this before editing.
See `README.md` for full user-facing docs; this file is the engineering contract.

## What this is

A standalone Node/TypeScript CLI that uploads **scheduled** videos to YouTube channels and
Facebook Pages from a `queue/` organised **by channel**: `queue/<channel>/<video>/`. The
channel folder's `meta.json` declares the upload `targets` once (plus optional shared
defaults/overrides); each child video folder inherits them. Manual run (`npm start`).
Idempotency via a per-folder/per-target ledger at `queue/state.json`, keyed by the
`<channel>/<video>` path. No web server, no daemon.

This project is **self-contained** — it must not import from or depend on the surrounding
workspace. It should remain copy-paste relocatable into its own repo.

## Toolchain

- **Node ≥ 20** (developed on v24). ESM only (`"type": "module"`).
- **TypeScript**, run directly with **`tsx`** — there is no build step for normal use.
- Relative imports use the **`.js` extension** (NodeNext ESM resolution), even though the
  files are `.ts`. Keep this convention — `import { x } from './config.js'`.
- `tsconfig`: `strict: true`, `noEmit: true`, target ES2022, module/resolution NodeNext.

## Commands

```bash
npm install
npm run typecheck                       # tsc --noEmit — must stay clean
npm start -- --dry-run                  # offline plan; no tokens, no network
npm start                               # live upload
npm start -- --force <key-or-prefix>    # re-post ledgered items; exact item key or a path prefix
npm run auth:youtube                     # one-time OAuth
npm run auth:facebook                    # one-time FB token exchange (paste token at prompt)
npm run auth:facebook -- --token <t>     # non-interactive (note the `--` so npm forwards it)
```

**Always run `npm run typecheck` after edits.** There is no test suite (see below), so the
type checker plus an offline `--dry-run` are the verification gates. Don't claim a change works
without running both.

## Architecture (single responsibility per module)

| File | Responsibility | Don't put here |
|------|----------------|----------------|
| `src/config.ts` | All paths, scopes, Graph API version, schedule-window constants, accepted video extensions (`VIDEO_EXTENSIONS`). | Logic. |
| `src/video.ts` | List **all** video files in a folder by extension (`listVideoFiles`, regardless of stem — a folder may hold several); resolve a single video's meta file as `<video-stem>.json` (preferred) or the shared sibling `meta.json` (`resolveMetaForVideo`, named wins); derive MIME from extension (`videoMimeType`). | Probing, upload logic. |
| `src/tokens.ts` | Keyed token store (N accounts/platform); account resolution (`getYouTubeAccount`/`getFacebookAccount`); legacy-shape migration; reads `google-client.json` / FB app creds. **Atomic writes.** | Upload logic. |
| `src/state.ts` | Ledger I/O + `isPosted`/`markPosted`/`markFailed`; one-time legacy-key migration (`migrateLedgerKeys`: folder key → stem key). **Atomic writes.** | Business rules about *when* to post. |
| `src/manifest.ts` | Read + validate the channel `meta.json` (`readChannelManifest`: required `targets` + shared defaults/overrides) and a video meta file (`readManifest(metaPath, videoPath, …)`); `parseTarget`; `publishAt` → UTC & Unix; merge channel + video layers (precedence below); FB window guard; auto-detect `format` from the video's dimensions when absent. | Network calls. |
| `src/probe.ts` | Dependency-free ISO-BMFF box parser (MP4 **and** QuickTime/`.mov` — same atom layout): read display dimensions from `moov`→`trak`→`tkhd`, honouring the rotation matrix. Headers only — never the `mdat` payload. | Network calls, format policy (caller decides portrait ⇒ short). |
| `src/upload-youtube.ts` | `videos.insert` (resumable) + thumbnail + playlist + `#Shorts` hint. Takes a `YouTubeAccount`. Returns `{videoId, url}`. | Token loading, ledger writes. |
| `src/upload-facebook.ts` | Long-form: 3-phase resumable `/videos` upload (start/transfer/finish) + scheduling. Takes a `FacebookAccount`. Returns `{videoId}`. | Token loading, ledger writes. |
| `src/upload-facebook-reel.ts` | Short-form: `/video_reels` flow (start → rupload binary → finish, `video_state=SCHEDULED`). Takes a `FacebookAccount`. Returns `{videoId}`. | Token loading, ledger writes. |
| `src/run.ts` | Orchestration: scan queue for **video items** (per-channel: videos directly in the channel folder **and** in each sub-folder), build each item's stem-based ledger key (`ledgerKey`), migrate legacy keys, read each channel's `targets`, decide skip/upload per target, dispatch by `format`, pass the resolved `videoPath`/`metaPath` into uploads, write ledger, CLI flags. | Platform API details. |

Upload modules **must not** touch the ledger — `run.ts` owns recording outcomes. Keep that
separation so a failed upload is always recorded as `failed`, never silently `posted`.

**Video items & meta filename:** a **video item** = one video file + its meta file. Items are
discovered (`run.ts`) in two places per channel: (1) directly under the channel folder, and
(2) inside each immediate sub-folder. A folder may hold **several** videos, each its own item.
Each item's meta is its stem-named `<video>.json` (preferred) or, **in a sub-folder only**, the
shared sibling `meta.json` (`resolveMetaForVideo`, named wins over shared — no error). The
channel folder's `meta.json` is the **channel meta**, so a channel-root video must carry its own
`<video>.json` (no shared-meta fallback there). An item with no resolvable meta is skipped with a
warning. Per-video thumbnails follow the same rule: `<video>.jpg` preferred, then `thumbnail.jpg`.

**Layout & manifests:** `queue/<channel>/meta.json` is the **channel meta** — `readChannelManifest`
validates a required non-empty `targets` array, pulls out `overrides`, and treats every other
top-level key as a shared `defaults` (`OverrideFields`). A video meta file (`<video>.json` or a
sub-folder's `meta.json`) is the **video meta** — `readManifest(metaPath, videoPath, channelMeta,
target)`; its own `targets` is now **optional and ignored** (targets are a channel concern).
`run.ts` iterates `channelMeta.targets`,
never the video's. The merged content fields use a single ordered spread (weakest first, later
wins): `{ ...channel.defaults, ...channel.overrides[platform], ...channel.overrides[target.raw],
...videoBase, ...video.overrides[platform], ...video.overrides[target.raw] }` — i.e. precedence
**highest → lowest**: video target-override > video platform-override > video base > channel
target-override > channel platform-override > channel default. Dry-run passes `target = null`, so
only `channel.defaults` + the video base merge (still fully offline).

**Accounts:** `tokens.json` is keyed `{ youtube: { <alias>: {...} }, facebook: { <alias>: {...} } }`.
A channel `targets` entry is `"<platform>"` or `"<platform>:<alias>"`; `parseTarget` splits it.
`run.ts` resolves the account (`getYouTubeAccount`/`getFacebookAccount`) and **passes it into**
the upload function — upload modules never load tokens. A bare platform resolves to the sole
account, or throws if multiple are authorized. One channel can list several targets and fan out.

**Format dispatch:** `meta.format` is `"video"` or `"short"`. When omitted it is **auto-detected**
in `manifest.ts` via `probe.ts` — a portrait frame (`height > width`, after the rotation matrix) ⇒
`short`, else `video`; an explicit `format` (base or override) always wins, and an unparseable file
falls back to `"video"`. Detection reads only local file headers, so `--dry-run` stays offline
(invariant #4). `run.ts` routes a
Facebook target to `uploadReelToFacebook` when `format === 'short'`, else `uploadToFacebook`.
YouTube uses the same `uploadToYouTube` for both (Shorts are auto-classified by the file's
aspect ratio + duration; `format: "short"` only adds a `#Shorts` description hint). A Facebook
post is **either** a video **or** a reel per item — both share the `facebook` ledger key, so
the ledger stays `youtube`/`facebook` regardless of format.

## Invariants — do not break these

1. **Video-stem path = ledger key, immutable.** The ledger keys on the queue-relative path to the
   video file's stem (`<channel>/<video>` for a channel-root item, `<channel>/<sub>/<video>` for a
   sub-folder item — see `ledgerKey` in `run.ts`). Never rename, move, or delete queue folders or
   video files in code; renaming any segment orphans history and re-uploads. Legacy folder-level
   keys are migrated to this scheme on load by `migrateLedgerKeys` (only when a folder holds a
   single, unambiguous video) — keep that migration so existing posted history keeps matching.
2. **Per-target idempotency, keyed by the raw target string.** The ledger key is the exact
   target as written in `meta.json` (`"youtube:mychannel"`, not the resolved channel). An item
   can be `posted` on one target and `failed` on another; only the failed one retries. Don't
   collapse status to item-level, and don't key the ledger by resolved account (it must stay
   offline-computable for `--dry-run`).
3. **Atomic ledger & token writes.** Both `saveState` and `saveTokens` write a temp file then
   `rename`. Preserve this — a crash mid-write must not corrupt JSON.
4. **`--dry-run` is fully offline.** It must never load tokens or hit the network. Reading the
   local ledger (`loadState()` — now `queue/state.json`) is allowed — it is a plain file read, so
   the dry-run plan reflects posted/skip status. The line is tokens + network, *not* local state.
   The dry-run branch ends in an early return before any token load or upload call. Keep it that way.
5. **Never mark a failed upload as posted.** Only call `markPosted` after the upload promise
   resolves with a real video id. `upload-facebook.ts` guards against a malformed (but HTTP
   200) start-phase response that lacks `video_id` — keep that guard.
6. **Schedule formats are platform-specific.** YouTube wants RFC 3339 UTC (`publishAtUTC`);
   Facebook wants **Unix seconds** (`publishAtUnix`). Don't mix seconds and milliseconds.
7. **Facebook window:** scheduled time must be **10 min – 6 months** ahead (`FB_MIN/MAX_SCHEDULE_SECS`
   in `config.ts`). Validate in `manifest.ts` only for the `facebook` platform — this applies to
   both videos and reels.
8. **OAuth refresh token.** The YouTube consent URL must keep `access_type=offline` +
   `prompt=consent`, or Google won't return a refresh token on re-auth.
9. **Reels use a different host & protocol.** `/video_reels` start/finish go to
   `FB_GRAPH_BASE`; the binary upload goes to `FB_REELS_RUPLOAD_BASE` with `Authorization: OAuth`,
   `offset`, and `file_size` headers — **not** the `/videos` chunked protocol. Don't merge the two
   adapters. Reels finish uses `video_state=SCHEDULED` (not `published=false`).

## Secrets & git

- `.secrets/` and `queue/` are git-ignored. **Never** write secrets outside `.secrets/`, never
  hardcode tokens/app IDs, never log full token values.
- The ledger now lives at `queue/state.json`, so it is **git-ignored** (via the `queue/` rule)
  and no longer tracked. It still holds only folder paths, video IDs, and timestamps — no
  secrets — but it is not committed.

## Conventions

- Match the existing style: `node:`-prefixed builtins, `async/await`, narrow `interface`s for
  external JSON shapes, JSDoc on exported functions.
- Validate external input (`meta.json`, API responses) and throw clear, actionable errors —
  follow the message style already in `manifest.ts` / `tokens.ts`.
- Keep `config.ts` the single source of truth for paths/constants; don't scatter literals.
- No new runtime dependencies without a reason — Facebook uses the built-in `fetch`/`FormData`
  (Node ≥ 18); only `googleapis` is a prod dep.

## Tests

There is **no** test framework configured. If asked to add tests, the highest-value targets are
`manifest.ts` (timezone/offset math, FB window guard, override merge) and `state.ts`
(skip/retry, atomic write). Use `node:test` + `tsx` (no new heavy deps) and add a
`"test": "tsx --test"` script. Don't add a framework unprompted.

## Known limitations (intentional, not bugs)

- Reels are uploaded single-shot (whole file read into memory); fine for ≤90 s clips.
- No internal scheduler — manual run or external cron/`launchd`.
- A folder may hold **multiple** videos (each `.mp4`/`.mov`, see `VIDEO_EXTENSIONS` in `config.ts`;
  `listVideoFiles` in `video.ts`), each pairing with its stem-named `<video>.json` or the shared
  sibling `meta.json`. Videos may sit directly under the channel folder or in a sub-folder; a
  channel-root video needs its own `<video>.json` (the channel `meta.json` is reserved). A video
  with no resolvable meta is skipped with a warning. A channel whose `meta.json` is missing/invalid
  (or has empty `targets`) is skipped whole.
- No video-side validation of Reel constraints (9:16, 3–90 s) — Facebook rejects non-conforming
  files at upload; we surface that error rather than pre-checking.
