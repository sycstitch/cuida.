// api.js — talks to the apps script backend, with a local-first journal.
//
// every log goes through logEntry(tab, values, label). the entry is saved
// locally FIRST (with a client-generated uuid) and shows up in the today
// list immediately; the send to the sheet happens in the background. if
// the post fails (offline, backend down, whatever), the entry stays in
// localStorage and is retried automatically when we're back online.
// nothing is ever dropped, and the backend dedups by entry id, so a
// retry after a lost response can never duplicate a row.
//
// auth: sign in with google (google identity services). the id token is
// stored in localStorage and sent in the POST body of every request; the
// backend verifies it against the oauth client id AND an allowed google
// account email before touching the sheet. the apps script url itself is
// just an address now — it stopped being the key the day sign-in landed.

const QUEUE_KEY = "healthlog.queue.v1";

// the apps script web app url. it lives in js/config.js now (an address,
// not a secret); devices that saved it in localStorage during the first
// setup keep using their saved copy as a fallback.
const URL_KEY = "healthlog.appsScriptUrl";

// the google id token + account email from sign-in. the token lasts about
// an hour; when the backend rejects it we try to get a fresh one via one
// tap before asking her to sign in again.
const TOKEN_KEY = "healthlog.idToken";
const EMAIL_KEY = "healthlog.email";

function getConfigUrl() {
  try {
    return (typeof HEALTHLOG_CONFIG !== "undefined" && HEALTHLOG_CONFIG.APPS_SCRIPT_URL) || "";
  } catch (e) {
    return "";
  }
}

function getBackendUrl() {
  const fromConfig = (getConfigUrl() || "").trim();
  if (fromConfig.indexOf("https://") === 0) return fromConfig;
  try {
    return (localStorage.getItem(URL_KEY) || "").trim();
  } catch (e) {
    return "";
  }
}

function getIdToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch (e) {
    return "";
  }
}

function getSignedInEmail() {
  try {
    return localStorage.getItem(EMAIL_KEY) || "";
  } catch (e) {
    return "";
  }
}

function saveIdToken(token, email) {
  try {
    localStorage.setItem(TOKEN_KEY, token || "");
    localStorage.setItem(EMAIL_KEY, email || "");
  } catch (e) {}
}

function clearAuth() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EMAIL_KEY);
  } catch (e) {}
}

function loadQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  if (typeof updateQueueIndicator === "function") updateQueueIndicator();
}

function isConfigured() {
  return getBackendUrl().indexOf("https://") === 0;
}

function isSignedIn() {
  return getIdToken() !== "";
}

// one uuid per entry, generated when the entry is first saved locally.
// the backend logs it in its sync log, so re-sending the same entry (a
// retry after a lost response, a flush after reopening) returns the row
// it already landed on instead of appending a second one.
function newEntryId() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch (e) {}
  return Date.now() + "-" + Math.random().toString(36).slice(2);
}

// ---------- google sign-in ----------

function getClientId() {
  try {
    return (typeof HEALTHLOG_CONFIG !== "undefined" && HEALTHLOG_CONFIG.CLIENT_ID) || "";
  } catch (e) {
    return "";
  }
}

// a real oauth client id always ends in .apps.googleusercontent.com — the
// placeholder doesn't, so this doubles as a "has it been filled in" check.
function clientIdReady() {
  return getClientId().indexOf(".apps.googleusercontent.com") !== -1;
}

function gisAvailable() {
  return typeof google !== "undefined" && google.accounts && google.accounts.id;
}

var gisInitialized = false;

function initAuth() {
  if (gisInitialized) return true;
  if (!gisAvailable() || !clientIdReady()) return false;
  google.accounts.id.initialize({
    client_id: getClientId(),
    callback: handleCredential,
    auto_select: true,
  });
  gisInitialized = true;
  return true;
}

// wait a few seconds for the google library to arrive (it loads async),
// then initialize. resolves true when sign-in is usable.
function ensureAuth() {
  if (initAuth()) return Promise.resolve(true);
  return new Promise(function (resolve) {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (initAuth() || tries >= 20) {
        clearInterval(timer);
        resolve(gisInitialized);
      }
    }, 250);
  });
}

// decode the jwt payload (no verification here — the backend does that).
// only used to pull the email out for display.
function decodeIdToken(token) {
  try {
    var parts = token.split(".");
    if (parts.length !== 3) return null;
    var b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    return JSON.parse(atob(b64));
  } catch (e) {
    return null;
  }
}

// the one credential callback for the sign-in button and one tap alike.
// when a token refresh is pending, this just hands the fresh token over;
// otherwise it's a real sign-in, so hide setup and get moving.
var refreshResolver = null;

function handleCredential(response) {
  var token = response && response.credential;
  if (!token) return;
  var payload = decodeIdToken(token);
  saveIdToken(token, payload && payload.email ? payload.email : "");
  if (refreshResolver) {
    var r = refreshResolver;
    refreshResolver = null;
    r(true);
    return;
  }
  if (typeof hideSetup === "function") hideSetup();
  if (typeof toast === "function") toast("signed in :)");
  flushQueue();
  if (typeof loadToday === "function") loadToday();
}

