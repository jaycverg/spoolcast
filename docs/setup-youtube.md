# YouTube setup guide

One-time setup so `social-uploader` can upload to **your YouTube channel**. End result: a
`refresh_token` saved in `.secrets/tokens.json`.

**Time:** ~10–15 min. **You need:** a Google account that **owns or manages the target channel**.

> **Which account?** The Google Cloud *project* can live under any account, but the account you
> **log in with during step 5** must own/manage the channel — that's whose access the token
> represents. Simplest: use the channel's own Google account for everything below.

---

## 1. Create a Google Cloud project

1. Go to the [Google Cloud Console](https://console.cloud.google.com).
2. Top bar → project dropdown → **New Project**. Name it anything (e.g. `social-uploader`).
3. Make sure that new project is selected before continuing.

## 2. Enable the YouTube Data API v3

1. **APIs & Services → Library** (or search "YouTube Data API v3").
2. Open **YouTube Data API v3** → **Enable**.

## 3. Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. **User type: External** → Create.
3. Fill the required fields (app name e.g. `social-uploader`, your email for support + developer
   contact). You can leave optional fields blank.
4. **Scopes:** you don't have to add scopes here for testing — the app requests them at runtime.
   (If asked, the tool uses `.../auth/youtube.upload` and `.../auth/youtube`.)
5. **Test users:** click **Add Users** and add the **email of the Google account that manages
   your channel**. This is required — while the app is in *Testing* mode, only listed test users
   can authorize it. Leave the app in **Testing** (you do *not* need to publish/verify it for
   personal use).

## 4. Create the OAuth client credentials

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. **Application type: Desktop app**. Name it anything → **Create**.
3. In the dialog, click **Download JSON**.
4. Save that file as **`.secrets/google-client.json`** in the project root.

> The file must have a top-level **`"installed"`** key (that's the Desktop-app format). If it has
> `"web"` instead, you picked the wrong application type — recreate it as **Desktop app**.

```
social-uploader/
└── .secrets/
    └── google-client.json   ← here
```

## 5. Authorize (get the refresh token)

From the project root:

```bash
npm run auth:youtube
```

What happens:
1. A local server starts on `http://127.0.0.1:8080` and a Google consent URL is printed/opened.
2. **Log in with the Google account that manages your channel.**
3. If that account has a **Brand Account / multiple channels**, Google shows a **channel picker** —
   choose the channel you want to upload to.
4. You'll see an "unverified app" warning (expected, since the app is in Testing) → **Advanced →
   Go to social-uploader (unsafe)** → **Allow**.
5. On success, the refresh token is saved under an **account alias** (derived from the channel
   title) in `.secrets/tokens.json`. The script prints the alias and the target string to use,
   e.g. `Use it in meta.json as a target: "youtube:mychannel"`.

You can re-run `npm run auth:youtube` anytime to re-authorize (the consent URL uses
`access_type=offline` + `prompt=consent`, so a refresh token is always returned).

### Multiple channels

Run the auth flow **once per channel**, picking a different channel at the picker each time —
each is stored under its own alias (one refresh token per channel; a token can't span channels).
Override the alias with `-- --name`:

```bash
npm run auth:youtube                    # alias from channel title, e.g. "mychannel"
npm run auth:youtube -- --name gaming   # force alias "gaming"
```

Then target a specific channel in `meta.json`: `"targets": ["youtube:mychannel", "youtube:gaming"]`.
A bare `"youtube"` works only when exactly one channel is authorized. See the main README's
*Multiple channels & Pages*.

## 6. Verify

```bash
npm start -- --dry-run
```

This is offline and won't use the token, but it confirms the project runs. The real proof is a
live upload (see the main README's "Verifying a real upload").

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `Error 403: access_denied` on the consent screen | The account you logged in with isn't listed as a **Test user** (step 3.5). Add it, or log in with a listed account. |
| `Missing .secrets/google-client.json` | You didn't download/place the OAuth client JSON (step 4). |
| `google-client.json is malformed — expected "installed" key` | You created a **Web** client instead of **Desktop app**. Recreate as Desktop app. |
| Uploaded to the wrong channel | You picked the wrong channel/Brand Account at the picker (step 5.3). Re-run `npm run auth:youtube` and choose the right one. |
| `quotaExceeded` on upload | YouTube allows ~6 uploads/day by default (1600 units each, 10k/day). Wait for the daily reset or [request more quota](https://support.google.com/youtube/contact/yt_api_form). |
| Port 8080 already in use | Free the port (the loopback port is `YOUTUBE_OAUTH_PORT` in `src/config.ts`). |

## Security

- `.secrets/` is git-ignored — **never commit** `google-client.json` or `tokens.json`.
- The refresh token grants upload access to your channel; treat it as a credential.
