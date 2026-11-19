// config.js — public config for cuida.
//
// CLIENT_ID is the google oauth client id for this app (a "web
// application" client in google cloud console). client ids are public by
// design — this one is safe to ship in the repo. it does NOT grant access
// by itself: the backend (backend/Code.gs) checks every request's token
// against this same client id AND an allowed google account email, so the
// id alone gets nobody in.
//
// APPS_SCRIPT_URL is the web app url of the deployed backend. it is an
// address, not a secret — the token check is the gate, so the url alone
// gets nobody in. fill it in once the backend is deployed (it's shown
// read-only in the app's settings on any device that already has it
// saved). until then, devices that saved the url during the first setup
// keep using their saved copy.
//
// fill both in after creating the oauth client (see README, "google
// sign-in setup"). until CLIENT_ID is set, the sign-in button won't work.
var HEALTHLOG_CONFIG = {
  CLIENT_ID: "43395920458-7fd4n8b3afm1h6d0rnopq3pd7scid02a.apps.googleusercontent.com",
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbxInrHwLueWoPs4gs7kcDnMYl-hxW5OFgCID918R72D3Alb4Rt7p18rhaOkWtV8KPbF/exec"
};
