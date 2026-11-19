/**
 * cuida. backend — Google Apps Script web app.
 *
 * paste this whole file into a new Apps Script project at script.google.com,
 * then Deploy -> New deployment -> Web app:
 *   - execute as: Me
 *   - who has access: Anyone
 * the app already knows the web app url (js/config.js, with the copy saved
 * on each device from the first setup as a fallback) — nobody has to paste
 * it anywhere anymore.
 *
 * auth: every POST must carry a google id token in the request body
 * (id_token), from signing in with google in the app. the token is
 * verified here against CLIENT_ID and ALLOWED_EMAILS below before any
 * action runs. the GET health check stays open — it returns no data.
 *
 * also set the script timezone to America/Chicago (project settings, gear
 * icon) so "today" and the datetimes match the sheet.
 *
 * API:
 *   GET  -> {status:"ok", app:"cuida.", time} (health check, no token)
 *   POST {action:"append", tab:"Mood Log", values:[[ ... ]],
 *         entryId:"...", id_token:"..."}
 *        -> {row: N, tab, values:[ ... ]} — appends one row, returns the
 *           row it landed on and the values as written (the client
 *           verifies what it sent against what landed). entryId is the
 *           client-generated uuid for the entry: if it was already
 *           logged, the existing row is returned instead of appending a
 *           second one ({duplicate:true}). period rows for a date that
 *           already has one are merged, not duplicated ({merged:true}).
 *   POST {action:"today", tab:"Mood Log", id_token:"..."}
 *        -> {tab, rows:[{row, values}]} — today's rows, for the history list
 *   POST {action:"dashboard", days:45, id_token:"..."}
 *        -> {days, fetchedAt, tabs: {"Mood Log": [[...]], ...}} — recent
 *           rows for every tab the dashboard needs, in one round trip.
 *           dates serialize as ISO strings. Period Log always returns its
 *           last 90 rows (cycle math needs more than the day window).
 *   any POST without a valid token -> {error:"invalid token"}
 *
 * idempotency: every append is recorded in a "Sync Log" tab
 * ([entry id, tab, row, timestamp]), created automatically on first use.
 * a retry after a lost response finds its id there and returns the row it
 * already landed on — no duplicate rows, ever.
 *
 * concurrency: appends run under a script lock, so two users appending at
 * the same moment can't compute the same next row and overwrite each other.
 */

var SHEET_ID = "1N-7mGhUGKBb5OjkgBHWlhDWnDROJdwAMzYCSbVOqAC8";

// google sign-in: fill these in after creating the oauth client in google
// cloud console (see README, "google sign-in setup"). CLIENT_ID must match
// js/config.js. the client id is public, so the email check is what
// actually proves the caller — aud alone would let any google account with
// a token for this client id through.
//
// ALLOWED_EMAILS: every google account allowed to log to this sheet.
// first entry is my account, second is my mom's. replace both placeholders
// with the real addresses before deploying.
var CLIENT_ID = "43395920458-7fd4n8b3afm1h6d0rnopq3pd7scid02a.apps.googleusercontent.com";
var ALLOWED_EMAILS = [
  "example1@gmail.com",  // me (lauren)
  "example2@gmail.com"   // mom
];

var TABS = ["Mood Log", "Pain Log", "Food Log", "Vitals", "Sleep Log", "Period Log", "Bathroom Log", "Meds Log"];
var SYNC_LOG_TAB = "Sync Log";

// headers for tabs the backend creates itself when they're missing. the
// original six tabs already exist in the sheet and are never auto-created.
var TAB_HEADERS = {
  "Bathroom Log": ["Date/Time", "Urine color", "Stool color", "Bristol stool type", "Blood", "Notes"],
  "Meds Log": ["Date/Time", "Meds taken", "Notes"]
};

function doGet() {
  return jsonOut({ status: "ok", app: "cuida.", time: new Date().toISOString() });
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    if (!validToken_(req.id_token)) return jsonOut({ error: "invalid token" });
    if (req.action === "append") return jsonOut(append_(req));
    if (req.action === "today") return jsonOut(today_(req));
    if (req.action === "dashboard") return jsonOut(dashboard_(req));
    return jsonOut({ error: "unknown action: " + req.action });
  } catch (err) {
    return jsonOut({ error: String(err) });
  }
}

// Verify a google id token with google's tokeninfo endpoint. true only
// when the token is real, was issued for this app (aud), belongs to one of
// the allowed accounts (email), and the email is verified. tokeninfo
// itself rejects expired tokens, so expiry is covered by the 200 check.
function validToken_(token) {
  if (!token) return false;
  try {
    var res = UrlFetchApp.fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) return false;
    var info = JSON.parse(res.getContentText());
    return info.aud === CLIENT_ID &&
      ALLOWED_EMAILS.indexOf(info.email) !== -1 &&
      info.email_verified === "true";
  } catch (e) {
    return false;
  }
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sheet_(tab) {
  if (TABS.indexOf(tab) === -1) throw new Error("unknown tab: " + tab);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(tab);
  if (!sh) {
    // bathroom + meds are new tabs — create them with headers on first use.
    if (!TAB_HEADERS[tab]) throw new Error("tab not found: " + tab);
    sh = ss.insertSheet(tab);
    sh.getRange(1, 1, 1, TAB_HEADERS[tab].length).setValues([TAB_HEADERS[tab]]);
  }
  return sh;
}