// render the standard "sign in with google" button into a container.
// returns false when google isn't loaded (or the client id isn't set) so
// the caller can retry — the library loads async.
function renderSignInButton(el) {
  if (!el || !initAuth()) return false;
  el.innerHTML = "";
  var w = Math.max(200, Math.min(400, el.clientWidth || 320));
  google.accounts.id.renderButton(el, {
    theme: "filled_black",
    size: "large",
    text: "signin_with",
    shape: "rectangular",
    width: w,
  });
  return true;
}

// one tap prompt — if her google session allows it, she signs in without
// touching the button. safe to call even when it can't show; the button
// is always there as the fallback.
function showOneTap() {
  try {
    if (initAuth()) google.accounts.id.prompt();
  } catch (e) {}
}

// try once to get a fresh token via one tap. resolves true when a new
// token landed, false otherwise (dismissed recently, cookies blocked,
// library never loaded — all just mean "ask her to sign in").
var refreshPromise = null;

function refreshIdToken() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = ensureAuth().then(function (ok) {
    if (!ok) return false;
    return new Promise(function (resolve) {
      refreshResolver = function (done) {
        refreshResolver = null;
        resolve(done);
      };
      try {
        google.accounts.id.prompt(function (notification) {
          if (notification.isNotDisplayed() || notification.isSkippedMoment() || notification.isDismissedMoment()) {
            if (refreshResolver) {
              var r = refreshResolver;
              refreshResolver = null;
              r(false);
            }
          }
        });
      } catch (e) {
        if (refreshResolver) {
          var r = refreshResolver;
          refreshResolver = null;
          r(false);
        }
      }
      // safety net: never hang forever waiting on a prompt that never comes.
      setTimeout(function () {
        if (refreshResolver) {
          var r = refreshResolver;
          refreshResolver = null;
          r(false);
        }
      }, 10000);
    });
  }).then(function (ok) {
    refreshPromise = null;
    return ok;
  });
  return refreshPromise;
}

// sign out: token + email go, the endpoint url stays (it's not a secret
// anymore). disableAutoSelect keeps one tap from signing her straight
// back in until she taps the button herself.
function signOut() {
  clearAuth();
  try {
    if (gisAvailable() && gisInitialized) google.accounts.id.disableAutoSelect();
  } catch (e) {}
}

// ---------- backend posts ----------

// plain text/plain post: keeps the request "simple" so the browser skips
// the CORS preflight, which apps script web apps don't answer. the backend
// still reads the body as JSON via e.postData.contents.
//
// the id token rides in the JSON body, never an Authorization header —
// a custom header would trigger the preflight we're dodging.
async function postJson(payload) {
  const res = await fetch(getBackendUrl(), {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("backend error " + res.status);
  const data = await res.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}

// every request carries the id token. when the backend says the token is
// invalid (usually just expired — id tokens last about an hour), try once
// to get a fresh one via one tap and retry the same request once. if that
// fails, the caller gets "not-signed-in" and the app shows the sign-in
// screen — a returning user with a stored token is never asked to sign in
// again until a token is actually rejected.
async function postToBackend(payload) {
  const token = getIdToken();
  if (!token) throw new Error("not-signed-in");
  try {
    return await postJson(Object.assign({}, payload, { id_token: token }));
  } catch (err) {
    if (err.message !== "invalid token") throw err;
    const refreshed = await refreshIdToken();
    if (!refreshed) throw new Error("not-signed-in");
    try {
      return await postJson(Object.assign({}, payload, { id_token: getIdToken() }));
    } catch (err2) {
      if (err2.message === "invalid token") throw new Error("not-signed-in");
      throw err2;
    }
  }
}

// ---------- append verification ----------
// the backend returns the values it wrote for the landed row. check what
// we sent against what landed — a mismatch means the write went sideways
// and the entry stays queued for a retry (the entry id keeps the retry
// from duplicating the row).
//
// dates: the backend stores real dates and returns them as ISO strings.
// a datetime we sent parses as local time; compare instants within a
// minute. a date-only value ("2026-11-18") compares by calendar day.
// numbers compare float-tolerant; everything else compares as strings.
// loose mode (a period merge or an idempotent replay): the landed row may
// hold MORE than we sent (merged notes, an older flow), so each sent
// non-empty string just has to be contained in what landed.
function sameDate(sent, got) {
  if (sent == null || got == null) return sent === got;
  const s = String(sent), g = String(got);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(g);
    if (isNaN(d.getTime())) return false;
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) === s;
  }
  const sd = new Date(s), gd = new Date(g);
  if (isNaN(sd.getTime()) || isNaN(gd.getTime())) return s === g;
  return Math.abs(sd.getTime() - gd.getTime()) < 60000;
}

