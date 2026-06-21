# Facebook setup guide

One-time setup so `social-uploader` can post videos and **Reels** to **your Facebook Page**.
End result: a non-expiring **Page access token** saved in `.secrets/tokens.json`.

**Time:** ~10–15 min. **You need:** a Facebook account that is an **admin of the target Page**.

> **Which account?** Meta keys on your **Facebook user**, not an email. The account you use to
> generate the token in step 3 **must be an admin of the Page** — otherwise the Page won't show
> up and setup fails. The app itself can belong to any developer account.

---

## 1. Create a Meta app

1. Go to [Meta for Developers](https://developers.facebook.com) and register as a developer if
   you haven't (uses your normal Facebook account).
2. **My Apps → Create App**.
3. App type: **Business** → Next.
4. Give it a name (e.g. `social-uploader`), enter your contact email → **Create App**.

## 2. Get the App ID and App Secret

1. In the app dashboard: **App settings → Basic**.
2. Copy the **App ID** and **App Secret** (click **Show** for the secret).
3. Provide them to the tool in **one** of two ways:

   **Option A — env vars** (nothing stored on disk):
   ```bash
   export FB_APP_ID=your_app_id
   export FB_APP_SECRET=your_app_secret
   ```

   **Option B — file** `.secrets/fb-app.json`:
   ```json
   { "app_id": "your_app_id", "app_secret": "your_app_secret" }
   ```

   Env vars take precedence over the file if both are set.

## 3. Get a short-lived user token

1. Open the [Graph API Explorer](https://developers.facebook.com/tools/explorer).
2. Top right: select **your app** in the *Meta App* dropdown.
3. **User or Page** dropdown → **User Token**.
4. Click **Permissions / Add a Permission** and tick these three:
   - `pages_show_list`
   - `pages_manage_posts`
   - `pages_read_engagement`
5. Click **Generate Access Token** → approve the dialog (log in / confirm with the Facebook
   account that **admins the Page**).
6. Copy the generated token. It's short-lived (~1 hour) — that's fine, the next step exchanges it
   for a long-lived one.

> In **development mode** an app admin can grant these `pages_*` permissions **without App
> Review**, as long as you're acting on a Page **you own**. App Review + Business Verification are
> only needed to manage Pages you don't own or to make the app public.

## 4. Exchange and save the Page token

Run the auth script and paste the token when prompted:

```bash
npm run auth:facebook
# → "Paste your short-lived user token:"  ← paste it here
```

What it does:
1. Exchanges your short-lived token for a **long-lived user token** (using the app id/secret).
2. Calls `GET /me/accounts` to list Pages you administer.
3. If you admin more than one Page, it prompts you to pick; if only one, it auto-selects.
4. Saves the selected `page_id` + **non-expiring Page token** to `.secrets/tokens.json`.

**Non-interactive form** (note the `--` so npm forwards the flag to the script):

```bash
npm run auth:facebook -- --token <your-short-lived-token>
```

> ⚠️ Don't write `npm run auth:facebook --token <...>` **without** the `--` — npm would swallow
> `--token` as its own flag and the script wouldn't receive it. The interactive prompt above is
> the foolproof option.

## 5. Verify

```bash
npm start -- --dry-run
```

Offline check that the project runs. The real proof is a live scheduled post — confirm it in
**Facebook Page → Professional dashboard / Publishing tools → Scheduled posts** (videos) and the
Page's **Reels** section.

---

## Reels requirements

When a folder's `meta.json` has `"format": "short"`, Facebook uploads it as a **Reel** via the
`/video_reels` endpoint. Facebook enforces these — the tool does **not** pre-check them, so a
non-conforming file fails at upload and is recorded as `failed`:

- Aspect ratio **9:16**
- Resolution **1080×1920** (minimum 540×960)
- Duration **3–90 seconds**
- Format **.mp4**

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `No pages found for this user token` | Your account doesn't admin any Page, or you forgot the `pages_show_list` scope. Confirm you're a Page admin and re-generate the token with all three scopes. |
| `Missing FB app credentials` | `FB_APP_ID`/`FB_APP_SECRET` not exported and no `.secrets/fb-app.json`. See step 2. |
| `Long-lived token exchange failed` | Wrong app id/secret, or the short-lived token was already expired (>~1h). Generate a fresh token (step 3) and retry. |
| Script got no `--token` value | You used `--token` without the `--` separator. Use `npm run auth:facebook -- --token <t>` or just run `npm run auth:facebook` and paste at the prompt. |
| Reel upload fails with a spec error | The clip violates the Reels requirements above (aspect/duration/resolution). Re-export and retry — the ledger will retry just that target. |
| Scheduled time rejected | Facebook requires the schedule to be **10 min – 6 months** in the future. Adjust `publishAt`. |

## Security

- `.secrets/` is git-ignored — **never commit** `fb-app.json` or `tokens.json`.
- The Page token is **non-expiring**; treat `.secrets/tokens.json` as a credential. If it leaks,
  rotate it by regenerating from a fresh user token (and consider resetting the App Secret).