// Last row with anything in column A. We CANNOT use appendRow() or
// getLastRow() here: helper/formula columns (Mood Log I-M, Pain Log K-L) are
// prefilled hundreds of rows down, so the sheet's "last row" is way past the
// real data. Column A only ever holds real entries, so it is the anchor.
function lastDataRow_(sh) {
  var vals = sh.getRange(1, 1, sh.getMaxRows(), 1).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    var v = vals[i][0];
    if (v !== "" && v !== null && v !== undefined) return i + 1;
  }
  return 0;
}

// Turn an ISO-ish datetime string into a real Date so the sheet stores a
// datetime value (the Mood Log date formula needs a real date, not text).
// Date-only strings ("2026-11-11") are built from parts so they land on
// local midnight — new Date("2026-11-11") would parse as UTC midnight and
// show up as the previous evening in Chicago time.
function toDate_(v) {
  if (typeof v !== "string" || v === "") return v;
  var m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  var d = new Date(v);
  return isNaN(d.getTime()) ? v : d;
}

// ---------- sync log (idempotency) ----------

function syncSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(SYNC_LOG_TAB);
  if (!sh) {
    sh = ss.insertSheet(SYNC_LOG_TAB);
    sh.getRange(1, 1, 1, 4).setValues([["Entry ID", "Tab", "Row", "Timestamp"]]);
  }
  return sh;
}

function findSyncEntry_(entryId) {
  var sh = syncSheet_();
  var last = lastDataRow_(sh);
  if (last < 2) return null;
  var ids = sh.getRange(2, 1, last - 1, 3).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === entryId) return { tab: ids[i][1], row: ids[i][2] };
  }
  return null;
}

function logSyncEntry_(entryId, tab, row) {
  var sh = syncSheet_();
  var r = lastDataRow_(sh) + 1;
  sh.getRange(r, 1, 1, 4).setValues([[entryId, tab, row, new Date()]]);
}

// Read back what a row holds, in the shape the client sent it: period rows
// come back as [date, flow, symptoms, notes] (columns A-C + E), every
// other tab as the first `len` columns.
function readRowValues_(sh, tab, row, len) {
  if (tab === "Period Log") {
    var a = sh.getRange(row, 1, 1, 3).getValues()[0];
    var e = sh.getRange(row, 5, 1, 1).getValues()[0][0];
    return [a[0], a[1], a[2], e];
  }
  return sh.getRange(row, 1, 1, len).getValues()[0];
}

// ---------- period merge ----------

// Row numbers in Period Log whose date matches `dateStr` ("yyyy-MM-dd").
function findPeriodRows_(sh, dateStr, tz) {
  var last = lastDataRow_(sh);
  var matches = [];
  if (last < 2) return matches;
  var data = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < data.length; i++) {
    if (dayStr_(data[i][0], tz) === dateStr) matches.push(i + 2);
  }
  return matches;
}

function unionCsv_(a, b) {
  var seen = {};
  var out = [];
  [a, b].forEach(function (s) {
    String(s || "").split(",").forEach(function (part) {
      var t = part.trim();
      if (t && !seen[t]) { seen[t] = true; out.push(t); }
    });
  });
  return out.join(", ");
}

function unionLines_(a, b) {
  var seen = {};
  var out = [];
  [a, b].forEach(function (s) {
    String(s || "").split("\n").forEach(function (line) {
      var t = line.trim();
      if (t && !seen[t]) { seen[t] = true; out.push(t); }
    });
  });
  return out.join("\n");
}

// Merge a new period entry into the existing row for its date: a sent flow
// replaces the old one, symptoms union, notes dedup by line. Writes around
// the prefilled D/F formulas, same as a fresh append. Returns the merged
// values in client shape [date, flow, symptoms, notes].
function mergePeriodRow_(sh, row, values) {
  var cur = sh.getRange(row, 1, 1, 3).getValues()[0];
  var curNotes = sh.getRange(row, 5, 1, 1).getValues()[0][0];
  var flow = (values[1] || "") !== "" ? values[1] : cur[1];
  var symptoms = unionCsv_(cur[2], values[2]);
  var notes = unionLines_(curNotes, values[3]);
  sh.getRange(row, 1, 1, 3).setValues([[cur[0], flow || "", symptoms]]);
  sh.getRange(row, 5, 1, 1).setValues([[notes]]);
  return [cur[0], flow || "", symptoms, notes];
}

// ---------- append ----------

// Appends run under a script lock: two users appending at the same moment
// would otherwise both read the same last row and overwrite each other.
function append_(req) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return appendLocked_(req);
  } finally {
    lock.releaseLock();
  }
}

