# Importing shortsgenerated into Google AI Studio (Build / "Build apps with Gemini")

This copies the shortsgenerated studio into an AI Studio app. Read the honest limits first.

## Honest limits (do not skip)

- AI Studio apps call the Gemini API with a key, exactly like this site does.
  Generation bills to the billed Google Cloud project behind that key.
- Your **Flow credits (1,050) can NOT pay for in-app generation** — Flow (web app
  for creators) and the Gemini API (per-second developer billing) are separate
  systems. This is Google's design, not something the import changes.
- If the key backing the AI Studio copy has no billing/quota for Veo, you will
  get the same 429 RESOURCE_EXHAUSTED you saw here. Fix = enable billing on
  that key's Cloud project, or keep using Flow → Media → Upload.

## What was adapted in the code (already done in /home/team/shared/site)

- `src/studio/googleai.ts` → `envBundledKey()`: the app accepts an
  environment-bundled key from `VITE_GEMINI_API_KEY` / `GEMINI_API_KEY`
  (Vite build-time) or `process.env.GEMINI_API_KEY` / `process.env.API_KEY`
  (AI Studio Build's runtime injection). All access guarded for SSR/browser.
- `src/studio/studio.ts` → `getKey()` precedence: your pasted localStorage key
  (`rankreel.geminiKey`) always wins; otherwise the env key is used; the
  connect button offers "use your own instead" when running on an env key.
- Storage keys unchanged (`rankreel.prefs.v1`, IndexedDB `rankreel/voiceover`),
  title `shortsgenerated`, manifest/icons, mobile layout untouched.

## Steps

1. **Put the code on GitHub.** The workspace at `/home/team/shared/site` is not
   a git repo. Create one and push:
   ```bash
   cd /home/team/shared/site
   git init && git add -A && git commit -m "shortsgenerated studio"
   gh repo create shortsgenerated --private --source=. --push
   ```
   (Never commit an API key — the `.gitignore` covers `.env` files; double-check
   with `git status` before pushing.)
2. **Import into AI Studio.** Open AI Studio → Build → "Import from GitHub"
   (or "Import repo"), pick the `shortsgenerated` repo.
3. **Build settings.** Build command: `bun run build` (fallback: `npm install
   && npm run build`). If the importer needs a preview server, the app serves
   `dist/client` + SSR handler; locally that is `bun run start` on port 3000
   (see `serve.ts` / `publish.sh`).
4. **API key.** If AI Studio injects `GEMINI_API_KEY`/`API_KEY` at runtime, the
   app uses it automatically. Otherwise open the imported app and paste your
   own key via Connect Google AI (stored in that browser only).
5. **Verify inside the AI Studio preview:** title `shortsgenerated`; connect
   flow works; Generate AI read produces Vietnamese audio; Veo shot works
   (needs a billed project — expect 429 without one); no "Higgsfield" or
   "RankReel" strings in the UI.

## After import

- PWA install-to-home-screen comes from the hosted URL
  (https://shortsgenerated.ctonew.app), not from the AI Studio preview.
- Keep developing here; re-import or pull updates into the GitHub repo when
  you want the AI Studio copy to catch up.