function sameValue(sent, got, loose) {
  if (sent === "" || sent == null) return true; // nothing sent, nothing to check
  if (got == null) return false;
  const sn = Number(sent), gn = Number(got);
  if (!isNaN(sn) && !isNaN(gn) && String(sent).trim() !== "" && String(got).trim() !== "") {
    return Math.abs(sn - gn) < 1e-9;
  }
  const s = String(sent), g = String(got);
  return loose ? g.indexOf(s) !== -1 : s === g;
}

function verifyAppend(sent, returned, loose) {
  if (!returned || !Array.isArray(returned)) return false;
  for (let i = 0; i < sent.length; i++) {
    const ok = i === 0
      ? sameDate(sent[0], returned[0])
      : sameValue(sent[i], returned[i], loose);
    if (!ok) return false;
  }
  return true;
}

// ---------- journal + sync ----------

// log one row. the entry is saved locally first and shows in the today
// list immediately; the send runs right after. resolves with the backend
// response {row, tab, values} on success; throws Error("queued") when the
// send failed but the entry is saved locally, Error("not-signed-in") when
// there's no usable token (the entry is still saved first — nothing is
// ever dropped), or Error("not-configured") when no backend url exists
// anywhere yet (the entry is still saved first).
async function logEntry(tab, values, label) {
  const entry = {
    id: newEntryId(),
    tab: tab,
    values: values,
    label: label || tab,
    createdAt: new Date().toISOString(),
  };
  const q = loadQueue();
  q.push(entry);
  saveQueue(q);
  if (typeof loadToday === "function") loadToday(); // immediate render
  if (!isConfigured()) throw new Error("not-configured");
  if (!isSignedIn()) throw new Error("not-signed-in");
  try {
    const res = await sendEntry(entry);
    removeFromQueue(entry.id);
    return res;
  } catch (err) {
    if (err.message === "not-signed-in") throw err;
    throw new Error("queued");
  }
}

function removeFromQueue(id) {
  const q = loadQueue().filter(function (item) { return item.id !== id; });
  saveQueue(q);
}

// one send attempt for one journal entry. throws on any failure —
// network, auth, or a verification mismatch — so the caller can leave
// the entry queued for a retry.
async function sendEntry(entry) {
  const res = await postToBackend({
    action: "append",
    tab: entry.tab,
    values: [entry.values],
    entryId: entry.id,
  });
  if (!res || typeof res.row !== "number") throw new Error("bad append response");
  const loose = !!(res.merged || res.duplicate);
  // the old backend (before the redeploy) returns {row} with no values —
  // accept the row number as success. the new backend always returns
  // values, so verification still applies whenever it's live. without
  // this, entries sent during the deploy window would stay queued and
  // double-write after the redeploy (the old backend never logged the
  // entry id, so the new backend's sync log can't catch the retry).
  if (res.values !== undefined && !verifyAppend(entry.values, res.values, loose)) throw new Error("verify-failed");
  return res;
}

// send queued entries, oldest first, one at a time. stops at the first
// failure so order is preserved and we don't hammer a dead connection.
// a stale token is refreshed inside postToBackend, so the flush just
// works; if there's no token (or the refresh fails) the entries stay
// queued until she signs in again. entries without an id (from a queue
// written before uuids) get one before their first send.
async function flushQueue() {
  if (!isConfigured() || !isSignedIn()) return;
  let q = loadQueue();
  let sent = 0;
  while (q.length > 0) {
    const item = q[0];
    if (!item.id) {
      item.id = newEntryId();
      saveQueue(q);
    }
    try {
      await sendEntry(item);
      q = q.slice(1);
      saveQueue(q);
      sent++;
    } catch (err) {
      break;
    }
  }
  if (sent > 0 && typeof toast === "function") {
    toast("synced " + sent + " queued entry" + (sent === 1 ? "" : "ies") + " :)");
    if (typeof loadToday === "function") loadToday();
  }
}

// today's rows for one tab, as [{row, values}]. values[0] comes back as an
// ISO string when the cell holds a date.
async function fetchToday(tab) {
  if (!isConfigured() || !isSignedIn()) return [];
  const data = await postToBackend({ action: "today", tab: tab });
  return (data && data.rows) || [];
}

// dashboard bundle: recent rows for every tab, in one round trip.
// {days, fetchedAt, tabs: {"Mood Log": [[...]], ...}} — dates come back
// as ISO strings, same as fetchToday.
async function fetchDashboard(days) {
  if (!isConfigured()) throw new Error("not-configured");
  if (!isSignedIn()) throw new Error("not-signed-in");
  return await postToBackend({ action: "dashboard", days: days || 45 });
}

// auto-flush: when the connection comes back, when the app is foregrounded
// again, and when another tab changes the queue (same device, two tabs).
window.addEventListener("online", flushQueue);
document.addEventListener("visibilitychange", function () {
  if (!document.hidden) flushQueue();
});
window.addEventListener("storage", function (e) {
  if (e.key !== QUEUE_KEY) return;
  if (typeof updateQueueIndicator === "function") updateQueueIndicator();
  if (typeof loadToday === "function") loadToday();
});
