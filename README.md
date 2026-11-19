# cuida.

my standalone health log — mood, pain, meds, br, food, vitals, sleep, period — as an installable web app that writes straight into my health tracker google sheet. no server, no build step, no npm. just html/css/js. two tabs: tracking (log everything) and dashboard (insights from the last few weeks).

## how it works

- the app is a static PWA (this repo). it runs entirely in the browser.
- the backend is a google apps script web app (`backend/Code.gs`). the app calls it with `fetch`, and the script is the only thing that touches my sheet.
- my data lives in the sheet, not in the app and not on the host. the host (github pages) only serves the app files.
- sign-in is google sign-in (google identity services). i sign in once per device and the app stores the id token in that device's localStorage. every request carries the token in the POST body, and the backend verifies it against the oauth client id AND an allowed google account email before touching the sheet — the endpoint url stopped being the key the day sign-in landed. the endpoint url itself lives in `js/config.js` (it's an address, not a secret anymore); devices that saved it in localStorage during the first setup keep using their saved copy as a fallback.
- logging is local-first: every entry saves to the device immediately and shows up in the today list right away, then syncs to the sheet in the background. every entry carries a client-generated id, and the backend logs it in a Sync Log tab — a retry after a lost response returns the row it already landed on instead of duplicating it.
- my mom can use the same app: she installs it, signs in with her google account, and her entries go to the same sheet. her email just has to be in `ALLOWED_EMAILS` in `backend/Code.gs`.

## setup (one time)

### the apps script backend

1. open [script.google.com](https://script.google.com), make a new project, paste in `backend/Code.gs` (the whole file, it's self-contained).
2. set the script timezone to America/Chicago (project settings, the gear icon) so "today" and the datetimes match my sheet.
3. deploy → new deployment → web app. execute as: me. who has access: anyone.
4. copy the web app url into `APPS_SCRIPT_URL` in `js/config.js`.

### google sign-in setup

the app needs a google oauth client id before sign-in works. one-time, in [google cloud console](https://console.cloud.google.com):

1. pick a project (or create one — anything, it's just a container for the oauth client).
2. APIs & Services → OAuth consent screen → get started. user type: external. fill in the app name + your email; scopes: only `openid`, `email`, `profile` (basic scopes — no verification needed for these). while the app is in testing mode, only listed test users can sign in — add your own email and your mom's under "test users" (or hit publish; with only basic scopes that's safe and removes the restriction).
3. APIs & Services → Credentials → Create credentials → OAuth client ID → application type: **web application**.
4. under "authorized javascript origins", add `https://sycstitch.github.io` (the app's origin — sign-in only works from here). no redirect uris needed.
5. copy the client id (ends in `.apps.googleusercontent.com`) into **two** places: `CLIENT_ID` in `js/config.js` and `CLIENT_ID` in `backend/Code.gs`.
6. put your google account email and your mom's in `ALLOWED_EMAILS` in `backend/Code.gs` — this is the check that proves a request is from one of you, since the client id itself is public.
7. re-paste `backend/Code.gs` into the apps script project and deploy a new version (see "updating the apps script" below), then open the app and sign in with google. done — no url to paste anywhere, ever.

## updating the apps script (when Code.gs changes)

the app and the script have to stay in step — new app features that need a new backend action won't work until the script is updated. the url stays the same:

1. open the project at [script.google.com](https://script.google.com), replace the whole file with the new `backend/Code.gs`.
2. deploy → manage deployments → pencil icon on the web app deployment → version: new version → deploy. same url, no need to re-paste anything in the app.

## deploying the app (github pages)

1. push to the `health-log` repo on github (public — there's no data and no secrets in it). the repo can't be named `cuida` right now: that name is taken by my private firebase repo. if that repo ever gets renamed, this one can take the name and the site moves to `sycstitch.github.io/cuida/`.
2. repo settings → pages → source: github actions. the `.github/workflows/static.yml` workflow deploys on every push to `main`.
3. open `https://sycstitch.github.io/health-log/` on my phone, install it from the browser menu ("add to home screen" / "install app").
4. sign in with google on first run, then test-log something small and check the sheet.

## offline

every entry saves to the device first, so logging works with no signal at all. entries waiting to sync show in the header count, and they send automatically, oldest first, when i'm back online — or when the app comes back to the foreground, or when i sign in again. nothing gets dropped silently, and a retried entry never duplicates thanks to the sync log.

## things worth knowing

- the mood log's score + date formulas are written by the backend for the exact row each entry lands on, so they never point at the wrong row. the backend finds the last real entry by looking at column A only — the sheet has helper columns prefilled hundreds of rows down, so a plain append would land in the wrong place.
- meds live in their own tab (Meds Log) and br lives in its own tab (Bathroom Log: urine color, stool color, bristol types, blood). both tabs are created automatically with headers if they're missing.
- the meds early / on time / late marker (against 7pm) is display-only in the app — it doesn't go in the sheet, same as the rows already there. and there is no "missed" button, ever.
- vitals: heart rate can be logged on its own, but systolic and diastolic have to go together.
- in the br section, nothing logs until i hit the one submit button — a whole trip lands as one row.
- the dashboard tab pulls the last 45 days from the sheet and computes everything in the browser: mood/sleep/pain/stress summaries, meds streak, water totals, cycle day, plus two early-hint relationships (stress vs mood, sleep vs next-day pain). every card says so when there isn't enough data yet — nothing is made up.
- water has quick buttons (4 / 8 / 16 oz) plus a custom amount. tampon sizes sit right below the flow buttons, all five on one row, tap-to-log like before.
- the period tab is date / flow / symptoms / cycle day / notes / cycle start? — cycle day + cycle start are prefilled formulas, so the backend writes around them (date, flow, symptoms, then notes) and never touches them. period rows are date-only, no time, so the cycle math stays exact. logging twice for the same date merges into one row instead of duplicating it.
- the Sync Log tab in the sheet is the backend's own bookkeeping ([entry id, tab, row, timestamp]) — it's how retries stay duplicate-free. don't edit it by hand.
- dates: the app sends local datetimes and the backend stores them as real date values in the sheet. if the script timezone isn't America/Chicago, "today" in the history list can be off by a day.

## later

health connect (automatic heart rate + sleep from my phone/watch) is the next possible step, but it can't live in this app — health connect has no web api, so it would need a small native android companion (or a feature in miso) that reads it on the phone and sends rows to the same apps script backend. the queue + the sheet schemas stay the same either way.
