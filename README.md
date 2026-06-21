# social-uploader

A folder-based CLI for **scheduled** video uploads to **one YouTube channel** and **one
Facebook Page** — supporting both long-form videos and short-form **YouTube Shorts / Facebook
Reels**. Drop a folder per video into `queue/`, run one command, and each video is uploaded as
*scheduled/private* so the platform publishes it automatically at the time you set.

State is tracked in a ledger (`queue/state.json`), so the tool **auto-discovers new folders** and
never re-uploads something already posted — you don't tell it which folders to process.

- **Stack:** Node ≥ 20 (developed on v24), TypeScript (ESM), run directly via `tsx`.
- **Platforms:** YouTube Data API v3 + Facebook Graph API. **Multiple channels and Pages** are
  supported — authorize each once, then reference it by alias in `targets`.
- **Run model:** manual (`npm start`). No daemon, no scheduler of its own.

> This is a standalone app. It has no dependency on the surrounding workspace and can be
> copied into its own repo as-is.

---

## How it works

```
queue/
  state.json          # the posted-ledger, keyed by the video-stem path (git-ignored)
  mychannel/         # a channel folder
    meta.json         # { "targets": [...] } + optional shared defaults/overrides (required)
    promo.mp4         # a channel-root video item …
    promo.json        #   … with its own stem-named meta (channel-root needs this; required)
    promo.jpg         #   optional thumbnail for promo.mp4 (YouTube only)
    2026-06-20_demo/  # a video sub-folder (may hold several videos)
      clipA.mp4       # a video — any .mp4/.mov, any name (required)
      clipA.json      #   stem-named meta (preferred), OR fall back to meta.json below
      clipB.mp4       # a second video in the same folder
      meta.json       # shared meta for videos without their own <stem>.json
      thumbnail.jpg   # optional shared thumbnail (or clipA.jpg per video), YouTube only
```

Content is organised **by channel**: each top-level folder under `queue/` is a channel whose
`meta.json` declares the upload `targets` once. A **video item** is one video file plus its meta
file; items inherit the channel's targets. On each run the tool:

1. Scans `queue/` for **channel** folders — each must have a `meta.json` with a non-empty
   `targets` array (a channel with a missing/invalid meta or empty targets is skipped whole).