function appendLocked_(req) {
  var sh = sheet_(req.tab);
  var rows = req.values || [];
  if (!rows.length || !rows[0].length) throw new Error("no values");
  var values = rows[0].slice();
  var entryId = req.entryId || "";

  // idempotency first: this entry already landed, so hand back its row
  // instead of appending a second one.
  if (entryId) {
    var existing = findSyncEntry_(entryId);
    if (existing) {
      var esh = sheet_(existing.tab);
      return {
        row: existing.row,
        tab: existing.tab,
        duplicate: true,
        values: readRowValues_(esh, existing.tab, existing.row, values.length)
      };
    }
  }

  // period: one row per date. merge into the existing row when there is one.
  if (req.tab === "Period Log") {
    var tz = Session.getScriptTimeZone();
    var dateStr = dayStr_(toDate_(values[0]), tz);
    var matches = findPeriodRows_(sh, dateStr, tz);
    if (matches.length > 1) throw new Error("multiple period rows for " + dateStr);
    if (matches.length === 1) {
      var merged = mergePeriodRow_(sh, matches[0], values);
      if (entryId) logSyncEntry_(entryId, req.tab, matches[0]);
      return { row: matches[0], tab: req.tab, merged: true, values: merged };
    }
  }

  var row = lastDataRow_(sh) + 1;
  values[0] = toDate_(values[0]);
  if (req.tab === "Period Log") {
    // D (cycle day) + F (cycle start?) hold prefilled formulas — write
    // around them. frontend sends [date, flow, symptoms, notes].
    sh.getRange(row, 1, 1, 3).setValues([[values[0], values[1] || "", values[2] || ""]]);
    sh.getRange(row, 5, 1, 1).setValues([[values[3] || ""]]);
    if (entryId) logSyncEntry_(entryId, req.tab, row);
    return { row: row, tab: req.tab, values: [values[0], values[1] || "", values[2] || "", values[3] || ""] };
  }
  sh.getRange(row, 1, 1, values.length).setValues([values]);
  if (req.tab === "Mood Log") {
    // score + date formulas for the row the entry actually landed on.
    sh.getRange(row, 9, 1, 2).setFormulas([[
      '=IF(B' + row + '="","",MATCH(B' + row + ',Lists!$E$3:$E$7,0)-1)',
      '=IF(A' + row + '="","",INT(A' + row + '))'
    ]]);
  }
  if (entryId) logSyncEntry_(entryId, req.tab, row);
  return { row: row, tab: req.tab, values: values };
}

function today_(req) {
  var sh = sheet_(req.tab);
  var tz = Session.getScriptTimeZone();
  var todayStr = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  var last = lastDataRow_(sh);
  if (last < 2) return { tab: req.tab, rows: [] };
  var data = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  var rows = [];
  for (var i = 0; i < data.length; i++) {
    var d = data[i][0];
    var day = null;
    if (d instanceof Date) {
      day = Utilities.formatDate(d, tz, "yyyy-MM-dd");
    } else if (typeof d === "string" && d !== "") {
      // tolerate older text dates: compare the parsed date part
      var parsed = new Date(d);
      if (!isNaN(parsed.getTime())) day = Utilities.formatDate(parsed, tz, "yyyy-MM-dd");
    }
    if (day !== todayStr) continue;
    rows.push({ row: i + 2, values: data[i] });
  }
  return { tab: req.tab, rows: rows };
}

var DASH_TABS = ["Mood Log", "Pain Log", "Food Log", "Vitals", "Sleep Log", "Period Log", "Stress Log", "Meds Log"];

// One bundle for the dashboard tab: recent rows for every tab it needs.
// All math happens client-side; this just ships the rows. Dates come back
// as ISO strings (JSON.stringify on a Date). Period Log returns its last
// 90 rows regardless of the day window — cycle math needs the last START,
// which can be further back than the window.
function dashboard_(req) {
  var days = req.days || 14;
  if (days < 1) days = 1;
  if (days > 90) days = 90;
  var tz = Session.getScriptTimeZone();
  var now = new Date();
  var cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  var cutoffStr = Utilities.formatDate(cutoff, tz, "yyyy-MM-dd");
  var out = {};
  DASH_TABS.forEach(function (tab) {
    var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(tab);
    if (!sh) { out[tab] = []; return; }
    var last = lastDataRow_(sh);
    if (last < 2) { out[tab] = []; return; }
    var data = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
    var rows = [];
    for (var i = 0; i < data.length; i++) {
      if (tab === "Period Log") {
        rows.push(data[i]);
        continue;
      }
      var day = dayStr_(data[i][0], tz);
      if (day && day >= cutoffStr) rows.push(data[i]);
    }
    if (tab === "Period Log" && rows.length > 90) rows = rows.slice(rows.length - 90);
    out[tab] = rows;
  });
  return { days: days, fetchedAt: new Date().toISOString(), tabs: out };
}

// A cell value -> "yyyy-MM-dd" in the script timezone, or null.
function dayStr_(d, tz) {
  if (d instanceof Date) return Utilities.formatDate(d, tz, "yyyy-MM-dd");
  if (typeof d === "string" && d !== "") {
    var parsed = new Date(d);
    if (!isNaN(parsed.getTime())) return Utilities.formatDate(parsed, tz, "yyyy-MM-dd");
  }
  return null;
}
