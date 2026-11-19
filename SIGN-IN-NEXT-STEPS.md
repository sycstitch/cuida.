# sign-in next steps (short version)

my part, when i'm home — about 5 minutes in google cloud console:

1. open https://console.cloud.google.com, pick or create a project.
2. apis & services → credentials → create credentials → oauth client id → **web application**.
3. authorized javascript origins: add `https://sycstitch.github.io`. no redirect uris.
4. copy the client id and give it to mishi, along with the email on my google account and my mom's google account email.

mishi's part after that:

- plug the client id into `js/config.js` and `backend/Code.gs`, both emails into `ALLOWED_EMAILS` in `backend/Code.gs`, and the web app url into `APPS_SCRIPT_URL` in `js/config.js` (it's shown read-only in the app's settings on my phone).
- upload the app.

my last part:

- re-paste the new `backend/Code.gs` in script.google.com → deploy → manage deployments → new version (same url). this is the same redeploy that fixes the dashboard.
- open the app, sign in with google, test-log something small, check the sheet.

notes: scopes stay openid/email/profile only. the script will ask for one new permission when i redeploy (it checks my token with google) — that's expected. mom's setup after this is just install + sign in with google.