2. Within each channel, collects **video items** from two places: videos directly under the
   channel folder, and videos inside each sub-folder. A folder may hold several videos. Each
   video's meta is its stem-named `<video>.json` (preferred) or — in a sub-folder — the shared
   `meta.json` (see [Video `meta.json`](#video-metajson)). A video with no resolvable meta is skipped.
3. For every item × each target in its **channel's** `targets`:
   - **already posted** (per the ledger) → skip,
   - **not posted / previously failed** → upload, then record the outcome.
4. Writes results to `queue/state.json`, keyed by the video-stem path (files are
   **never moved or deleted**).

### Scheduling semantics

| Platform | Format | Mechanism | Time format | Window |
|----------|--------|-----------|-------------|--------|
| YouTube  | video / short | `videos.insert`, `privacyStatus: "private"` + `publishAt` | RFC 3339 UTC | — |
| Facebook | video  | `POST /{page-id}/videos`, `published: false` + `scheduled_publish_time` | Unix seconds | **10 min – 6 months** ahead |
| Facebook | reel   | `POST /{page-id}/video_reels` (start → rupload → finish), `video_state: SCHEDULED` + `scheduled_publish_time` | Unix seconds | **10 min – 6 months** ahead |

`publishAt` in `meta.json` is written once (with a timezone offset) and converted to each
platform's required format automatically.

### Short-form: Shorts & Reels

Set `"format": "short"` in `meta.json` for vertical short-form content (or omit it and let the
tool auto-detect — see below). Per platform:

- **YouTube Shorts** — there is **no Shorts API**. A normal upload becomes a Short
  automatically when the file is **vertical (9:16, ≤ 1:1)** and **≤ 3 minutes**. With
  `format: "short"` the tool also appends a `#Shorts` hint to the description. So getting a
  Short is about the *file*, not a different endpoint.
- **Facebook Reels** — a genuinely different endpoint (`/{page-id}/video_reels`) with its own
  upload protocol. Reels must be **9:16, 1080×1920 (min 540×960), 3–90 s, .mp4/.mov**. The tool
  routes `format: "short"` Facebook targets to the Reels flow automatically.

**Auto-detection.** If `format` is omitted, it is inferred from the video's display dimensions:
a **portrait** frame (`height > width`) becomes `short`, otherwise `video`. The check parses the
MP4/MOV box structure locally (no dependencies, headers only — never the payload) and honours the
track **rotation matrix**, so portrait phone footage stored as a rotated landscape frame is
classified correctly. Detection is offline (works under `--dry-run`) and best-effort: an
unparseable file warns and falls back to `"video"`. An explicit `format` always wins.

`format` can also be set per platform via `overrides` (e.g. post as a YouTube Short but a regular
Facebook video); an override likewise takes precedence over auto-detection.

### The ledger (`queue/state.json`)

Idempotency is **per-item, per-target** — the immutable key is the video-stem path
(`<channel>/<video>` for a channel-root item, `<channel>/<sub>/<video>` for a sub-folder item).
The ledger lives at `queue/state.json`, so it is git-ignored along with the rest of `queue/`.

```json
{
  "mychannel/2026-06-20_demo/clipA": {
    "youtube:mychannel":  { "status": "posted", "videoId": "abc123", "url": "https://youtu.be/abc123", "at": "2026-06-13T10:00:00.000Z" },
    "facebook:mychannel": { "status": "failed", "error": "…", "at": "2026-06-13T10:00:05.000Z" }
  }
}
```

- New items are simply keys not yet in the ledger → picked up automatically.
- A **partial failure** (YouTube posted, Facebook failed) only retries the failed target next run.
- Writes are atomic (temp file + rename), so an interrupted run can't corrupt the ledger.
- ⚠️ **Do not rename a channel folder, sub-folder, or video file after it's posted** — it would
  look new and re-upload. (Legacy folder-level keys from older versions are migrated automatically
  on first run, so existing posted history keeps matching the new per-video keys.)

---

## Quick start

```bash
npm install
```

### 1. One-time platform setup (manual — see below)

You must create a Google OAuth client and a Meta app yourself; these can't be scripted.
**Step-by-step guides:** [`docs/setup-youtube.md`](docs/setup-youtube.md) ·
[`docs/setup-facebook.md`](docs/setup-facebook.md). Then authorize each platform once:

```bash
npm run auth:youtube                       # opens a browser consent screen
npm run auth:facebook                      # paste your short-lived user token at the prompt
```

Both write to `.secrets/tokens.json`.

### 2. Add content

Create a **channel** folder under `queue/` (e.g. `queue/mychannel/`) with a `meta.json`
declaring its `targets` (and any shared defaults/overrides) — see
[Channel `meta.json`](#channel-metajson). Then add video items, either:

- **directly in the channel folder** — drop `clip.mp4` next to a stem-named `clip.json`
  (channel-root videos must carry their own `<video>.json`; the channel `meta.json` is reserved);
- **in a sub-folder** — create a folder per batch and drop one or more videos in it; each video
  uses its own `<video>.json` or falls back to a shared `meta.json` in that sub-folder.

The video-stem path is the ledger key (e.g. `mychannel/2026-06-20_demo/clipA`), so a date prefix
on sub-folders reads well and sorts naturally. Per-video thumbnails are `<video>.jpg`, or a shared
`thumbnail.jpg` (YouTube only).

### 3. Preview, then run

```bash
npm start -- --dry-run     # offline plan: per-target action (would-upload / skip-posted) + time
npm start                  # live: uploads everything not already posted
```

> Note the `--` before flags: `npm start` forwards args after `--` to the script.

---

## `meta.json` reference

There are **two** kinds of `meta.json`: a **channel** meta (one per channel folder, declares the
`targets`) and a **video** meta (one per video folder, the content fields).

### Channel `meta.json`

Lives at `queue/<channel>/meta.json`. Only `targets` is required; any other top-level field is an
optional **shared default** that fills gaps the video metas leave open.

```json
{
  "targets": ["youtube:mychannel", "facebook:mychannel"],
  "categoryId": "22",
  "overrides": {
    "facebook": { "description": "Follow the channel for more! 🔔" }
  }
}
```

| Field       | Required | Notes |
|-------------|:--------:|-------|
| `targets`   | ✅ | Non-empty array. Each entry is `"youtube"`, `"facebook"`, or a specific account: `"youtube:<alias>"` / `"facebook:<alias>"`. A bare platform resolves to the sole authorized account (errors if you have more than one). See [Multiple channels & Pages](#multiple-channels--pages). |
| *(any other top-level field)* | ❌ | A shared **default** for every video in the channel — e.g. `categoryId`, `tags`, `madeForKids`, `playlistId`, even `description` or `format`. A video's own value always wins. |
| `overrides` | ❌ | Shared per-platform / per-target override blocks (same shape as a video's `overrides`). |

### Video `meta.json`

Each video's meta is resolved by stem: for `clip.mp4` the tool prefers a sibling `clip.json`,
otherwise (in a sub-folder) falls back to the shared `meta.json`. The stem-named file **wins**
when both are present, so a folder can keep a shared `meta.json` default plus per-video overrides.
A video sitting directly in the channel folder must use its own `<video>.json` — there the
`meta.json` is the channel manifest, not a video meta. **Long-form video:**

```json
{
  "title": "Product Demo",
  "description": "A quick walkthrough of the new product features released this June.",
  "tags": ["demo", "product", "june2026"],
  "categoryId": "22",
  "publishAt": "2026-06-20 22:00 +08:00",
  "madeForKids": false,
  "playlistId": null,
  "format": "video",
  "overrides": {
    "facebook": { "description": "Check out our latest product demo! 🚀" }
  }
}
```

**Short-form (YouTube Short + Facebook Reel):**

```json
{
  "title": "Quick Tip #1",
  "description": "A 30-second product tip.",
  "format": "short",
  "publishAt": "2026-06-21 20:00 +08:00",
  "overrides": {
    "facebook": { "description": "Quick tip! Save this 🔖" }
  }
}
```

| Field         | Required | Applies to | Notes |
|---------------|:--------:|------------|-------|
| `title`       | ✅ | both | |
| `description` | ✅ | both | For Facebook Reels this is the caption. |
| `publishAt`   | ✅ | both | ISO 8601 with offset, e.g. `2026-06-20 22:00 +08:00` (PHT). Converted to UTC for YT and Unix seconds for FB. |
| `format`      | ❌ | both | `"video"` or `"short"` (`"short"` → YouTube Short + Facebook Reel). If omitted, auto-detected from the video's dimensions (portrait ⇒ `short`); falls back to `"video"`. |
| `tags`        | ❌ | YouTube | Defaults to `[]`. |
| `categoryId`  | ❌ | YouTube | Defaults to `"22"` (People & Blogs). |
| `madeForKids` | ❌ | YouTube | Defaults to `false`. |
| `playlistId`  | ❌ | YouTube | If set, the video is added to this playlist after upload. |
| `overrides`   | ❌ | per-platform | Shallow-merges over the base fields for that platform/target (incl. `format`). |
| `targets`     | — | — | **Optional and ignored** — targets are declared once in the channel meta. Any value here is silently dropped. |

### How channel + video fields merge

For each `(video, target)`, content fields resolve by this precedence (**highest wins**):

1. video `overrides["<platform>:<alias>"]`
2. video `overrides["<platform>"]`
3. video base field
4. channel `overrides["<platform>:<alias>"]`
5. channel `overrides["<platform>"]`
6. channel base field (shared default)

In short: the **video layer wins entirely over the channel layer; the channel only fills gaps.**
`format` auto-detection (portrait ⇒ `short`) is the fallback only when no layer sets `format`.

**`publishAt` examples** — `22:00 +08:00` (Manila) resolves to `14:00:00Z`. Use `Z` for UTC
directly. For Facebook the time must be **10 minutes to 6 months** in the future or the run
fails for that target (YouTube has no such lower bound).

**Files per item:**
- One video file — required; any `.mp4` or `.mov`, any filename. A folder may hold **several**
  videos; each is its own item, keyed by its stem.
- A meta file — required; the stem-named `<video>.json` (preferred), or a shared `meta.json` in
  the same sub-folder. A channel-root video must use `<video>.json`. No resolvable meta ⇒ the
  video is skipped with a warning.
- A thumbnail — optional; `<video>.jpg` (preferred) or a shared `thumbnail.jpg`. Set as the
  YouTube custom thumbnail (ignored by Facebook).

---

## Multiple channels & Pages

Each YouTube channel / Facebook Page is authorized once and stored under an **alias** in
`.secrets/tokens.json` (one token per channel — a YouTube token is locked to the single channel
chosen at consent).

**Authorize each channel** — run the auth flow once per channel, picking a different channel at
the consent screen each time. The alias is derived from the channel title (or pass `-- --name`):

```bash
npm run auth:youtube                       # → saves e.g. alias "mychannel"
npm run auth:youtube -- --name gaming      # → saves under alias "gaming"
```

It prints the alias and the exact target string to use. Facebook Pages work identically via
`npm run auth:facebook` (alias from the Page name, or `-- --name`).

**Reference an account in the channel's `targets`** using `platform:alias`. A single channel
folder can fan a clip out to several accounts at once:

```json
{ "targets": ["youtube:mychannel", "youtube:gaming", "facebook:mypage"] }
```

- Every video in that channel is posted as a Short to **two** YouTube channels and a Reel to one
  Page — one channel can **fan out** to many accounts.
- A **bare** `"youtube"` resolves to your only authorized channel; with more than one authorized,
  a bare platform errors and asks you to qualify it as `youtube:<alias>`.
- The **ledger keys on the video-stem path × the exact target string** — `"youtube:mychannel"`
  and `"youtube:gaming"` are tracked independently. Don't change a target string after it's posted
  (same rule as not renaming a folder), or it'll re-post.
- `overrides` (in either the channel or a video meta) can be keyed by platform (`"youtube"`) or by
  a specific account (`"youtube:gaming"`); the account-specific override wins — handy for a
  per-channel title.

List what's authorized any time by checking the alias keys in `.secrets/tokens.json`.

---

## CLI

| Command | What it does |
|---------|--------------|
| `npm start` | Upload every queued video × its channel's targets not already posted. |
| `npm start -- --dry-run` | Print the plan table — the `ITEM` column shows the video-stem key; per-target action (`would-upload` / `would-upload (short\|reel)` / `skip (posted)`) and scheduled time, honouring `--force`. **Fully offline** — reads the local ledger only; no token load, no network. |
| `npm start -- --force <key-or-prefix>` | Re-post matching items even if ledgered as posted. Matches an exact item key (e.g. `mychannel/2026-06-20_demo/clipA`) or any key under a path prefix (e.g. `mychannel/2026-06-20_demo` forces every video in that folder). |
| `npm run auth:youtube` | Authorize a YouTube channel (loopback on `127.0.0.1:8080`); run once per channel. Alias via `-- --name <alias>`. |
| `npm run auth:facebook` | One-time FB token exchange (paste token at the prompt). Non-interactive: `npm run auth:facebook -- --token <t>`. |
| `npm run typecheck` | `tsc --noEmit`. |

**Quota awareness:** a YouTube `videos.insert` costs **1600 quota units**; the default daily
quota is **10,000** → roughly **6 uploads/day**. The tool warns if a single run attempts more
than 6 YouTube uploads. Request a quota increase from Google if you need more.

---

## One-time platform setup (manual)

These steps are interactive and on you — the tool can't bootstrap them.

### Google / YouTube

1. [GCP Console](https://console.cloud.google.com) → create a project.
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **OAuth consent screen** → add yourself as a **test user** (so the unverified app can be used).
4. **Credentials** → create an **OAuth 2.0 Client ID** of type **Desktop app**.
5. Download the JSON and save it as **`.secrets/google-client.json`** (it must have the
   top-level `"installed"` key — the Desktop-app format).
6. Run `npm run auth:youtube`, complete consent in the browser; the refresh token is saved to
   `.secrets/tokens.json`. (The consent URL uses `prompt=consent` so a refresh token is
   always returned.)

### Facebook

1. [Meta for Developers](https://developers.facebook.com) → create an app (**Business** type).
2. Provide the app credentials to the tool — **either**:
   - set env vars `FB_APP_ID` and `FB_APP_SECRET`, **or**
   - create `.secrets/fb-app.json`: `{ "app_id": "…", "app_secret": "…" }`.
3. In the [Graph API Explorer](https://developers.facebook.com/tools/explorer), generate a
   **short-lived user token** with scopes `pages_show_list`, `pages_manage_posts`,
   `pages_read_engagement`.
4. Run `npm run auth:facebook` and paste the token at the prompt (or non-interactively,
   `npm run auth:facebook -- --token <short-lived-token>`). The script exchanges it for a
   long-lived token, lists your Pages (prompts if more than one), and saves the selected
   `page_id` + non-expiring page token to `.secrets/tokens.json`.

> Full walkthrough: [`docs/setup-youtube.md`](docs/setup-youtube.md) and
> [`docs/setup-facebook.md`](docs/setup-facebook.md).

> **App Review:** posting to a Page **you own** while the app is in development mode works
> **without** App Review. App Review + Business Verification are only required to act on Pages
> you don't own, or to take the app public.

---

## Verifying a real upload

The first live upload is worth watching end-to-end (neither scheduled-FB nor YouTube quota can
be exercised without real credentials):

1. `npm start -- --dry-run` — confirm the schedule times look right and which targets are
   pending (`would-upload`) vs already posted (`skip (posted)`).
2. `npm start` — confirm `✓ posted` for each target and the ledger entry in `queue/state.json`.
3. Confirm in **YouTube Studio** (video listed as *Scheduled* with the right time) and
   **Facebook Page → Publishing Tools → Scheduled posts**.
4. Re-run `npm start` — everything should be skipped (idempotency).

---

## Project layout

```
social-uploader/
├── package.json
├── tsconfig.json
├── .gitignore           # .secrets/, queue/, node_modules, *.log, dist/
├── .secrets/            # NEVER committed — see .gitignore
│   ├── google-client.json   # you download this from GCP
│   ├── fb-app.json          # optional (or use FB_APP_ID / FB_APP_SECRET)
│   └── tokens.json          # written by the auth scripts
├── src/
│   ├── config.ts        # paths, scopes, Graph API version, schedule windows
│   ├── tokens.ts        # load/save tokens; read google-client / fb-app creds
│   ├── state.ts         # ledger load/save (atomic); isPosted / markPosted / markFailed; legacy-key migration
│   ├── manifest.ts      # read + validate channel & video meta; merge layers; publishAt → UTC + Unix; format auto-detect
│   ├── video.ts         # list folder videos (.mp4/.mov); resolve a video's meta (<stem>.json / shared meta.json); MIME helper
│   ├── probe.ts         # dependency-free MP4/MOV parser: display dimensions (honours rotation)
│   ├── auth-youtube.ts  # one-time loopback OAuth
│   ├── auth-facebook.ts # one-time token exchange + page selection
│   ├── upload-youtube.ts# videos.insert (resumable) + thumbnail + playlist + Shorts hint
│   ├── upload-facebook.ts# long-form: 3-phase resumable /videos upload + schedule
│   ├── upload-facebook-reel.ts# reels: /video_reels start → rupload → finish + schedule
│   └── run.ts           # entry point: scan queue for video items, dispatch (video vs short), record ledger
└── queue/               # your content, organised by channel (git-ignored)
    ├── state.json           # the posted-ledger, keyed by the video-stem path (git-ignored)
    └── <channel>/           # channel folder — meta.json declares targets
        ├── meta.json        # channel meta
        ├── <video>.mp4      # channel-root item: needs its own <video>.json
        ├── <video>.json
        └── <sub>/           # sub-folder: 1+ videos, each <video>.json or shared meta.json
            ├── <video>.mp4
            ├── <video>.json
            └── meta.json    # shared fallback for videos lacking <video>.json
```

---

## Security notes

- `.secrets/` and `queue/` are git-ignored. **Never commit tokens or app secrets.**
- The ledger lives at `queue/state.json`, so it is git-ignored along with the rest of `queue/`.
  It contains only folder paths, platform video IDs, and timestamps — no secrets — but it is not
  committed; back it up yourself if you want a record of what was posted.
- The Facebook page token is non-expiring; treat `.secrets/tokens.json` as a credential.

## Limitations

- **No automated tests** — `tsc --noEmit` (strict) plus the offline `--dry-run` are the
  verification layer.
- **Reels are single-shot uploads** — the whole file is read into memory (fine for ≤90 s
  vertical clips; long-form video uses the chunked `/videos` path instead).
- **No built-in scheduler** — run it manually, or wire `npm start` into cron/`launchd`
  yourself (the ledger makes repeated runs safe).

---

## License

[MIT](LICENSE)
