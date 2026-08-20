/**
 * GES Booth Visualizer — v2
 * Run:  node server.js
 * Open: http://localhost:3001
 *
 * Azure App Service: set PORT env var; app binds to all interfaces automatically.
 */
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// Load .env file if present
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq > 0) process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  });
} catch(e) {}

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD;
if (!APP_PASSWORD) { console.error('FATAL: APP_PASSWORD env var is not set'); process.exit(1); }

// ─── Session store (in-memory, token → expiry ms) ──────────────────────────
const sessions = new Map();
function createSession() {
  const token = require('crypto').randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + 86400_000);
  return token;
}
function parseCookies(req) {
  const list = {};
  (req.headers.cookie || '').split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > 0) list[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return list;
}
function isAuthenticated(req) {
  const token = parseCookies(req).ges_session;
  const expiry = sessions.get(token);
  return expiry && expiry > Date.now();
}

// ─── Rate limiter — max 20 API requests per IP per minute ──────────────────
const rateLimits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now - entry.ts > 60_000) { entry = { ts: now, count: 0 }; rateLimits.set(ip, entry); }
  entry.count++;
  return entry.count > 20;
}

// ─── HTTPS helpers ─────────────────────────────────────────────────────────────

function httpsPost(hostname, urlPath, headers, body, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, res => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location && redirects < 5) {
        const loc = new URL(res.headers.location, 'https://' + hostname);
        res.resume();
        console.log('  Redirect', res.statusCode, '->', loc.href);
        httpsPost(loc.hostname, loc.pathname + loc.search, headers, body, redirects + 1).then(resolve).catch(reject);
        return;
      }
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { reject(new Error('API returned non-JSON (status ' + res.statusCode + '): ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(hostname, urlPath, headers, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: urlPath, method: 'GET', headers
    }, res => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location && redirects < 5) {
        const loc = new URL(res.headers.location, 'https://' + hostname);
        res.resume();
        console.log('  Redirect', res.statusCode, '->', loc.href);
        httpsGet(loc.hostname, loc.pathname + loc.search, headers, redirects + 1).then(resolve).catch(reject);
        return;
      }
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { reject(new Error('API returned non-JSON (status ' + res.statusCode + '): ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function stabilityPost(apiKey, prompt, negativePrompt) {
  return new Promise((resolve, reject) => {
    const sanitize = s => s.replace(/\r\n|\r|\n/g, ' ');
    prompt = sanitize(prompt);
    if (negativePrompt) negativePrompt = sanitize(negativePrompt);
    const boundary = 'GESBoundary' + Date.now().toString(16);
    const parts = [
      '--' + boundary + '\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n' + prompt + '\r\n',
      '--' + boundary + '\r\nContent-Disposition: form-data; name="aspect_ratio"\r\n\r\n16:9\r\n',
      '--' + boundary + '\r\nContent-Disposition: form-data; name="output_format"\r\n\r\njpeg\r\n',
    ];
    if (negativePrompt) parts.push(
      '--' + boundary + '\r\nContent-Disposition: form-data; name="negative_prompt"\r\n\r\n' + negativePrompt + '\r\n'
    );
    parts.push('--' + boundary + '--\r\n');
    const body = Buffer.from(parts.join(''));
    const req = https.request({
      hostname: 'api.stability.ai',
      path: '/v2beta/stable-image/generate/ultra',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Accept': 'application/json',
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length
      }
    }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { reject(new Error('Stability AI returned non-JSON (status ' + res.statusCode + '): ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}


const ALLOWED_ORIGINS = new Set(['https://hackathon-dv.ges.com', 'http://localhost:3000', 'http://localhost:3001']);
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ─── HTML SPA ──────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>GES Booth Visualizer</title>
<style>
:root {
  /* GES brand */
  --ges-navy:   #114261;
  --ges-blue:   #1E4C69;
  --ges-mid:    #295673;
  /* Transformers energy */
  --orange:     #FF6B00;
  --orange-dim: rgba(255,107,0,.55);
  --gold:       #FFD000;
  /* Surfaces — GES navy-tinted dark */
  --bg:         #162e45;
  --surface:    #1e3a55;
  --surface2:   #224260;
  --border:     rgba(255,107,0,.28);
  --border-ges: rgba(40,110,165,.75);
  --text:       #e8f4fc;
  --text-dim:   rgba(170,210,240,.80);
  --light-text: #ffffff;
  --primary:    #FF6B00;
  --secondary:  #0a1c2e;
  --accent:     #FF8C00;
  --r: 3px;
  --sh:    0 0 20px rgba(255,107,0,.05), 0 2px 10px rgba(0,0,0,.5);
  --sh-md: 0 0 40px rgba(255,107,0,.1),  0 4px 24px rgba(0,0,0,.6);
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: system-ui,-apple-system,'Segoe UI',sans-serif;
  background: var(--bg); color: var(--text);
  min-height: 100vh; display: flex; flex-direction: column; position: relative;
}
body::before {
  content: '';
  position: fixed; inset: 0;
  background-image: linear-gradient(rgba(255,107,0,.04) 1px,transparent 1px),
                    linear-gradient(90deg,rgba(255,107,0,.04) 1px,transparent 1px);
  background-size: 44px 44px; pointer-events: none; z-index: 0;
}
body::after {
  content: ''; position: fixed; top: -1px; left: 0; right: 0; height: 1px;
  background: linear-gradient(90deg,transparent,rgba(255,107,0,.35) 50%,transparent);
  animation: scan 9s linear infinite; pointer-events: none; z-index: 0; opacity: .5;
}
@keyframes scan { from{top:-1px} to{top:100vh} }

/* NAV */
nav {
  background: linear-gradient(90deg, var(--ges-navy) 0%, #1e5280 50%, var(--ges-navy) 100%);
  border-bottom: 1px solid rgba(255,107,0,.22);
  height: 48px; padding: 0 20px;
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0; position: relative; z-index: 10;
  box-shadow: 0 2px 24px rgba(0,0,0,.7);
}
nav::after {
  content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255,107,0,.45) 50%, transparent);
}
.nav-left  { display: flex; align-items: center; gap: 10px; }
.nav-logo  { height: 30px; width: auto; object-fit: contain; filter: brightness(1.1); }
.nav-divider { width: 1px; height: 18px; background: rgba(255,255,255,.15); flex-shrink: 0; }
.nav-title { font-size: 14px; font-weight: 700; color: #e8f3fa; white-space: nowrap; letter-spacing: .5px; }
.nav-badge {
  background: rgba(255,107,0,.12); border: 1px solid rgba(255,107,0,.35);
  color: var(--orange); font-size: 9px; font-weight: 700;
  padding: 2px 8px; border-radius: 2px; text-transform: uppercase; letter-spacing: 1.5px;
  white-space: nowrap; font-family: 'Courier New',monospace;
}
.nav-right { display: flex; align-items: center; }
.nav-tagline { font-size: 10px; color: rgba(255,255,255,.3); font-style: italic; white-space: nowrap; }

/* APP BODY */
.app-body { display: grid; grid-template-columns: 290px 1fr; flex: 1; min-height: 0; overflow: hidden; position: relative; z-index: 1; }

/* LEFT PANEL */
.left-panel { background: linear-gradient(180deg, #1a3450 0%, #172f48 100%); border-right: 1px solid rgba(40,110,165,.6); display: flex; flex-direction: column; overflow-y: auto; }
.form-section { padding: 8px 12px; border-bottom: 1px solid rgba(30,90,140,.4); }
.section-label {
  font-size: 8px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase;
  color: rgba(180,215,240,.88); margin-bottom: 5px;
  display: flex; align-items: center; gap: 5px;
}
.section-label::before { content: '▶'; font-size: 6px; color: var(--orange); opacity: .6; }
.field { display: flex; flex-direction: column; gap: 2px; margin-bottom: 5px; }
.field:last-child { margin-bottom: 0; }
.field label { font-size: 10px; font-weight: 600; color: rgba(185,218,245,.90); }
.field input, .field select, .field textarea {
  width: 100%; padding: 5px 8px;
  border: 1px solid rgba(255,107,0,.16); border-radius: var(--r);
  font-size: 11px; font-family: inherit; color: var(--text);
  background: rgba(0,0,0,.28); outline: none; transition: border-color .2s, box-shadow .2s;
}
.field input:focus, .field select:focus, .field textarea:focus {
  border-color: rgba(255,107,0,.5); box-shadow: 0 0 10px rgba(255,107,0,.08);
}
.field select option { background: #102234; color: var(--text); }
.field input::placeholder, .field textarea::placeholder { color: rgba(120,165,205,.45); }
.field textarea { resize: vertical; line-height: 1.5; min-height: 65px; }
.two-col-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-bottom: 5px; }
.two-col-fields .field { margin-bottom: 0; }

/* CHIPS */
.chip-group { display: flex; flex-wrap: wrap; gap: 4px; }
.chip {
  padding: 3px 9px; border: 1px solid rgba(255,107,0,.2); border-radius: 2px;
  font-size: 10px; font-weight: 500; color: rgba(180,215,242,.80);
  cursor: pointer; transition: all .15s; background: transparent; user-select: none;
}
.chip:hover { border-color: rgba(255,107,0,.5); color: var(--orange); }
.chip.active { background: rgba(255,107,0,.1); border-color: var(--orange); color: var(--orange); box-shadow: 0 0 8px rgba(255,107,0,.15); }

/* UPLOAD ZONES */
.upload-zone {
  border: 1px dashed rgba(255,107,0,.22); border-radius: var(--r); padding: 7px 10px;
  display: flex; align-items: center; gap: 8px;
  cursor: pointer; transition: all .2s; background: rgba(0,0,0,.2); position: relative;
}
.upload-zone input[type=file] { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
.upload-zone:hover, .upload-zone.dragover { border-color: var(--orange); background: rgba(255,107,0,.04); }
.upload-icon { font-size: 18px; flex-shrink: 0; }
.upload-title { font-size: 11px; font-weight: 600; color: rgba(200,225,248,.78); }
.upload-hint  { font-size: 10px; color: rgba(150,185,220,.5); }
.preview-wrap { position: relative; border-radius: var(--r); overflow: hidden; border: 1px solid rgba(255,107,0,.2); }
.preview-wrap img { width: 100%; max-height: 80px; object-fit: cover; display: block; }
.preview-remove { position: absolute; top: 4px; right: 4px; background: rgba(0,0,0,.75); color: var(--orange); border: 1px solid rgba(255,107,0,.35); border-radius: 50%; width: 20px; height: 20px; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center; }

/* GENERATE BUTTON */
.gen-btn {
  margin: 8px 12px 10px; padding: 10px;
  background: transparent; border: 1px solid rgba(255,107,0,.45); border-radius: var(--r);
  color: var(--orange); font-size: 10px; font-weight: 700;
  cursor: pointer; transition: all .25s;
  letter-spacing: 4px; text-transform: uppercase; font-family: 'Courier New',monospace;
  position: relative; overflow: hidden;
}
.gen-btn::after { content: ''; position: absolute; inset: 0; background: rgba(255,107,0,0); transition: background .2s; }
.gen-btn:hover:not(:disabled) { border-color: var(--orange); box-shadow: 0 0 28px rgba(255,107,0,.25); letter-spacing: 5px; }
.gen-btn:hover:not(:disabled)::after { background: rgba(255,107,0,.08); }
.gen-btn:disabled { opacity: .3; cursor: not-allowed; letter-spacing: 4px; }

/* RIGHT PANEL */
.right-panel { display: flex; flex-direction: column; overflow: hidden; background: rgba(18,36,56,.7); }
#results-area { flex: 1; overflow: hidden; display: flex; flex-direction: column; }

/* EMPTY STATE */
#empty-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; text-align: center; }
.empty-card {
  background: rgba(20,36,56,.92); border: 1px solid rgba(255,107,0,.28); border-radius: 4px;
  padding: 30px 36px; max-width: 430px; width: 100%;
  box-shadow: 0 0 50px rgba(255,107,0,.06), 0 4px 30px rgba(0,0,0,.6); position: relative;
}
.empty-card::before,.empty-card::after { content:''; position:absolute; width:12px; height:12px; border-color:rgba(255,107,0,.4); border-style:solid; }
.empty-card::before { top:-1px; left:-1px; border-width:2px 0 0 2px; }
.empty-card::after  { bottom:-1px; right:-1px; border-width:0 2px 2px 0; }
.empty-icon  { font-size: 36px; margin-bottom: 10px; filter: drop-shadow(0 0 10px rgba(255,107,0,.35)); }
.empty-title { font-size: 17px; font-weight: 800; color: var(--orange); margin-bottom: 6px; letter-spacing: 1px; text-shadow: 0 0 20px rgba(255,107,0,.3); }
.empty-desc  { color: var(--text-dim); font-size: 11px; line-height: 1.65; max-width: 300px; margin: 0 auto 14px; }
.empty-hint  {
  font-size: 9px; color: var(--orange-dim);
  background: rgba(255,107,0,.06); border: 1px solid rgba(255,107,0,.2);
  padding: 5px 14px; border-radius: 2px; display: inline-block; margin-bottom: 18px;
  letter-spacing: 2px; font-family: 'Courier New',monospace; text-transform: uppercase;
}
.empty-features { display: grid; grid-template-columns: repeat(4,1fr); gap: 8px; }
.empty-feature { background: rgba(0,0,0,.2); border: 1px solid rgba(255,107,0,.18); border-radius: 2px; padding: 10px 8px; font-size: 10px; color: var(--text-dim); text-align: center; }
.ef-icon { font-size: 18px; margin-bottom: 3px; }

/* RESULTS PANEL */
#results-panel { flex-direction: column; flex: 1; min-height: 0; }
.results-header {
  background: linear-gradient(90deg, #1a3454, #1e3c60); border-bottom: 1px solid rgba(255,107,0,.28);
  padding: 9px 16px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-shrink: 0;
}
.results-title { font-size: 13px; font-weight: 700; color: var(--text); letter-spacing: .3px; }
.results-sub   { font-size: 10px; color: var(--orange-dim); margin-top: 1px; font-family: 'Courier New',monospace; opacity: .6; }
.results-actions { display: flex; gap: 7px; flex-shrink: 0; }
.btn-outline { padding: 5px 11px; border: 1px solid rgba(255,107,0,.25); border-radius: var(--r); background: transparent; font-size: 10px; font-weight: 600; color: rgba(255,107,0,.55); cursor: pointer; transition: all .15s; white-space: nowrap; }
.btn-outline:hover { border-color: var(--orange); color: var(--orange); }
.btn-primary { padding: 5px 11px; border: 1px solid var(--orange); border-radius: var(--r); background: rgba(255,107,0,.1); color: var(--orange); font-size: 10px; font-weight: 700; cursor: pointer; transition: all .2s; white-space: nowrap; }
.btn-primary:hover { background: rgba(255,107,0,.18); box-shadow: 0 0 12px rgba(255,107,0,.2); }
.render-section { padding: 10px 12px; flex-shrink: 0; }

/* TABS */
.tab-bar { display: flex; background: rgba(6,14,22,.9); border-bottom: 1px solid rgba(17,66,97,.4); padding: 0 12px; flex-shrink: 0; }
.tab-btn { padding: 9px 14px; background: transparent; border: none; border-bottom: 2px solid transparent; color: rgba(140,180,220,.35); font-size: 10px; font-weight: 700; cursor: pointer; letter-spacing: 1.5px; text-transform: uppercase; transition: all .2s; margin-bottom: -1px; font-family: inherit; white-space: nowrap; }
.tab-btn:hover { color: rgba(255,107,0,.6); }
.tab-btn.active { color: var(--orange); border-bottom-color: var(--orange); }
.tab-content { flex: 1; overflow: hidden; position: relative; }
.tab-pane { display: none; height: 100%; overflow-y: auto; padding: 12px; flex-direction: column; gap: 8px; }
.tab-pane.active { display: flex; }

/* RENDER CARD */
.render-card { background: rgba(7,18,30,.92); border: 1px solid rgba(17,66,97,.5); border-radius: var(--r); overflow: hidden; box-shadow: var(--sh); }
.render-card-header { background: linear-gradient(90deg, var(--ges-navy), #0e3350); border-bottom: 1px solid rgba(255,107,0,.2); padding: 8px 14px; display: flex; align-items: center; justify-content: space-between; }
.render-card-header > span { font-size: 10px; font-weight: 700; letter-spacing: 2px; color: var(--orange); text-transform: uppercase; }
.flux-badge { font-size: 9px; color: rgba(255,107,0,.45); font-weight: 600; display: flex; align-items: center; gap: 5px; letter-spacing: 1px; font-family: 'Courier New',monospace; }
.flux-badge::before { content:''; width:5px; height:5px; background:var(--orange); border-radius:50%; animation:blink 2s infinite; }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:.2} }
.render-card-body { padding: 12px 14px; }
.rerender-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: rgba(255,200,0,.04); border: 1px solid rgba(255,200,0,.18); border-radius: var(--r); padding: 6px 10px; margin-bottom: 10px; font-size: 11px; color: rgba(255,210,0,.6); }
.btn-sm { padding: 3px 9px; border: 1px solid rgba(255,200,0,.25); border-radius: 2px; background: transparent; font-size: 10px; font-weight: 600; color: rgba(255,210,0,.6); cursor: pointer; white-space: nowrap; }
.render-idle-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.btn-render { padding: 8px 18px; background: transparent; border: 1px solid rgba(255,107,0,.45); border-radius: var(--r); color: var(--orange); font-size: 10px; font-weight: 700; cursor: pointer; transition: all .2s; letter-spacing: 2.5px; text-transform: uppercase; font-family: 'Courier New',monospace; }
.btn-render:hover:not(:disabled) { border-color: var(--orange); box-shadow: 0 0 18px rgba(255,107,0,.2); }
.btn-render:disabled { opacity: .3; cursor: not-allowed; }
.render-hint { font-size: 10px; color: var(--text-dim); }
.render-progress { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 11px; color: rgba(255,107,0,.5); }
.render-spinner { width: 16px; height: 16px; border: 2px solid rgba(255,107,0,.12); border-top-color: var(--orange); border-radius: 50%; animation: spin .8s linear infinite; flex-shrink: 0; }
@keyframes spin { to{transform:rotate(360deg)} }
#booth-render { width: 100%; border-radius: var(--r); margin-top: 10px; display: block; border: 1px solid rgba(255,107,0,.15); box-shadow: 0 0 30px rgba(255,107,0,.06); }
.render-actions-row { margin-top: 10px; display: flex; gap: 8px; }
.btn-download { padding: 6px 12px; background: rgba(255,107,0,.1); color: var(--orange); border: 1px solid rgba(255,107,0,.3); border-radius: var(--r); font-size: 11px; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 5px; transition: all .2s; }
.btn-download:hover { background: rgba(255,107,0,.18); box-shadow: 0 0 12px rgba(255,107,0,.18); }
.btn-outline-sm { padding: 5px 10px; border: 1px solid rgba(255,107,0,.18); border-radius: var(--r); background: transparent; font-size: 11px; font-weight: 600; color: rgba(255,107,0,.45); cursor: pointer; }
.render-error { background: rgba(255,50,50,.04); border: 1px solid rgba(255,60,60,.2); border-radius: var(--r); padding: 10px 14px; font-size: 11px; color: rgba(255,100,100,.65); margin-top: 10px; line-height: 1.6; }

/* CARDS */
.two-col-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.card { background: rgba(7,18,30,.92); border: 1px solid rgba(17,66,97,.45); border-radius: var(--r); overflow: hidden; box-shadow: var(--sh); }
.card-header { padding: 7px 12px; border-bottom: 1px solid rgba(17,66,97,.4); display: flex; align-items: center; justify-content: space-between; background: linear-gradient(90deg, rgba(17,66,97,.35), transparent); }
.card-header h3 { font-size: 10px; font-weight: 700; color: var(--orange-dim); letter-spacing: 1.5px; text-transform: uppercase; }
.card-body { padding: 10px 12px; }
.concept-text { font-size: 11px; line-height: 1.75; color: rgba(195,220,240,.65); margin-bottom: 8px; }
.tips-list { list-style: none; padding-top: 8px; border-top: 1px solid rgba(255,107,0,.07); display: flex; flex-direction: column; gap: 5px; }
.tip-item { font-size: 11px; color: rgba(170,205,235,.5); padding-left: 14px; position: relative; line-height: 1.45; }
.tip-item::before { content: '▶'; color: rgba(255,107,0,.4); position: absolute; left: 0; font-size: 7px; top: 3px; }
.fp-body { padding: 8px 10px; }
.fp-body svg { width: 100%; height: auto; display: block; border-radius: 2px; }

/* ORDER LIST */
.item-count-badge { background: rgba(255,107,0,.1); border: 1px solid rgba(255,107,0,.28); color: var(--orange); font-size: 9px; font-weight: 700; padding: 2px 7px; border-radius: 2px; letter-spacing: .5px; }
.order-list  { max-height: 220px; overflow-y: auto; }
.order-item  { display: flex; align-items: flex-start; gap: 8px; padding: 6px 12px; border-bottom: 1px solid rgba(255,107,0,.05); }
.order-item:last-child { border-bottom: none; }
.order-item:hover { background: rgba(255,107,0,.03); }
.oi-icon   { width: 24px; height: 24px; background: rgba(255,107,0,.06); border: 1px solid rgba(255,107,0,.12); border-radius: 2px; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; margin-top: 1px; }
.oi-info   { flex: 1; min-width: 0; }
.oi-name   { font-size: 11px; font-weight: 600; color: rgba(195,220,240,.75); line-height: 1.3; }
.oi-detail { font-size: 10px; color: rgba(140,175,210,.35); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.oi-qty    { font-size: 11px; font-weight: 700; color: var(--orange); white-space: nowrap; padding-top: 2px; flex-shrink: 0; }

/* SUMMARY CARD */
.summary-card { background: rgba(7,18,30,.92); border: 1px solid rgba(17,66,97,.45); border-radius: var(--r); padding: 12px 14px; display: flex; flex-direction: column; gap: 7px; box-shadow: var(--sh); }
.summary-title { font-size: 10px; font-weight: 700; color: var(--orange-dim); letter-spacing: 1.5px; text-transform: uppercase; padding-bottom: 7px; border-bottom: 1px solid rgba(255,107,0,.07); }
.summary-row   { display: flex; justify-content: space-between; font-size: 11px; color: rgba(140,175,210,.4); gap: 8px; align-items: flex-start; }
.summary-row strong { color: rgba(195,220,240,.65); font-weight: 600; text-align: right; }
.cta-btn {
  width: 100%; padding: 10px;
  background: transparent; border: 1px solid var(--orange); border-radius: var(--r);
  color: var(--orange); font-size: 10px; font-weight: 700;
  cursor: pointer; margin-top: 3px; transition: all .2s;
  letter-spacing: 3px; text-transform: uppercase; font-family: 'Courier New',monospace;
  position: relative; overflow: hidden;
}
.cta-btn::after { content:''; position:absolute; inset:0; background:rgba(255,107,0,0); transition:background .2s; }
.cta-btn:hover { box-shadow: 0 0 24px rgba(255,107,0,.25); }
.cta-btn:hover::after { background: rgba(255,107,0,.1); }
.cta-hint { font-size: 9px; color: rgba(140,175,210,.28); text-align: center; }

/* CHAT PANEL */
.chat-panel { border-top: 1px solid rgba(255,107,0,.12); background: rgba(6,10,18,.97); flex-shrink: 0; }
.chat-header { background: linear-gradient(90deg,#080e1a,#0a1220); padding: 7px 14px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,107,0,.1); }
.chat-header > span:first-child { font-size: 10px; font-weight: 700; color: var(--orange-dim); letter-spacing: 2px; text-transform: uppercase; }
.chat-model { font-size: 9px; color: rgba(255,107,0,.28); font-style: italic; }
.chat-history { overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; min-height: 36px; max-height: 155px; }
.chat-bubble { max-width: 85%; padding: 6px 10px; border-radius: 2px; font-size: 11px; line-height: 1.5; word-break: break-word; }
.chat-bubble.user { background: rgba(255,107,0,.1); border: 1px solid rgba(255,107,0,.18); color: rgba(215,235,250,.75); align-self: flex-end; }
.chat-bubble.assistant { background: rgba(0,0,0,.3); border: 1px solid rgba(255,107,0,.08); color: rgba(175,205,230,.6); align-self: flex-start; }
.chat-bubble.thinking { background: rgba(0,0,0,.2); border: 1px solid rgba(255,107,0,.06); color: rgba(140,175,210,.38); align-self: flex-start; font-style: italic; }

/* ── CHAT FAB ──────────────────────────────────────────────── */
#chat-fab { position: fixed; bottom: 24px; right: 24px; z-index: 150; display: none; }
.fab-btn { width: 54px; height: 54px; border-radius: 50%; background: var(--ges-navy); border: 2px solid rgba(255,107,0,.6); color: white; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 24px rgba(255,107,0,.28), 0 4px 16px rgba(0,0,0,.6); transition: all .2s; animation: fabglow 3s ease-in-out infinite; font-size: 22px; }
.fab-btn:hover { transform: scale(1.08); box-shadow: 0 0 38px rgba(255,107,0,.5), 0 6px 20px rgba(0,0,0,.6); }
@keyframes fabglow { 0%,100%{box-shadow:0 0 20px rgba(255,107,0,.2),0 4px 16px rgba(0,0,0,.6)} 50%{box-shadow:0 0 34px rgba(255,107,0,.44),0 4px 16px rgba(0,0,0,.6)} }
.fab-unread { position: absolute; top: -3px; right: -3px; background: var(--orange); border: 2px solid var(--bg); border-radius: 50%; width: 14px; height: 14px; display: none; }

/* ── CHAT POPUP ──────────────────────────────────────────────── */
#chat-popup { position: fixed; bottom: 90px; right: 24px; width: 340px; z-index: 149; background: linear-gradient(160deg, #0a1e32, #071628); border: 1px solid rgba(255,107,0,.28); border-radius: 4px; box-shadow: 0 0 50px rgba(255,107,0,.1), 0 8px 32px rgba(0,0,0,.7); display: none; flex-direction: column; max-height: 440px; }
.popup-header { background: linear-gradient(90deg, var(--ges-navy), #0e3350); padding: 9px 14px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,107,0,.18); border-radius: 4px 4px 0 0; }
.popup-header-title { font-size: 10px; font-weight: 700; color: var(--orange-dim); letter-spacing: 2px; text-transform: uppercase; }
.popup-close-btn { background: none; border: none; color: rgba(255,107,0,.4); cursor: pointer; font-size: 17px; line-height: 1; padding: 0 2px; }
.popup-close-btn:hover { color: var(--orange); }

@media print {
  body { background: #fff !important; }
  * { color: #000 !important; background: transparent !important; box-shadow: none !important; border-color: #ccc !important; }
  .app-nav, .left-panel, .results-header, .tab-bar, .render-card-header .flux-badge,
  .rerender-bar, .render-idle-row, #render-progress, .render-actions-row,
  #render-error, #chat-fab, #chat-popup, .cta-hint { display: none !important; }
  .app-body { display: block !important; }
  .right-panel, #results-area, #results-panel { display: block !important; overflow: visible !important; height: auto !important; }
  .render-section { page-break-inside: avoid; }
  #booth-render { display: block !important; max-width: 100% !important; border: 1px solid #ddd; margin-bottom: 12px; }
  .tab-pane { display: block !important; height: auto !important; overflow: visible !important; page-break-inside: avoid; margin-bottom: 16px; }
  .tab-content { overflow: visible !important; height: auto !important; }
  .order-item { border-bottom: 1px solid #eee; padding: 4px 0; }
  .cta-btn { display: none !important; }
  #print-header { display: block !important; }
}
.chat-input-row { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid rgba(255,107,0,.07); }
.chat-input { flex: 1; padding: 6px 10px; border: 1px solid rgba(255,107,0,.16); border-radius: var(--r); font-size: 11px; font-family: inherit; outline: none; color: var(--text); background: rgba(0,0,0,.4); }
.chat-input:focus { border-color: rgba(255,107,0,.4); }
.chat-input::placeholder { color: rgba(100,140,180,.28); }
.chat-send-btn { padding: 6px 14px; background: rgba(255,107,0,.1); border: 1px solid rgba(255,107,0,.28); border-radius: var(--r); color: var(--orange); font-size: 10px; font-weight: 700; cursor: pointer; transition: all .2s; white-space: nowrap; letter-spacing: 1px; }
.chat-send-btn:hover:not(:disabled) { background: rgba(255,107,0,.18); box-shadow: 0 0 10px rgba(255,107,0,.15); }
.chat-send-btn:disabled { opacity: .28; cursor: not-allowed; }

/* LOADING OVERLAY */
.loading-overlay { position: fixed; inset: 0; background: rgba(4,8,14,.88); z-index: 200; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(3px); }
.loading-box { background: linear-gradient(160deg, #0a1e32, #071628); border: 1px solid rgba(255,107,0,.28); border-radius: 4px; padding: 28px 32px; text-align: center; max-width: 300px; width: 90%; box-shadow: 0 0 60px rgba(255,107,0,.1), 0 0 40px rgba(17,66,97,.3); position: relative; }
.loading-box::before,.loading-box::after { content:''; position:absolute; width:12px; height:12px; border-color:rgba(255,107,0,.45); border-style:solid; }
.loading-box::before { top:-1px; left:-1px; border-width:2px 0 0 2px; }
.loading-box::after  { bottom:-1px; right:-1px; border-width:0 2px 2px 0; }
.loading-logo   { height: 28px; margin-bottom: 16px; filter: brightness(1.2) drop-shadow(0 0 6px rgba(255,107,0,.3)); }
.loading-spinner { width: 32px; height: 32px; border: 2px solid rgba(255,107,0,.1); border-top-color: var(--orange); border-radius: 50%; animation: spin .9s linear infinite; margin: 0 auto 14px; }
.loading-title  { font-size: 11px; font-weight: 700; color: var(--orange); margin-bottom: 4px; letter-spacing: 2.5px; text-transform: uppercase; font-family: 'Courier New',monospace; text-shadow: 0 0 16px rgba(255,107,0,.4); }
.loading-sub    { font-size: 11px; color: rgba(150,185,220,.35); line-height: 1.55; }
.loading-steps  { margin-top: 14px; text-align: left; display: flex; flex-direction: column; gap: 7px; }
.loading-step   { font-size: 11px; color: rgba(140,175,210,.3); letter-spacing: .5px; }
.loading-step.done   { color: #00e676; }
.loading-step.active { color: var(--orange); font-weight: 600; }

/* TOAST */
.toast { position: fixed; top: 58px; left: 50%; transform: translateX(-50%); z-index: 300; padding: 9px 18px; border-radius: var(--r); font-size: 12px; font-weight: 600; max-width: 500px; width: 90%; text-align: center; box-shadow: var(--sh-md); border: 1px solid rgba(255,107,0,.25); background: rgba(8,14,22,.97); color: var(--orange); }

/* FOOTER */
footer { background: rgba(5,9,16,.98); border-top: 1px solid rgba(255,107,0,.1); padding: 6px 20px; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; position: relative; z-index: 1; }
footer p { color: rgba(255,107,0,.18); font-size: 10px; letter-spacing: .5px; }
footer strong { color: rgba(255,107,0,.35); font-weight: 600; }

/* SCROLLBAR */
::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,107,0,.2); border-radius: 2px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,107,0,.4); }
</style>
</head>
<body>

<!-- NAV -->
<nav>
  <div class="nav-left">
    <img src="/logo.webp" class="nav-logo" alt="GES"
         onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
    <span style="display:none;font-weight:800;font-size:18px;color:#F3F4F3;letter-spacing:2px">GES</span>
    <div class="nav-divider"></div>
    <span class="nav-title">Booth Visualizer</span>
    <span class="nav-badge">AI-Powered</span>
  </div>
  <div class="nav-right">
    <span class="nav-tagline">Designed by <strong style="color:var(--light-text);font-weight:600">TradeTech Transformers</strong> &mdash; Modernizing events through AI.</span>
  </div>
</nav>

<!-- APP BODY -->
<div class="app-body">

  <!-- LEFT PANEL -->
  <div class="left-panel">

    <!-- Reference Photo -->
    <div class="form-section">
      <div class="section-label">Reference Photo <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:8px">(optional)</span></div>
      <div class="upload-zone" id="img-zone">
        <input type="file" id="img-file" accept="image/*">
        <div class="upload-icon">&#127963;</div>
        <div>
          <div class="upload-title">Upload booth photo or inspiration</div>
          <div class="upload-hint">JPG, PNG &middot; style &amp; brand cues incorporated</div>
        </div>
      </div>
      <div id="img-preview-wrap" style="display:none">
        <div class="preview-wrap">
          <img id="img-preview" src="" alt="">
          <button class="preview-remove" id="img-remove" title="Remove">&#10005;</button>
        </div>
      </div>
    </div>

    <!-- Booth Details -->
    <div class="form-section">
      <div class="section-label">Booth Details</div>
      <div class="two-col-fields">
        <div class="field">
          <label>Width (ft)</label>
          <input type="number" id="booth-width" placeholder="20" min="1">
        </div>
        <div class="field">
          <label>Depth (ft)</label>
          <input type="number" id="booth-depth" placeholder="20" min="1">
        </div>
      </div>
      <div class="field">
        <label>Show / Event Name</label>
        <input type="text" id="show-name" placeholder="e.g. NAB Show 2026">
      </div>
      <div class="two-col-fields">
        <div class="field">
          <label>Booth Type</label>
          <select id="booth-type">
            <option value="">Select...</option>
            <option>Inline / Linear</option>
            <option>Corner</option>
            <option>Island (open all 4 sides)</option>
            <option>Peninsula (open 3 sides)</option>
            <option>Custom / Split Island</option>
          </select>
        </div>
        <div class="field">
          <label>Booth Number</label>
          <input type="text" id="booth-number" placeholder="e.g. 1245">
        </div>
      </div>
    </div>

    <!-- Exhibitor Profile -->
    <div class="form-section">
      <div class="section-label">Exhibitor Profile</div>
      <div class="field">
        <label>Industry</label>
        <select id="industry">
          <option value="">Select industry...</option>
          <option>Technology</option>
          <option>Healthcare</option>
          <option>Manufacturing</option>
          <option>Automotive</option>
          <option>Education</option>
        </select>
      </div>
      <div class="field">
        <label>Brand Colors</label>
        <input type="text" id="brand-colors" placeholder="e.g. navy blue and gold">
      </div>
    </div>

    <!-- Style / Vibe -->
    <div class="form-section">
      <div class="section-label">Style &amp; Vibe</div>
      <div class="chip-group">
        <div class="chip vibe-chip" data-val="bold and high-impact">Bold &amp; High-Impact</div>
        <div class="chip vibe-chip" data-val="clean and professional">Clean &amp; Professional</div>
        <div class="chip vibe-chip" data-val="warm and inviting">Warm &amp; Inviting</div>
        <div class="chip vibe-chip" data-val="tech-forward and modern">Tech-Forward</div>
        <div class="chip vibe-chip" data-val="luxury and premium">Luxury &amp; Premium</div>
      </div>
    </div>

    <!-- Vision -->
    <div class="form-section" style="flex:1;display:flex;flex-direction:column">
      <div class="section-label">Your Vision</div>
      <div class="field" style="flex:1">
        <textarea id="vision" placeholder="e.g. 20x20 island booth with a large LED video wall, 3 interactive product demo stations, an executive meeting lounge with seating, and a prominent hanging sign. Open and inviting layout with easy traffic flow."></textarea>
      </div>
    </div>

    <button class="gen-btn" id="gen-btn" disabled>&#10022; Generate Booth Concept</button>

  </div><!-- /left-panel -->

  <!-- RIGHT PANEL -->
  <div class="right-panel">
    <div id="results-area">

      <!-- Empty state -->
      <div id="empty-state" style="display:flex">
        <div class="empty-card">
          <div class="empty-icon">&#127959;</div>
          <h2 class="empty-title">Your Booth Awaits</h2>
          <p class="empty-desc">Describe your vision on the left and get a complete booth concept, order list, and AI render instantly.</p>
          <div class="empty-hint">&#10022;&nbsp; Fill in booth details &amp; click Generate</div>
          <div class="empty-features">
            <div class="empty-feature"><div class="ef-icon">&#127775;</div>Concept</div>
            <div class="empty-feature"><div class="ef-icon">&#128230;</div>Orders</div>
            <div class="empty-feature"><div class="ef-icon">&#128248;</div>Render</div>
            <div class="empty-feature"><div class="ef-icon">&#128172;</div>Refine</div>
          </div>
        </div>
      </div>

      <!-- Results -->
      <div id="results-panel" style="display:none;flex-direction:column">

        <!-- Print-only header -->
        <div id="print-header" style="display:none;padding:0 0 12px;border-bottom:2px solid #114261;margin-bottom:12px">
          <img src="/logo.webp" alt="GES" style="height:36px;margin-bottom:6px">
          <div style="font-size:18px;font-weight:700;color:#114261">Booth Concept Proposal</div>
          <div id="print-subtitle" style="font-size:11px;color:#555;margin-top:2px"></div>
        </div>

        <div class="results-header">
          <div>
            <h2 class="results-title">Your Booth Concept</h2>
            <p id="results-subtitle" class="results-sub"></p>
          </div>
          <div class="results-actions">
            <button class="btn-outline" id="reset-btn">Start Over</button>
            <button class="btn-outline" onclick="shareBoothLink()" title="Copy shareable link">&#128279; Share</button>
            <button class="btn-outline" onclick="printBooth()" title="Download / Print PDF">&#128196; PDF</button>
            <button class="btn-primary" onclick="window.open('https://ges.store/','_blank')">Shop GES Store &#8594;</button>
          </div>
        </div>

          <!-- FLUX Render -->
          <div class="render-section">
            <div class="render-card">
              <div class="render-card-header">
                <span>Style &amp; Atmosphere Reference</span>
                <span class="flux-badge">Stable Image Ultra</span>
              </div>
              <div class="render-card-body">
                <div id="rerender-bar" style="display:none" class="rerender-bar">
                  <span>Design updated &mdash; render is from the previous version</span>
                  <button class="btn-sm" onclick="generateImage()">&#128248; Re-render</button>
                </div>
                <div id="render-idle" class="render-idle-row">
                  <button class="btn-render" id="render-btn" onclick="generateImage()" disabled>
                    &#128248; Visualize My Booth
                  </button>
                </div>
                <div id="render-progress" style="display:none" class="render-progress">
                  <div class="render-spinner"></div>
                  <span id="render-status">Submitting to FLUX 1.1 Pro...</span>
                </div>
                <img id="booth-render" src="" alt="Photorealistic booth render" style="display:none">
                <div id="render-actions" style="display:none" class="render-actions-row">
                  <button class="btn-download" id="download-btn" onclick="downloadRender()">&#11015; Download</button>
                  <button class="btn-outline-sm" onclick="generateImage()">&#8635; Regenerate</button>
                </div>
                <div id="render-error" style="display:none" class="render-error"></div>
              </div>
            </div>
          </div>

          <!-- Tab Bar -->
          <div class="tab-bar">
            <button class="tab-btn active" data-tab="concept" onclick="switchTab('concept')">&#128172; Concept</button>
            <button class="tab-btn" data-tab="orders" onclick="switchTab('orders')">&#128230; Orders</button>
            <button class="tab-btn" data-tab="summary" onclick="switchTab('summary')">&#128203; Summary</button>
            <button class="tab-btn" data-tab="floorplan" onclick="switchTab('floorplan')">&#9783; Floor Plan</button>
          </div>

          <!-- Tab Content -->
          <div class="tab-content">

            <div class="tab-pane active" id="tab-concept">
              <p id="concept-text" class="concept-text"></p>
              <ul id="tips-list" class="tips-list"></ul>
            </div>

            <div class="tab-pane" id="tab-orders">
              <div class="card-header" style="flex-shrink:0;padding:6px 0 8px">
                <h3>&#128230; Order Items</h3>
                <span id="item-count" class="item-count-badge">0</span>
              </div>
              <div id="order-list" class="order-list" style="flex:1;overflow-y:auto"></div>
            </div>

            <div class="tab-pane" id="tab-summary">
              <div id="summary-rows" style="flex:1"></div>
              <button class="cta-btn" onclick="window.open('https://ges.store/','_blank')">
                &#8594;&nbsp; Shop the GES Store &nbsp;&#8594;
              </button>
              <p class="cta-hint">Head to GES Store to browse, select, and order your booth items</p>
            </div>

            <div class="tab-pane" id="tab-floorplan">
              <div id="floorplan-svg" style="width:100%;max-width:600px;margin:0 auto"></div>
            </div>

          </div>
      </div><!-- /results-panel -->

    </div><!-- /results-area -->

    <!-- Floating Chat Button -->
    <div id="chat-fab">
      <button class="fab-btn" onclick="toggleChatPopup()" title="Refine your booth">&#128172;</button>
      <div class="fab-unread" id="fab-unread"></div>
    </div>

    <!-- Chat Popup -->
    <div id="chat-popup">
      <div class="popup-header">
        <span class="popup-header-title">&#10022; Refine Your Booth</span>
        <button class="popup-close-btn" onclick="toggleChatPopup()">&#10005;</button>
      </div>
      <div id="chat-history" class="chat-history" style="flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:6px;min-height:80px"></div>
      <div class="chat-input-row">
        <input type="text" id="chat-input" class="chat-input"
               placeholder="e.g. &quot;Add 2 chairs&quot; or &quot;Make it more premium&quot;" maxlength="500">
        <button class="chat-send-btn" id="chat-send-btn">Send</button>
      </div>
    </div>

  </div><!-- /right-panel -->
</div><!-- /app-body -->

<footer>
  <p>&copy; 2026 GES &mdash; Global Experience Specialists. All rights reserved.</p>
  <p>Designed by <strong>TradeTech Transformers</strong> &mdash; Modernizing events through AI.</p>
</footer>

<!-- Loading overlay -->
<div id="loading-overlay" style="display:none" class="loading-overlay">
  <div class="loading-box">
    <img src="/logo.webp" class="loading-logo" alt="GES" onerror="this.style.display='none'">
    <div class="loading-spinner"></div>
    <h3 class="loading-title">Transforming your vision...</h3>
    <p class="loading-sub">Deploying AI to engineer your perfect booth.</p>
    <div class="loading-steps">
      <div class="loading-step done" id="ls1">&#10003; Scanning your specifications</div>
      <div class="loading-step active" id="ls2">&#9679; Transforming vision into a booth layout</div>
      <div class="loading-step" id="ls3">&#9675; Assembling the order manifest</div>
    </div>
  </div>
</div>

<!-- Toast -->
<div id="toast" style="display:none" class="toast"></div>

<script>
// ─── State ────────────────────────────────────────────────────────────────────
var uploadedImageBase64    = null;
var uploadedImageMediaType = 'image/jpeg';
var selectedVibe           = '';
var imagePrompt            = '';
var imageNegativePrompt    = '';
var currentRenderDataUrl   = null;
var conversationHistory    = [];

function buildNegativePrompt(orderItems) {
  var furniture = (orderItems || []).filter(function(i){ return i.category === 'Furniture'; });
  var parts = [];
  furniture.forEach(function(i) {
    var qty = parseInt(i.qty) || 1;
    var n   = i.name.toLowerCase();
    for (var q = qty + 1; q <= qty + 4; q++) parts.push(q + ' ' + n + 's');
    parts.push('extra ' + n);
  });
  return parts.join(', ') + (parts.length ? ', overcrowded, too much furniture, cluttered' : '');
}

function buildFurniturePrefix(orderItems) {
  var furniture = (orderItems || []).filter(function(i){ return i.category === 'Furniture'; });
  var spec = furniture.map(function(i){ return i.qty + ' ' + i.name.toLowerCase(); }).join(', ');
  return spec ? 'EXACT FURNITURE ONLY — ' + spec + '. No additional chairs or tables. ' : '';
}


// ─── Reference Image Upload ───────────────────────────────────────────────────
var imgZone = document.getElementById('img-zone');
document.getElementById('img-file').addEventListener('change', function(e) {
  if (e.target.files[0]) handleImageFile(e.target.files[0]);
});
imgZone.addEventListener('dragover', function(e) { e.preventDefault(); imgZone.classList.add('dragover'); });
imgZone.addEventListener('dragleave', function() { imgZone.classList.remove('dragover'); });
imgZone.addEventListener('drop', function(e) {
  e.preventDefault(); imgZone.classList.remove('dragover');
  var f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) handleImageFile(f);
});
function handleImageFile(file) {
  uploadedImageMediaType = file.type || 'image/jpeg';
  var reader = new FileReader();
  reader.onload = function(e) {
    uploadedImageBase64 = e.target.result.split(',')[1];
    document.getElementById('img-preview').src = e.target.result;
    imgZone.style.display = 'none';
    document.getElementById('img-preview-wrap').style.display = 'block';
  };
  reader.readAsDataURL(file);
}
document.getElementById('img-remove').addEventListener('click', function() {
  uploadedImageBase64 = null;
  document.getElementById('img-file').value = '';
  document.getElementById('img-preview-wrap').style.display = 'none';
  imgZone.style.display = 'block';
});


// ─── Chips ────────────────────────────────────────────────────────────────────
document.querySelectorAll('.vibe-chip').forEach(function(chip) {
  chip.addEventListener('click', function() {
    document.querySelectorAll('.vibe-chip').forEach(function(c) { c.classList.remove('active'); });
    chip.classList.add('active');
    selectedVibe = chip.dataset.val;
  });
});

// ─── Vision textarea ──────────────────────────────────────────────────────────
var visionEl = document.getElementById('vision');
visionEl.addEventListener('input', function() {
  document.getElementById('gen-btn').disabled = visionEl.value.trim().length < 10;
});
document.getElementById('gen-btn').addEventListener('click', generate);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseJSONResponse(text) {
  var clean = text.replace(/\`\`\`json\s*/gi, '').replace(/\`\`\`\s*/g, '').trim();
  // Strategy 1: direct parse
  try { return JSON.parse(clean); } catch(e) {}
  // Strategy 2: extract from first { to last }
  var start = clean.indexOf('{');
  var end   = clean.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(clean.substring(start, end + 1)); } catch(e) {
      throw new Error('JSON parse error: ' + e.message + '. Preview: ' + text.slice(0, 400));
    }
  }
  throw new Error('No JSON found in Claude response. Length: ' + text.length + '. Preview: ' + text.slice(0, 400));
}

function buildImagePromptPrefix(w, d, boothType, brandColors) {
  var sqft = (parseFloat(w) || 0) * (parseFloat(d) || 0);
  var sizeDesc = sqft <= 100 ? 'small compact 10x10' : sqft <= 200 ? 'medium 10x20' : sqft <= 400 ? 'medium 20x20' : 'large';
  var typeDesc = boothType ? boothType.split('/')[0].trim().toLowerCase() : 'inline';
  var prefix = 'Small trade show booth, ' + w + 'x' + d + ' ft ' + typeDesc + ' booth, ' + sizeDesc + ' size, modest footprint, tight layout. ';
  if (brandColors) prefix += 'Brand colors: ' + brandColors + '. ';
  return prefix;
}

function buildSystemPrompt(w, d, boothNumber) {
  var sqft  = (parseFloat(w) || 0) * (parseFloat(d) || 0);
  var rules = '';
  if (sqft > 400) {
    rules += '\\n- LARGE BOOTH (>20x20 ft): You MUST include a dedicated meeting/lounge area with seating, at least one 55"+ monitor, and a storage closet.';
  }
  if (boothNumber) {
    rules += '\\n- BOOTH #' + boothNumber + ': Include location-smart recommendations based on typical trade show layouts (aisle orientation, hero placement).';
  }
  return 'You are a GES (Global Experience Specialists) certified trade show booth design expert with 20+ years of experience. GES is the world\\'s leading full-service event solutions company.\\n\\nYour designs are professional, ADA-compliant, physically buildable, and always drive the exhibitor\\'s marketing goals.\\n\\nEXHIBITOR SPECIFICATIONS ARE LOCKED: If the exhibitor explicitly names an item or quantity (e.g. "1 chair", "2 tables", "LED wall"), that exact item and quantity MUST appear in order_items unchanged. Do not remove, rename, or change the quantity of anything explicitly requested. You may add items the exhibitor did not mention, and you may note recommendations — but never override what was explicitly asked for.\\n\\nCRITICAL: Respond ONLY with valid JSON. No markdown, no code fences, no text before or after the JSON object.' +
    (rules ? '\\n\\nSMART DESIGN RULES (apply automatically):\\n' + rules : '');
}

function buildFirstUserContent(showName, w, d, boothType, boothNumber, industry, brandColors, vibe, vision) {
  var promptText =
    'Design a complete GES trade show booth:\\n' +
    '- Show/Event: ' + showName + '\\n' +
    '- Booth Size: ' + w + ' ft x ' + d + ' ft\\n' +
    '- Booth Type: ' + boothType + '\\n' +
    (boothNumber ? '- Booth Number: ' + boothNumber + '\\n' : '') +
    (industry    ? '- Industry: ' + industry + '\\n' : '') +
    (brandColors ? '- Brand Colors: ' + brandColors + '\\n' : '') +
    '- Style/Vibe: ' + vibe + '\\n' +
    '- Exhibitor Vision: ' + vision + '\\n\\n' +
    'Return ONLY valid JSON matching this exact structure:\\n' +
    '{\\n' +
    '  "concept": "4-6 vivid sentences describing layout, atmosphere, visitor flow, hero element, and key design moments",\\n' +
    '  "image_prompt": "Photorealistic trade show booth interior photograph, exhibition hall, 8K architectural visualization. CRITICAL: reflect exact quantities from order_items — if the order has 1 chair include exactly 1 chair, if 2 tables include exactly 2 tables. Start with: [exact item counts, e.g. \\'one reception counter, two high-top tables, one large monitor\\']. Then describe: booth structure, backwall graphics, flooring, lighting, brand colors, atmosphere.",\\n' +
    '  "design_tips": ["specific actionable tip 1", "tip 2", "tip 3"],\\n' +
    '  "order_items": [{"name":"item name","category":"Furniture|Flooring|Signage|Lighting|AV|Electrical|Display|Storage","qty":"N","detail":"specific detail about configuration","icon":"single emoji"}],\\n' +
    '  "summary": {"booth_size":"' + w + 'x' + d + ' ft","booth_type":"' + boothType + '","estimated_items":"N items","key_features":["feature 1","feature 2","feature 3"]}\\n' +
    '}\\n\\n' +
    'Order items: include 8-14 specific, procurable items. More items for larger booths. Cover: flooring, structure/graphics, furniture, lighting, AV/monitors, electrical, display fixtures, storage.';

  var content = [{ type: 'text', text: promptText }];

  if (uploadedImageBase64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: uploadedImageMediaType, data: uploadedImageBase64 }
    });
    content.push({
      type: 'text',
      text: 'The image above is the exhibitor\\'s reference (existing booth, brand assets, or inspiration). Incorporate its color palette, design language, and style cues into the new booth design where appropriate.'
    });
  }

  return content;
}

// ─── Generate (first turn) ────────────────────────────────────────────────────
async function generate() {
  var w           = document.getElementById('booth-width').value   || 'unspecified';
  var d           = document.getElementById('booth-depth').value   || 'unspecified';
  var showName    = document.getElementById('show-name').value     || 'the upcoming show';
  var boothType   = document.getElementById('booth-type').value    || 'standard booth';
  var boothNumber = document.getElementById('booth-number').value  || '';
  var industry    = document.getElementById('industry').value      || '';
  var brandColors = document.getElementById('brand-colors').value  || '';
  var vision      = visionEl.value.trim();
  var vibe        = selectedVibe || 'professional';

  showLoading();

  var firstContent  = buildFirstUserContent(showName, w, d, boothType, boothNumber, industry, brandColors, vibe, vision);
  var systemPrompt  = buildSystemPrompt(w, d, boothNumber);

  var concept;
  try {
    var r = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: firstContent }]
      })
    });
    var data = await r.json();
    if (!r.ok) {
      var msg = (data.error && data.error.message) ? data.error.message : JSON.stringify(data.error || data);
      throw new Error(msg);
    }
    var text = (data.content && data.content[0] && data.content[0].text) ? data.content[0].text : '';
    concept = parseJSONResponse(text);

    // Seed conversation history — text-only for first user msg to keep refinements lean
    var historyUserMsg = '(Initial generation) Show: ' + showName + ' | Size: ' + w + 'x' + d + ' | Type: ' + boothType +
      (boothNumber ? ' | Booth #' + boothNumber : '') + (industry ? ' | Industry: ' + industry : '') +
      (brandColors ? ' | Colors: ' + brandColors : '') + ' | Vibe: ' + vibe + ' | Vision: ' + vision;
    conversationHistory = [
      { role: 'user',      content: historyUserMsg },
      { role: 'assistant', content: text }
    ];
  } catch(e) {
    hideLoading();
    showToast('Generation failed: ' + e.message.slice(0, 180), 'error');
    return;
  }

  hideLoading();
  imageNegativePrompt = buildNegativePrompt(concept.order_items);
  imagePrompt = buildImagePromptPrefix(w, d, boothType, brandColors) +
    buildFurniturePrefix(concept.order_items) +
    (concept.image_prompt || '');
  renderConcept(concept, showName, w, d, boothType, false);

  generateImage();

  document.getElementById('chat-fab').style.display = 'flex';
  document.getElementById('chat-history').innerHTML   = '';
  document.getElementById('rerender-bar').style.display = 'none';
}

// ─── 2D Floor Plan SVG Generator (detailed) ──────────────────────────────────
function generateFloorPlanSVG(orderItems, fw, fd, boothType) {
  fw = parseFloat(fw) || 20;
  fd = parseFloat(fd) || 20;

  var SVG_W = 620, SVG_H = 520;
  var TITLE_H = 24, LEGEND_H = 68;
  var ML = 56, MR = 46, MT = TITLE_H + 18, MB = LEGEND_H + 18;
  var availW = SVG_W - ML - MR, availH = SVG_H - MT - MB;
  var sc = Math.min(availW / fw, availH / fd);
  var bw = fw * sc, bd = fd * sc;
  var ox = ML + (availW - bw) / 2, oy = MT + (availH - bd) / 2;
  var WT = Math.max(4, sc * 0.35);

  var type = (boothType || '').toLowerCase();
  var isIsland    = type.includes('island');
  var isPeninsula = type.includes('peninsula');
  var isCorner    = type.includes('corner');
  var openTop   = isIsland;
  var openLeft  = isIsland || isPeninsula;
  var openRight = isIsland || isPeninsula || isCorner;

  function f(v) { return v * sc; }

  function classify(name, cat) {
    var n = (name || '').toLowerCase(), c = (cat || '').toLowerCase();
    if (/led.*(wall|screen|video)|video wall/.test(n)) return 'led_wall';
    if (/hanging|overhead sign|suspended sign/.test(n)) return 'hanging_sign';
    if (/backwall|back wall|backdrop|back panel/.test(n)) return 'backwall';
    if (/reception|info counter|registration counter/.test(n)) return 'reception';
    if (/monitor|screen|display| tv |^tv$/.test(n) && c !== 'signage') return 'monitor';
    if (/storage|closet|cabinet/.test(n)) return 'storage';
    if (/sofa|couch|loveseat/.test(n)) return 'sofa';
    if (/high.top|hi.top|cocktail table|bistro/.test(n)) return 'hightop';
    if (/conference|meeting table|boardroom/.test(n)) return 'conf_table';
    if (/chair|seating|stool/.test(n) && c === 'furniture') return 'chair';
    if (/table|desk/.test(n) && c === 'furniture') return 'table';
    if (/pedestal|kiosk|demo station|interactive/.test(n)) return 'pedestal';
    if (/banner|sign|graphic panel/.test(n) || c === 'signage') return 'signage';
    if (c === 'flooring') return 'flooring';
    if (c === 'lighting') return 'lighting';
    if (c === 'electrical') return 'electrical';
    return 'generic';
  }

  var items = (orderItems || []).map(function(item) {
    return { item: item, qty: Math.max(1, parseInt(item.qty) || 1), type: classify(item.name, item.category), name: item.name || '' };
  });
  function byType(t) { return items.filter(function(i) { return i.type === t; }); }

  var defs = '<marker id="ah" markerWidth="8" markerHeight="6" refX="6" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="rgba(255,107,0,0.3)"/></marker>';
  var hasFlooring = byType('flooring').length > 0;
  if (hasFlooring) defs += '<pattern id="hatch" patternUnits="userSpaceOnUse" width="14" height="14" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="14" stroke="rgba(255,255,255,0.03)" stroke-width="5"/></pattern>';

  var s = '';

  s += '<rect width="' + SVG_W + '" height="' + SVG_H + '" fill="#0a1520" rx="4"/>';
  s += '<text x="' + (SVG_W / 2) + '" y="17" fill="rgba(255,107,0,0.58)" text-anchor="middle" font-size="9.5" font-family="monospace" letter-spacing="3" font-weight="700">2D FLOOR PLAN — TOP VIEW</text>';

  s += '<rect x="' + ox + '" y="' + oy + '" width="' + bw + '" height="' + bd + '" fill="#0d1e30" rx="2"/>';
  if (hasFlooring) s += '<rect x="' + ox + '" y="' + oy + '" width="' + bw + '" height="' + bd + '" fill="url(#hatch)"/>';

  var gridFt = Math.max(2, Math.round(Math.max(fw, fd) / 8));
  var gridPx = f(gridFt);
  for (var gx = ox; gx <= ox + bw + 0.5; gx += gridPx) {
    s += '<line x1="' + gx.toFixed(1) + '" y1="' + oy + '" x2="' + gx.toFixed(1) + '" y2="' + (oy + bd) + '" stroke="rgba(255,255,255,0.03)" stroke-width="0.5"/>';
  }
  for (var gy = oy; gy <= oy + bd + 0.5; gy += gridPx) {
    s += '<line x1="' + ox + '" y1="' + gy.toFixed(1) + '" x2="' + (ox + bw) + '" y2="' + gy.toFixed(1) + '" stroke="rgba(255,255,255,0.03)" stroke-width="0.5"/>';
  }

  var zBackH = bd * 0.28, zFrontH = bd * 0.20;
  s += '<rect x="' + ox + '" y="' + oy + '" width="' + bw + '" height="' + zBackH + '" fill="rgba(15,50,85,0.5)"/>';
  s += '<rect x="' + ox + '" y="' + (oy + bd - zFrontH) + '" width="' + bw + '" height="' + zFrontH + '" fill="rgba(10,45,15,0.4)"/>';
  s += '<text x="' + (ox + 7) + '" y="' + (oy + 10) + '" fill="rgba(80,140,200,0.35)" font-size="7" font-family="monospace" letter-spacing="1.5">BACK WALL ZONE</text>';
  s += '<text x="' + (ox + 7) + '" y="' + (oy + bd - 5) + '" fill="rgba(60,160,60,0.35)" font-size="7" font-family="monospace" letter-spacing="1.5">ENTRANCE ZONE</text>';
  s += '<line x1="' + (ox + 12) + '" y1="' + (oy + zBackH) + '" x2="' + (ox + bw - 12) + '" y2="' + (oy + zBackH) + '" stroke="rgba(255,107,0,0.08)" stroke-width="1" stroke-dasharray="5,5"/>';
  s += '<line x1="' + (ox + 12) + '" y1="' + (oy + bd - zFrontH) + '" x2="' + (ox + bw - 12) + '" y2="' + (oy + bd - zFrontH) + '" stroke="rgba(255,107,0,0.08)" stroke-width="1" stroke-dasharray="5,5"/>';

  byType('hanging_sign').forEach(function(ci) {
    var hsW = Math.min(bw * 0.7, f(16)), hsH = Math.min(bd * 0.7, f(16));
    var hx = ox + (bw - hsW) / 2, hy = oy + (bd - hsH) / 2;
    s += '<rect x="' + hx + '" y="' + hy + '" width="' + hsW + '" height="' + hsH + '" fill="rgba(255,200,0,0.025)" stroke="rgba(255,200,0,0.35)" stroke-width="1.5" stroke-dasharray="9,5" rx="4"/>';
    s += '<text x="' + (hx + hsW / 2) + '" y="' + (hy + 16) + '" fill="rgba(255,210,0,0.45)" text-anchor="middle" font-size="8" font-family="monospace" letter-spacing="1">OVERHEAD SIGN</text>';
    s += '<text x="' + (hx + hsW / 2) + '" y="' + (hy + 28) + '" fill="rgba(255,210,0,0.3)" text-anchor="middle" font-size="7.5" font-family="system-ui,sans-serif">' + escHtml((ci.name || '').slice(0, 20)) + '</text>';
  });

  byType('backwall').forEach(function() {
    s += '<rect x="' + ox + '" y="' + oy + '" width="' + bw + '" height="' + f(1.0) + '" fill="#12304e" stroke="rgba(60,140,220,0.45)" stroke-width="1"/>';
    s += '<text x="' + (ox + bw / 2) + '" y="' + (oy + f(0.65)) + '" fill="rgba(100,180,240,0.55)" text-anchor="middle" font-size="8" font-family="monospace" letter-spacing="1">BACKWALL GRAPHIC</text>';
  });

  byType('led_wall').forEach(function() {
    var lw = Math.min(bw * 0.65, f(14)), lh = f(0.5);
    var lx = ox + (bw - lw) / 2;
    s += '<rect x="' + lx + '" y="' + oy + '" width="' + lw + '" height="' + lh + '" fill="#080e28" stroke="rgba(50,100,255,0.9)" stroke-width="2"/>';
    for (var sl = 1; sl < 4; sl++) {
      s += '<line x1="' + lx + '" y1="' + (oy + lh * sl / 4) + '" x2="' + (lx + lw) + '" y2="' + (oy + lh * sl / 4) + '" stroke="rgba(50,100,255,0.18)" stroke-width="0.5"/>';
    }
    s += '<text x="' + (lx + lw / 2) + '" y="' + (oy + f(0.3)) + '" fill="rgba(90,150,255,0.88)" text-anchor="middle" font-size="8.5" font-family="monospace" letter-spacing="1">&#9632; LED VIDEO WALL &#9632;</text>';
  });

  byType('monitor').forEach(function(ci, idx) {
    var mw = f(2.5), mh = f(0.4);
    var mx = idx % 2 === 0 ? ox + f(1) : ox + bw - f(1) - mw;
    var my = oy + f(0.2);
    s += '<rect x="' + mx + '" y="' + my + '" width="' + mw + '" height="' + mh + '" fill="#090f24" stroke="rgba(80,130,255,0.7)" stroke-width="1.5"/>';
    s += '<rect x="' + (mx + mw * 0.06) + '" y="' + (my + mh * 0.1) + '" width="' + (mw * 0.88) + '" height="' + (mh * 0.8) + '" fill="rgba(50,90,200,0.15)"/>';
    s += '<text x="' + (mx + mw / 2) + '" y="' + (my + mh * 0.6) + '" fill="rgba(100,155,255,0.7)" text-anchor="middle" dominant-baseline="middle" font-size="7" font-family="system-ui,sans-serif">Monitor</text>';
  });

  byType('lighting').forEach(function(ci) {
    var count = Math.min(ci.qty * 2, 8);
    for (var li = 0; li < count; li++) {
      var lx2 = ox + bw * (0.1 + li * 0.8 / Math.max(count - 1, 1));
      var ly2 = oy + f(0.42);
      s += '<circle cx="' + lx2 + '" cy="' + ly2 + '" r="' + f(0.3) + '" fill="rgba(255,220,100,0.08)" stroke="rgba(255,220,100,0.55)" stroke-width="1"/>';
      s += '<line x1="' + (lx2 - f(0.48)) + '" y1="' + ly2 + '" x2="' + (lx2 + f(0.48)) + '" y2="' + ly2 + '" stroke="rgba(255,220,100,0.38)" stroke-width="0.7"/>';
      s += '<line x1="' + lx2 + '" y1="' + (ly2 - f(0.48)) + '" x2="' + lx2 + '" y2="' + (ly2 + f(0.48)) + '" stroke="rgba(255,220,100,0.38)" stroke-width="0.7"/>';
    }
  });

  byType('storage').forEach(function(ci, idx) {
    var sw = Math.min(f(4), bw * 0.22), sh = Math.min(f(4), bd * 0.28);
    var sx = idx % 2 === 0 ? ox : ox + bw - sw;
    s += '<rect x="' + sx + '" y="' + oy + '" width="' + sw + '" height="' + sh + '" fill="#0c1018" stroke="rgba(90,85,160,0.65)" stroke-width="1.5"/>';
    s += '<line x1="' + sx + '" y1="' + oy + '" x2="' + (sx + sw) + '" y2="' + (oy + sh) + '" stroke="rgba(90,85,160,0.2)" stroke-width="1"/>';
    s += '<line x1="' + (sx + sw) + '" y1="' + oy + '" x2="' + sx + '" y2="' + (oy + sh) + '" stroke="rgba(90,85,160,0.2)" stroke-width="1"/>';
    var dArcR = Math.min(sw, sh) * 0.6, sweep = idx % 2 === 0 ? 0 : 1;
    var dArcX = idx % 2 === 0 ? sx + sw : sx;
    var dEndX = dArcX + (idx % 2 === 0 ? -dArcR : dArcR);
    s += '<path d="M ' + dArcX + ' ' + (oy + sh) + ' A ' + dArcR + ' ' + dArcR + ' 0 0 ' + sweep + ' ' + dEndX + ' ' + (oy + sh - dArcR) + '" fill="none" stroke="rgba(90,85,160,0.45)" stroke-width="1" stroke-dasharray="3,2"/>';
    s += '<text x="' + (sx + sw / 2) + '" y="' + (oy + sh / 2 + 4) + '" fill="rgba(120,115,200,0.75)" text-anchor="middle" dominant-baseline="middle" font-size="8.5" font-family="system-ui,sans-serif">Storage</text>';
  });

  byType('signage').forEach(function(ci, idx) {
    var sgW = f(0.35), sgH = Math.min(f(4), bd * 0.28);
    var sx2 = idx % 2 === 0 ? ox + f(0.1) : ox + bw - sgW - f(0.1);
    var sy2 = oy + zBackH + (bd - zBackH - zFrontH) * 0.1 + idx * f(4.5);
    if (sy2 + sgH > oy + bd - zFrontH) return;
    s += '<rect x="' + sx2 + '" y="' + sy2 + '" width="' + sgW + '" height="' + sgH + '" fill="#100820" stroke="rgba(140,80,220,0.6)" stroke-width="1.5"/>';
    s += '<text x="' + (sx2 + sgW / 2) + '" y="' + (sy2 + sgH / 2) + '" fill="rgba(160,100,240,0.65)" text-anchor="middle" dominant-baseline="middle" font-size="7.5" font-family="system-ui,sans-serif" transform="rotate(-90,' + (sx2 + sgW / 2) + ',' + (sy2 + sgH / 2) + ')">Signage</text>';
  });

  byType('conf_table').forEach(function(ci, idx) {
    var ctW = Math.min(bw * 0.42, f(8)), ctH = Math.min(bd * 0.22, f(4));
    var ctx = ox + bw * 0.53, cty = oy + bd * 0.32 + idx * f(5);
    if (cty + ctH > oy + bd - zFrontH - f(0.5)) cty = oy + zBackH + f(1);
    var cR = f(0.7);
    s += '<rect x="' + ctx + '" y="' + cty + '" width="' + ctW + '" height="' + ctH + '" fill="#18120a" stroke="rgba(200,150,50,0.75)" stroke-width="1.5" rx="' + f(0.4) + '"/>';
    s += '<line x1="' + (ctx + f(0.5)) + '" y1="' + (cty + ctH / 2) + '" x2="' + (ctx + ctW - f(0.5)) + '" y2="' + (cty + ctH / 2) + '" stroke="rgba(200,150,50,0.18)" stroke-width="0.5"/>';
    s += '<text x="' + (ctx + ctW / 2) + '" y="' + (cty + ctH / 2 + 4) + '" fill="rgba(220,170,70,0.82)" text-anchor="middle" dominant-baseline="middle" font-size="8.5" font-family="system-ui,sans-serif">Conf. Table</text>';
    var nc = Math.max(1, Math.floor(ctW / f(2)));
    for (var cj = 0; cj < nc; cj++) {
      var cx2 = ctx + f(1) + cj * (ctW - f(2)) / Math.max(nc - 1, 1);
      s += '<circle cx="' + cx2 + '" cy="' + (cty - cR - 2) + '" r="' + cR + '" fill="#1e1408" stroke="rgba(200,150,50,0.5)" stroke-width="1"/>';
      s += '<path d="M ' + (cx2 - cR * 0.7) + ' ' + (cty - cR - 2) + ' A ' + (cR * 0.85) + ' ' + (cR * 0.85) + ' 0 0 1 ' + (cx2 + cR * 0.7) + ' ' + (cty - cR - 2) + '" fill="none" stroke="rgba(200,150,50,0.38)" stroke-width="1"/>';
      s += '<circle cx="' + cx2 + '" cy="' + (cty + ctH + cR + 2) + '" r="' + cR + '" fill="#1e1408" stroke="rgba(200,150,50,0.5)" stroke-width="1"/>';
      s += '<path d="M ' + (cx2 - cR * 0.7) + ' ' + (cty + ctH + cR + 2) + ' A ' + (cR * 0.85) + ' ' + (cR * 0.85) + ' 0 0 0 ' + (cx2 + cR * 0.7) + ' ' + (cty + ctH + cR + 2) + '" fill="none" stroke="rgba(200,150,50,0.38)" stroke-width="1"/>';
    }
    s += '<circle cx="' + (ctx - cR - 2) + '" cy="' + (cty + ctH / 2) + '" r="' + cR + '" fill="#1e1408" stroke="rgba(200,150,50,0.5)" stroke-width="1"/>';
    s += '<circle cx="' + (ctx + ctW + cR + 2) + '" cy="' + (cty + ctH / 2) + '" r="' + cR + '" fill="#1e1408" stroke="rgba(200,150,50,0.5)" stroke-width="1"/>';
  });

  byType('sofa').forEach(function(ci, idx) {
    var sw2 = Math.min(bw * 0.38, f(8)), sh2 = f(2.5);
    var sx3 = ox + bw * 0.55, sy3 = oy + bd * 0.42 + idx * f(3.2);
    if (sy3 + sh2 > oy + bd - zFrontH - f(0.5)) sy3 = oy + zBackH + f(1);
    s += '<rect x="' + sx3 + '" y="' + sy3 + '" width="' + sw2 + '" height="' + sh2 + '" fill="#100e1c" stroke="rgba(120,100,210,0.68)" stroke-width="1.5" rx="' + f(0.4) + '"/>';
    s += '<rect x="' + sx3 + '" y="' + sy3 + '" width="' + f(0.42) + '" height="' + sh2 + '" fill="rgba(120,100,210,0.16)" rx="' + f(0.22) + '"/>';
    s += '<rect x="' + (sx3 + sw2 - f(0.42)) + '" y="' + sy3 + '" width="' + f(0.42) + '" height="' + sh2 + '" fill="rgba(120,100,210,0.16)" rx="' + f(0.22) + '"/>';
    var cushN = Math.max(2, Math.round(sw2 / f(2.5)));
    for (var cu = 1; cu < cushN; cu++) {
      var cx3 = sx3 + f(0.42) + cu * (sw2 - f(0.84)) / cushN;
      s += '<line x1="' + cx3 + '" y1="' + (sy3 + f(0.2)) + '" x2="' + cx3 + '" y2="' + (sy3 + sh2 - f(0.2)) + '" stroke="rgba(120,100,210,0.28)" stroke-width="1"/>';
    }
    s += '<text x="' + (sx3 + sw2 / 2) + '" y="' + (sy3 + sh2 / 2 + 4) + '" fill="rgba(150,130,240,0.72)" text-anchor="middle" dominant-baseline="middle" font-size="8.5" font-family="system-ui,sans-serif">Sofa</text>';
  });

  var htPos = [
    [ox + bw * 0.14, oy + bd * 0.52], [ox + bw * 0.32, oy + bd * 0.52],
    [ox + bw * 0.14, oy + bd * 0.68], [ox + bw * 0.32, oy + bd * 0.68]
  ];
  byType('hightop').forEach(function(ci, idx) {
    var tR = f(1.35), pos = htPos[idx % htPos.length];
    var cx4 = pos[0], cy4 = pos[1];
    s += '<circle cx="' + cx4 + '" cy="' + cy4 + '" r="' + tR + '" fill="#161008" stroke="rgba(200,155,50,0.7)" stroke-width="1.5"/>';
    s += '<circle cx="' + cx4 + '" cy="' + cy4 + '" r="' + (tR * 0.52) + '" fill="none" stroke="rgba(200,155,50,0.2)" stroke-width="0.7"/>';
    var stR = f(0.44);
    for (var st = 0; st < 3; st++) {
      var ang = (st * 120 - 90) * Math.PI / 180;
      s += '<circle cx="' + (cx4 + (tR + stR + 3) * Math.cos(ang)) + '" cy="' + (cy4 + (tR + stR + 3) * Math.sin(ang)) + '" r="' + stR + '" fill="#161008" stroke="rgba(200,155,50,0.4)" stroke-width="1"/>';
    }
    s += '<text x="' + cx4 + '" y="' + cy4 + '" fill="rgba(220,175,70,0.72)" text-anchor="middle" dominant-baseline="middle" font-size="7.5" font-family="system-ui,sans-serif">Hi-Top</text>';
  });

  byType('table').forEach(function(ci, idx) {
    var tw = Math.min(bw * 0.32, f(5)), th = f(2.5);
    var tx = ox + bw * 0.1 + idx * f(5.5), ty = oy + bd * 0.44;
    if (tx + tw > ox + bw * 0.5) return;
    s += '<rect x="' + tx + '" y="' + ty + '" width="' + tw + '" height="' + th + '" fill="#151008" stroke="rgba(200,155,50,0.62)" stroke-width="1.5"/>';
    s += '<text x="' + (tx + tw / 2) + '" y="' + (ty + th / 2 + 4) + '" fill="rgba(220,175,70,0.72)" text-anchor="middle" dominant-baseline="middle" font-size="8.5" font-family="system-ui,sans-serif">' + escHtml((ci.name || '').slice(0, 12)) + '</text>';
    var cR2 = f(0.65), nc2 = Math.max(1, Math.floor(tw / f(2)));
    for (var cj2 = 0; cj2 < nc2; cj2++) {
      var cx5 = tx + f(1) + cj2 * (tw - f(2)) / Math.max(nc2 - 1, 1);
      s += '<circle cx="' + cx5 + '" cy="' + (ty - cR2 - 2) + '" r="' + cR2 + '" fill="#1e1408" stroke="rgba(200,155,50,0.45)" stroke-width="1"/>';
      s += '<circle cx="' + cx5 + '" cy="' + (ty + th + cR2 + 2) + '" r="' + cR2 + '" fill="#1e1408" stroke="rgba(200,155,50,0.45)" stroke-width="1"/>';
    }
  });

  var pedPos = [
    [ox + bw * 0.18, oy + bd * 0.28], [ox + bw * 0.42, oy + bd * 0.28],
    [ox + bw * 0.66, oy + bd * 0.28], [ox + bw * 0.30, oy + bd * 0.48],
    [ox + bw * 0.54, oy + bd * 0.48]
  ];
  byType('pedestal').forEach(function(ci, idx) {
    var pw = f(2), ph = f(2), pos = pedPos[idx % pedPos.length];
    var px2 = pos[0] - pw / 2, py2 = pos[1] - ph / 2;
    s += '<rect x="' + px2 + '" y="' + py2 + '" width="' + pw + '" height="' + ph + '" fill="#12100a" stroke="rgba(200,185,60,0.65)" stroke-width="1.5"/>';
    s += '<rect x="' + (px2 + pw * 0.15) + '" y="' + (py2 + ph * 0.15) + '" width="' + (pw * 0.7) + '" height="' + (ph * 0.7) + '" fill="rgba(200,185,60,0.06)" stroke="rgba(200,185,60,0.22)" stroke-width="0.5"/>';
    s += '<text x="' + (px2 + pw / 2) + '" y="' + (py2 + ph / 2 + 4) + '" fill="rgba(220,205,80,0.72)" text-anchor="middle" dominant-baseline="middle" font-size="7.5" font-family="system-ui,sans-serif">Display</text>';
  });

  byType('reception').forEach(function() {
    var rw = Math.min(bw * 0.42, f(8)), rh = f(2.2);
    var rx2 = ox + (bw - rw) / 2, ry2 = oy + bd - zFrontH + f(0.5);
    s += '<rect x="' + rx2 + '" y="' + ry2 + '" width="' + rw + '" height="' + rh + '" fill="#0e1e0c" stroke="rgba(55,175,75,0.78)" stroke-width="2"/>';
    s += '<rect x="' + rx2 + '" y="' + ry2 + '" width="' + rw + '" height="' + f(0.32) + '" fill="rgba(55,175,75,0.1)"/>';
    s += '<rect x="' + rx2 + '" y="' + (ry2 + rh - f(0.28)) + '" width="' + rw + '" height="' + f(0.28) + '" fill="rgba(55,175,75,0.15)"/>';
    s += '<line x1="' + (rx2 + f(0.4)) + '" y1="' + (ry2 + rh * 0.4) + '" x2="' + (rx2 + rw - f(0.4)) + '" y2="' + (ry2 + rh * 0.4) + '" stroke="rgba(55,175,75,0.2)" stroke-width="0.5"/>';
    s += '<text x="' + (rx2 + rw / 2) + '" y="' + (ry2 + rh / 2 + 4) + '" fill="rgba(75,210,95,0.88)" text-anchor="middle" dominant-baseline="middle" font-size="9" font-family="system-ui,sans-serif" font-weight="600">Reception Counter</text>';
  });

  byType('electrical').forEach(function(ci, idx) {
    var ex = ox + bw * (0.12 + idx * 0.28), ey = oy + bd - f(0.65);
    s += '<rect x="' + ex + '" y="' + ey + '" width="' + f(0.55) + '" height="' + f(0.55) + '" fill="#0a1e0a" stroke="rgba(50,185,50,0.62)" stroke-width="1"/>';
    s += '<text x="' + (ex + f(0.27)) + '" y="' + (ey - 4) + '" fill="rgba(50,185,50,0.42)" text-anchor="middle" font-size="7" font-family="monospace">&#9889;</text>';
  });

  function drawWall(x1, y1, x2, y2, open) {
    if (open) {
      return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="rgba(255,107,0,0.5)" stroke-width="2.5" stroke-dasharray="10,6"/>';
    }
    var isV = Math.abs(x1 - x2) < 1;
    if (isV) {
      var minY2 = Math.min(y1, y2), maxY2 = Math.max(y1, y2);
      return '<rect x="' + (x1 - WT / 2) + '" y="' + minY2 + '" width="' + WT + '" height="' + (maxY2 - minY2) + '" fill="rgba(70,140,210,0.55)" stroke="rgba(100,180,240,0.88)" stroke-width="0.5"/>';
    }
    var minX2 = Math.min(x1, x2), maxX2 = Math.max(x1, x2);
    return '<rect x="' + minX2 + '" y="' + (y1 - WT / 2) + '" width="' + (maxX2 - minX2) + '" height="' + WT + '" fill="rgba(70,140,210,0.55)" stroke="rgba(100,180,240,0.88)" stroke-width="0.5"/>';
  }
  s += drawWall(ox, oy, ox + bw, oy, openTop);
  s += drawWall(ox + bw, oy, ox + bw, oy + bd, openRight);
  s += drawWall(ox, oy + bd, ox + bw, oy + bd, true);
  s += drawWall(ox, oy, ox, oy + bd, openLeft);
  [[ox, oy], [ox + bw, oy], [ox + bw, oy + bd], [ox, oy + bd]].forEach(function(pt) {
    s += '<rect x="' + (pt[0] - WT / 2) + '" y="' + (pt[1] - WT / 2) + '" width="' + WT + '" height="' + WT + '" fill="rgba(100,180,240,0.75)"/>';
  });

  s += '<line x1="' + (ox + bw / 2) + '" y1="' + (oy + bd * 0.95) + '" x2="' + (ox + bw / 2) + '" y2="' + (oy + bd * 0.75) + '" stroke="rgba(255,107,0,0.22)" stroke-width="1.5" marker-end="url(#ah)"/>';
  if (isIsland || isPeninsula || isCorner) {
    s += '<line x1="' + (ox + bw * 0.96) + '" y1="' + (oy + bd / 2) + '" x2="' + (ox + bw * 0.82) + '" y2="' + (oy + bd / 2) + '" stroke="rgba(255,107,0,0.22)" stroke-width="1.5" marker-end="url(#ah)"/>';
  }

  s += '<text x="' + (ox + bw / 2) + '" y="' + (oy + bd + 20) + '" fill="rgba(255,107,0,0.42)" text-anchor="middle" font-size="8.5" font-family="monospace" letter-spacing="2">&#9660; AISLE &#9660;</text>';

  var dY2 = oy + bd + 34, dX2 = ox + bw + 30;
  s += '<line x1="' + ox + '" y1="' + dY2 + '" x2="' + (ox + bw) + '" y2="' + dY2 + '" stroke="rgba(255,107,0,0.55)" stroke-width="1"/>';
  s += '<line x1="' + ox + '" y1="' + (dY2 - 4) + '" x2="' + ox + '" y2="' + (dY2 + 4) + '" stroke="rgba(255,107,0,0.55)" stroke-width="1"/>';
  s += '<line x1="' + (ox + bw) + '" y1="' + (dY2 - 4) + '" x2="' + (ox + bw) + '" y2="' + (dY2 + 4) + '" stroke="rgba(255,107,0,0.55)" stroke-width="1"/>';
  s += '<text x="' + (ox + bw / 2) + '" y="' + (dY2 + 13) + '" fill="rgba(255,107,0,0.72)" text-anchor="middle" font-size="10" font-family="monospace">' + fw + ' ft</text>';
  s += '<line x1="' + dX2 + '" y1="' + oy + '" x2="' + dX2 + '" y2="' + (oy + bd) + '" stroke="rgba(255,107,0,0.55)" stroke-width="1"/>';
  s += '<line x1="' + (dX2 - 4) + '" y1="' + oy + '" x2="' + (dX2 + 4) + '" y2="' + oy + '" stroke="rgba(255,107,0,0.55)" stroke-width="1"/>';
  s += '<line x1="' + (dX2 - 4) + '" y1="' + (oy + bd) + '" x2="' + (dX2 + 4) + '" y2="' + (oy + bd) + '" stroke="rgba(255,107,0,0.55)" stroke-width="1"/>';
  s += '<text x="' + (dX2 + 13) + '" y="' + (oy + bd / 2) + '" fill="rgba(255,107,0,0.72)" text-anchor="middle" font-size="10" font-family="monospace" transform="rotate(90,' + (dX2 + 13) + ',' + (oy + bd / 2) + ')">' + fd + ' ft</text>';

  var sbFt = Math.max(2, Math.round(fw / 5)), sbPx = f(sbFt), sbX = ox, sbY = oy - 18;
  s += '<line x1="' + sbX + '" y1="' + sbY + '" x2="' + (sbX + sbPx) + '" y2="' + sbY + '" stroke="rgba(255,107,0,0.55)" stroke-width="2"/>';
  s += '<line x1="' + sbX + '" y1="' + (sbY - 4) + '" x2="' + sbX + '" y2="' + (sbY + 4) + '" stroke="rgba(255,107,0,0.55)" stroke-width="1"/>';
  s += '<line x1="' + (sbX + sbPx) + '" y1="' + (sbY - 4) + '" x2="' + (sbX + sbPx) + '" y2="' + (sbY + 4) + '" stroke="rgba(255,107,0,0.55)" stroke-width="1"/>';
  s += '<text x="' + (sbX + sbPx / 2) + '" y="' + (sbY - 7) + '" fill="rgba(255,107,0,0.6)" text-anchor="middle" font-size="8.5" font-family="monospace">= ' + sbFt + ' ft</text>';

  var legY2 = SVG_H - LEGEND_H + 14;
  s += '<line x1="16" y1="' + (legY2 - 8) + '" x2="' + (SVG_W - 16) + '" y2="' + (legY2 - 8) + '" stroke="rgba(255,107,0,0.1)" stroke-width="1"/>';
  [
    { color: '#3a78c4', label: 'AV / Screens' }, { color: '#3aaa4a', label: 'Reception' },
    { color: '#c07820', label: 'Furniture' },    { color: '#8060c0', label: 'Lounge / Sofa' },
    { color: '#6060a0', label: 'Storage' },      { color: '#a0a030', label: 'Kiosk / Pedestal' }
  ].forEach(function(li, i) {
    var lx3 = 16 + i * (SVG_W - 32) / 6;
    s += '<rect x="' + lx3 + '" y="' + legY2 + '" width="9" height="9" fill="' + li.color + '" opacity="0.65" rx="1"/>';
    s += '<text x="' + (lx3 + 13) + '" y="' + (legY2 + 8) + '" fill="rgba(150,195,230,0.52)" font-size="8.5" font-family="system-ui,sans-serif">' + li.label + '</text>';
  });
  var wkY = legY2 + 18;
  s += '<line x1="16" y1="' + (wkY + 5) + '" x2="38" y2="' + (wkY + 5) + '" stroke="rgba(100,180,240,0.82)" stroke-width="3"/>';
  s += '<text x="42" y="' + (wkY + 9) + '" fill="rgba(150,195,230,0.5)" font-size="8.5" font-family="system-ui,sans-serif">Closed wall</text>';
  s += '<line x1="140" y1="' + (wkY + 5) + '" x2="162" y2="' + (wkY + 5) + '" stroke="rgba(255,107,0,0.5)" stroke-width="2.5" stroke-dasharray="8,5"/>';
  s += '<text x="166" y="' + (wkY + 9) + '" fill="rgba(150,195,230,0.5)" font-size="8.5" font-family="system-ui,sans-serif">Open / Aisle</text>';
  s += '<line x1="270" y1="' + (wkY + 5) + '" x2="292" y2="' + (wkY + 5) + '" stroke="rgba(255,200,0,0.45)" stroke-width="1.5" stroke-dasharray="7,4"/>';
  s += '<text x="296" y="' + (wkY + 9) + '" fill="rgba(150,195,230,0.5)" font-size="8.5" font-family="system-ui,sans-serif">Overhead / Ceiling</text>';
  s += '<circle cx="430" cy="' + (wkY + 5) + '" r="5" fill="rgba(255,220,100,0.08)" stroke="rgba(255,220,100,0.55)" stroke-width="1"/>';
  s += '<text x="440" y="' + (wkY + 9) + '" fill="rgba(150,195,230,0.5)" font-size="8.5" font-family="system-ui,sans-serif">Light fixture</text>';

  return '<svg viewBox="0 0 ' + SVG_W + ' ' + SVG_H + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;border-radius:4px"><defs>' + defs + '</defs>' + s + '</svg>';
}

// ─── Render Concept ───────────────────────────────────────────────────────────
function renderConcept(r, showName, w, d, boothType, isRefinement) {
  document.getElementById('empty-state').style.display  = 'none';
  document.getElementById('results-panel').style.display = 'flex';

  document.getElementById('results-subtitle').textContent =
    showName + ' • ' + w + '×' + d + ' ft • ' + boothType;

  document.getElementById('concept-text').textContent = r.concept || '';

  var tipsEl = document.getElementById('tips-list');
  tipsEl.innerHTML = (r.design_tips || []).map(function(t) {
    return '<li class="tip-item">' + escHtml(t) + '</li>';
  }).join('');

  var items = r.order_items || [];
  document.getElementById('item-count').textContent = items.length;
  document.getElementById('order-list').innerHTML = items.map(function(i) {
    return '<div class="order-item">' +
      '<div class="oi-icon">' + (i.icon || '\u{1F4E6}') + '</div>' +
      '<div class="oi-info">' +
        '<div class="oi-name">'   + escHtml(i.name)   + '</div>' +
        '<div class="oi-detail">' + escHtml(i.category) + ' — ' + escHtml(i.detail) + '</div>' +
      '</div>' +
      '<div class="oi-qty">' + escHtml(String(i.qty)) + '</div>' +
    '</div>';
  }).join('');

  var s = r.summary || {};
  var rows = [
    ['Booth Size',   s.booth_size    || (w + '×' + d + ' ft')],
    ['Booth Type',   s.booth_type    || boothType],
    ['Total Items',  s.estimated_items || (items.length + ' items')]
  ];
  if (s.key_features && s.key_features.length) {
    rows.push(['Key Features', s.key_features.join(' · ')]);
  }
  document.getElementById('summary-rows').innerHTML = rows.map(function(row) {
    return '<div class="summary-row"><span>' + escHtml(row[0]) + '</span><strong>' + escHtml(row[1]) + '</strong></div>';
  }).join('');

  if (!isRefinement) {
    imagePrompt = r.image_prompt || '';
    currentRenderDataUrl = null;
    document.getElementById('render-btn').disabled          = !imagePrompt;
    document.getElementById('render-idle').style.display    = 'flex';
    document.getElementById('render-progress').style.display = 'none';
    document.getElementById('booth-render').style.display   = 'none';
    document.getElementById('render-actions').style.display = 'none';
    document.getElementById('render-error').style.display   = 'none';
  } else {
    if (r.image_prompt) imagePrompt = r.image_prompt;
  }

  // Render 2D floor plan
  var fpEl = document.getElementById('floorplan-svg');
  if (fpEl) fpEl.innerHTML = generateFloorPlanSVG(r.order_items, w, d, boothType);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Tab Switching ────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  document.querySelectorAll('.tab-pane').forEach(function(pane) {
    pane.classList.toggle('active', pane.id === 'tab-' + name);
  });
}

// ─── Chat Popup Toggle ────────────────────────────────────────────────────────
function toggleChatPopup() {
  var popup = document.getElementById('chat-popup');
  var isOpen = popup.style.display === 'flex';
  popup.style.display = isOpen ? 'none' : 'flex';
  if (!isOpen) {
    document.getElementById('fab-unread').style.display = 'none';
    document.getElementById('chat-input').focus();
    var h = document.getElementById('chat-history');
    h.scrollTop = h.scrollHeight;
  }
}

// ─── Share Link ───────────────────────────────────────────────────────────────
function shareBoothLink() {
  var data = {
    w:   document.getElementById('booth-width').value,
    d:   document.getElementById('booth-depth').value,
    sn:  document.getElementById('show-name').value,
    bt:  document.getElementById('booth-type').value,
    bn:  document.getElementById('booth-number').value,
    ind: document.getElementById('industry').value,
    bc:  document.getElementById('brand-colors').value,
    vis: document.getElementById('vision').value,
    vib: (document.querySelector('.vibe-chip.active') || {}).dataset && document.querySelector('.vibe-chip.active').dataset.val || ''
  };
  var encoded = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
  var url = location.origin + location.pathname + '#d=' + encoded;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(function() { showToast('Link copied to clipboard!', 'ok'); });
  } else {
    prompt('Copy this link:', url);
  }
}

// ─── Print / PDF ──────────────────────────────────────────────────────────────
function printBooth() {
  var subtitle = document.getElementById('results-subtitle').textContent;
  document.getElementById('print-subtitle').textContent = subtitle;
  window.print();
}

// ─── Restore from share link ──────────────────────────────────────────────────
(function restoreFromHash() {
  var hash = location.hash;
  if (!hash || !hash.startsWith('#d=')) return;
  try {
    var data = JSON.parse(decodeURIComponent(escape(atob(hash.slice(3)))));
    if (data.w)   document.getElementById('booth-width').value   = data.w;
    if (data.d)   document.getElementById('booth-depth').value   = data.d;
    if (data.sn)  document.getElementById('show-name').value     = data.sn;
    if (data.bt)  document.getElementById('booth-type').value    = data.bt;
    if (data.bn)  document.getElementById('booth-number').value  = data.bn;
    if (data.ind) document.getElementById('industry').value      = data.ind;
    if (data.bc)  document.getElementById('brand-colors').value  = data.bc;
    if (data.vis) document.getElementById('vision').value        = data.vis;
    if (data.vib) {
      document.querySelectorAll('.vibe-chip').forEach(function(c) {
        c.classList.toggle('active', c.dataset.val === data.vib);
      });
    }
    var vis = document.getElementById('vision');
    document.getElementById('gen-btn').disabled = !vis || vis.value.trim().length < 10;
    showToast('Booth configuration restored from shared link', 'ok');
  } catch(e) {}
})();

// ─── Chat Refinement ──────────────────────────────────────────────────────────
async function sendRefinement() {
  var input = document.getElementById('chat-input');
  var msg   = input.value.trim();
  if (!msg || !conversationHistory.length) return;

  appendChatBubble('user', msg);
  input.value = '';

  var thinkingEl = appendChatBubble('thinking', 'Updating your booth design...');
  document.getElementById('chat-send-btn').disabled = true;

  var w = document.getElementById('booth-width').value  || 'unspecified';
  var d = document.getElementById('booth-depth').value  || 'unspecified';

  var refinementMsg = {
    role: 'user',
    content: msg + '\\n\\nReturn the COMPLETE updated booth design in the exact same JSON structure. Every field is required. IMPORTANT for image_prompt: keep the SAME booth aesthetic, color scheme, materials, and overall visual style as before — only incorporate the specific changes just requested. Do NOT redesign the booth from scratch in the image_prompt.'
  };
  conversationHistory.push(refinementMsg);

  try {
    var r = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: buildSystemPrompt(w, d, document.getElementById('booth-number').value || ''),
        messages: conversationHistory
      })
    });
    var data = await r.json();
    if (!r.ok) {
      var errMsg = (data.error && data.error.message) ? data.error.message : JSON.stringify(data.error || data);
      throw new Error(errMsg);
    }
    var text    = (data.content && data.content[0] && data.content[0].text) ? data.content[0].text : '';
    var concept = parseJSONResponse(text);
    conversationHistory.push({ role: 'assistant', content: text });

    thinkingEl.remove();
    appendChatBubble('assistant', 'Done! Booth updated.');

    renderConcept(concept,
      document.getElementById('show-name').value  || '',
      w, d,
      document.getElementById('booth-type').value || '',
      true
    );
    // Rebuild negative prompt and prepend exact furniture counts from updated order list
    imageNegativePrompt = buildNegativePrompt(concept.order_items);
    if (imagePrompt) imagePrompt = buildFurniturePrefix(concept.order_items) + imagePrompt + '. Specifically include: ' + msg;
    document.getElementById('rerender-bar').style.display = 'flex';
    appendChatBubble('assistant', 'Click » Re-render « above to see the updated image.');
  } catch(e) {
    thinkingEl.remove();
    appendChatBubble('assistant', 'Error: ' + e.message.slice(0, 150));
    conversationHistory.pop();
    showToast('Refinement failed: ' + e.message.slice(0, 100), 'error');
  }

  document.getElementById('chat-send-btn').disabled = false;
}

function appendChatBubble(cls, text) {
  var h   = document.getElementById('chat-history');
  var div = document.createElement('div');
  div.className   = 'chat-bubble ' + cls;
  div.textContent = text;
  h.appendChild(div);
  h.scrollTop = h.scrollHeight;
  if (cls === 'assistant' && document.getElementById('chat-popup').style.display !== 'flex') {
    document.getElementById('fab-unread').style.display = 'block';
  }
  return div;
}

document.getElementById('chat-send-btn').addEventListener('click', sendRefinement);
document.getElementById('chat-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendRefinement(); }
});

// ─── Stability AI Image Generation ───────────────────────────────────────────
async function generateImage() {
  if (!imagePrompt) { showToast('Generate a booth concept first', 'warn'); return; }

  document.getElementById('render-idle').style.display     = 'none';
  document.getElementById('render-progress').style.display = 'flex';
  document.getElementById('render-error').style.display    = 'none';
  document.getElementById('booth-render').style.display    = 'none';
  document.getElementById('render-actions').style.display  = 'none';
  document.getElementById('rerender-bar').style.display    = 'none';
  document.getElementById('render-status').textContent     = 'Generating with Stable Image Ultra...';

  try {
    var r = await fetch('/api/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: imagePrompt, negative_prompt: imageNegativePrompt })
    });
    var data = await r.json();
    if (!r.ok || !data.image_b64) throw new Error(data.error || 'No image data returned from Stability AI');

    var dataUrl = 'data:' + data.content_type + ';base64,' + data.image_b64;
    currentRenderDataUrl = dataUrl;

    var img = document.getElementById('booth-render');
    img.src = dataUrl;
    img.style.display = 'block';

    document.getElementById('render-progress').style.display = 'none';
    document.getElementById('render-idle').style.display     = 'flex';
    document.getElementById('render-actions').style.display  = 'flex';
  } catch(e) {
    document.getElementById('render-progress').style.display = 'none';
    document.getElementById('render-idle').style.display     = 'flex';
    var errEl = document.getElementById('render-error');
    errEl.innerHTML = '<strong>Render failed:</strong> ' + escHtml(e.message) +
      '<br><small style="color:#7f1d1d;opacity:.8">Check your Stability AI key and credits at platform.stability.ai</small>';
    errEl.style.display = 'block';
  }
}

function downloadRender() {
  if (!currentRenderDataUrl) return;
  var a = document.createElement('a');
  a.href     = currentRenderDataUrl;
  a.download = 'booth-render.jpg';
  a.click();
}

// ─── Loading / Toast ──────────────────────────────────────────────────────────
var _loadingTimer = null;
function showLoading() {
  document.getElementById('loading-overlay').style.display = 'flex';
  document.getElementById('gen-btn').disabled = true;
  var msgs = [
    'Transforming vision into a booth layout',
    'Deploying AI design intelligence',
    'Engineering your exhibit space',
    'Activating booth construction protocols',
    'Assembling trade show assets'
  ];
  var idx = 0;
  document.getElementById('ls2').textContent = '● ' + msgs[0];
  _loadingTimer = setInterval(function() {
    idx = (idx + 1) % msgs.length;
    document.getElementById('ls2').textContent = '● ' + msgs[idx];
  }, 2200);
}
function hideLoading() {
  if (_loadingTimer) { clearInterval(_loadingTimer); _loadingTimer = null; }
  document.getElementById('loading-overlay').style.display = 'none';
  document.getElementById('gen-btn').disabled = visionEl.value.trim().length < 10;
}
function showToast(msg, type) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  var c = type === 'error' ? ['rgba(8,14,22,.97)','#ff6060','rgba(255,80,80,.3)']
        : type === 'ok'    ? ['rgba(8,14,22,.97)','#00e676','rgba(0,230,118,.3)']
        :                    ['rgba(8,14,22,.97)','#FF6B00','rgba(255,107,0,.3)'];
  t.style.background = c[0];
  t.style.color      = c[1];
  t.style.border     = '1px solid ' + c[2];
  t.style.display    = 'block';
  clearTimeout(t._t);
  t._t = setTimeout(function() { t.style.display = 'none'; }, 5000);
}

// ─── Reset ────────────────────────────────────────────────────────────────────
document.getElementById('reset-btn').addEventListener('click', function() {
  document.getElementById('results-panel').style.display = 'none';
  document.getElementById('empty-state').style.display   = 'flex';
  document.getElementById('chat-fab').style.display    = 'none';
  document.getElementById('chat-popup').style.display  = 'none';
  document.getElementById('chat-history').innerHTML      = '';
  document.getElementById('rerender-bar').style.display  = 'none';
  conversationHistory    = [];
  imagePrompt            = '';
  currentRenderDataUrl   = null;
});
</script>
</body>
</html>`;

// ─── LOGIN PAGE ────────────────────────────────────────────────────────────────
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Restricted Access — GES Booth Visualizer</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Courier New',monospace;background:#060810;min-height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden;}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(255,107,0,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(255,107,0,.06) 1px,transparent 1px);background-size:44px 44px;pointer-events:none;}
body::after{content:'';position:fixed;top:-2px;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#FF6B00 50%,transparent);animation:scan 5s linear infinite;opacity:.45;pointer-events:none;}
@keyframes scan{from{top:-2px;}to{top:100vh;}}

.panel{background:linear-gradient(160deg,#0f1420 0%,#080c14 100%);border:1px solid rgba(255,107,0,.28);border-radius:4px;padding:40px 44px;width:430px;position:relative;box-shadow:0 0 60px rgba(255,107,0,.07),0 0 120px rgba(255,107,0,.03),inset 0 0 60px rgba(0,0,0,.4);}
.c-tl,.c-tr,.c-bl,.c-br{position:absolute;width:16px;height:16px;border-color:#FF6B00;border-style:solid;opacity:.75;}
.c-tl{top:-1px;left:-1px;border-width:2px 0 0 2px;}
.c-tr{top:-1px;right:-1px;border-width:2px 2px 0 0;}
.c-bl{bottom:-1px;left:-1px;border-width:0 0 2px 2px;}
.c-br{bottom:-1px;right:-1px;border-width:0 2px 2px 0;}

.symbol-wrap{text-align:center;margin-bottom:22px;animation:flicker 7s infinite;}
@keyframes flicker{0%,100%{opacity:1}91%{opacity:1}92%{opacity:.55}94%{opacity:1}97%{opacity:.75}98%{opacity:1}}
.symbol-wrap svg{width:88px;height:88px;filter:drop-shadow(0 0 14px rgba(255,107,0,.55));}

.eyeglow{animation:eyepulse 2.5s ease-in-out infinite;}
@keyframes eyepulse{0%,100%{opacity:.65}50%{opacity:1}}

.top-label{text-align:center;font-size:9px;letter-spacing:4px;color:rgba(255,107,0,.55);text-transform:uppercase;margin-bottom:8px;}
.divider{display:flex;align-items:center;gap:10px;margin-bottom:6px;}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:rgba(255,107,0,.2);}
.divider-text{font-size:20px;font-weight:700;letter-spacing:4px;color:#FF6B00;white-space:nowrap;text-shadow:0 0 24px rgba(255,107,0,.7);}
.subtitle-line{display:flex;align-items:center;gap:10px;margin-bottom:20px;}
.subtitle-line::before,.subtitle-line::after{content:'';flex:1;height:1px;background:rgba(255,107,0,.2);}
.subtitle-line span{font-size:9px;letter-spacing:2px;color:rgba(255,107,0,.4);white-space:nowrap;}

.desc{font-size:11px;color:rgba(200,185,165,.45);text-align:center;line-height:1.7;margin-bottom:26px;font-family:system-ui,sans-serif;letter-spacing:.3px;}
.desc strong{color:rgba(255,107,0,.75);font-weight:600;}

.field-label{font-size:9px;letter-spacing:2.5px;color:rgba(255,107,0,.55);text-transform:uppercase;margin-bottom:7px;display:block;}
.code-wrap{position:relative;}
.code-input{width:100%;background:rgba(0,0,0,.55);border:1px solid rgba(255,107,0,.22);border-radius:3px;padding:12px 14px 12px 42px;color:#FF6B00;font-family:'Courier New',monospace;font-size:15px;letter-spacing:4px;outline:none;transition:border-color .2s,box-shadow .2s;text-align:left;}
.code-input::placeholder{color:rgba(255,107,0,.18);letter-spacing:2px;font-size:11px;}
.code-input:focus{border-color:rgba(255,107,0,.55);box-shadow:0 0 14px rgba(255,107,0,.1);}
.input-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:rgba(255,107,0,.4);font-size:13px;pointer-events:none;}

.error-msg{font-size:10px;color:#ff4a4a;letter-spacing:2px;text-transform:uppercase;margin-top:8px;min-height:16px;opacity:0;transition:opacity .25s;text-align:center;}
.error-msg.show{opacity:1;}

.submit-btn{width:100%;margin-top:18px;padding:13px;background:transparent;border:1px solid rgba(255,107,0,.42);border-radius:3px;color:#FF6B00;font-family:'Courier New',monospace;font-size:11px;font-weight:700;letter-spacing:5px;text-transform:uppercase;cursor:pointer;transition:all .2s;position:relative;overflow:hidden;}
.submit-btn::after{content:'';position:absolute;inset:0;background:rgba(255,107,0,0);transition:background .2s;}
.submit-btn:hover{border-color:#FF6B00;box-shadow:0 0 22px rgba(255,107,0,.2);}
.submit-btn:hover::after{background:rgba(255,107,0,.08);}
.submit-btn:disabled{opacity:.4;cursor:not-allowed;}
.submit-btn.granted{border-color:#00e676;color:#00e676;box-shadow:0 0 22px rgba(0,230,118,.2);}

.footer-label{margin-top:24px;font-size:9px;letter-spacing:2px;color:rgba(255,107,0,.2);text-align:center;text-transform:uppercase;}
</style>
</head>
<body>
<div class="panel">
  <div class="c-tl"></div><div class="c-tr"></div><div class="c-bl"></div><div class="c-br"></div>

  <div class="symbol-wrap">
    <svg viewBox="0 0 120 128" xmlns="http://www.w3.org/2000/svg">
      <polygon points="60,2 49,19 71,19" fill="#FF6B00"/>
      <rect x="57" y="15" width="6" height="9" fill="#FF6B00"/>
      <path d="M17,32 L31,21 L89,21 L103,32 L103,87 L89,99 L70,108 L50,108 L31,99 L17,87 Z" fill="#0a0e18" stroke="#FF6B00" stroke-width="2"/>
      <rect x="5" y="43" width="12" height="23" rx="1" fill="#FF6B00"/>
      <rect x="103" y="43" width="12" height="23" rx="1" fill="#FF6B00"/>
      <rect x="27" y="46" width="27" height="13" rx="3" fill="#FF6B00"/>
      <rect x="66" y="46" width="27" height="13" rx="3" fill="#FF6B00"/>
      <rect x="31" y="49" width="19" height="7" rx="2" fill="#FFD000" opacity=".0" class="eyeglow" style="fill:#FFD000"/>
      <rect x="70" y="49" width="19" height="7" rx="2" fill="#FFD000" class="eyeglow" style="fill:#FFD000"/>
      <rect x="53" y="64" width="14" height="7" rx="1" fill="#FF6B00" opacity=".45"/>
      <rect x="31" y="77" width="58" height="21" rx="2" fill="none" stroke="#FF6B00" stroke-width="1.5"/>
      <line x1="31" y1="84" x2="89" y2="84" stroke="#FF6B00" stroke-width=".7" opacity=".55"/>
      <line x1="31" y1="90" x2="89" y2="90" stroke="#FF6B00" stroke-width=".7" opacity=".55"/>
      <line x1="45" y1="77" x2="45" y2="98" stroke="#FF6B00" stroke-width=".7" opacity=".55"/>
      <line x1="60" y1="77" x2="60" y2="98" stroke="#FF6B00" stroke-width=".7" opacity=".55"/>
      <line x1="75" y1="77" x2="75" y2="98" stroke="#FF6B00" stroke-width=".7" opacity=".55"/>
    </svg>
  </div>

  <div class="top-label">GES Booth Visualizer &mdash; Hackathon 2026</div>
  <div class="divider"><span class="divider-text">RESTRICTED</span></div>
  <div class="subtitle-line"><span>&#9654; AUTHORIZED ACCESS ONLY &#9654;</span></div>

  <p class="desc"><strong>Only permitted users are allowed.</strong><br>This system is reserved for TradeTech Transformers.<br>Enter your access code to proceed.</p>

  <label class="field-label">Enter your access code</label>
  <div class="code-wrap">
    <span class="input-icon">&#9679;</span>
    <input type="password" class="code-input" id="code-input" placeholder="enter access code..." autocomplete="off" maxlength="60">
  </div>
  <div class="error-msg" id="error-msg">&#9654; INVALID CODE &mdash; ACCESS DENIED</div>

  <button class="submit-btn" id="submit-btn">&#9654;&nbsp;&nbsp;Authenticate&nbsp;&nbsp;&#9664;</button>

  <div class="footer-label">TradeTech Transformers &bull; Transform &bull; Adapt &bull; Prevail</div>
</div>
<script>
var inp = document.getElementById('code-input');
var err = document.getElementById('error-msg');
var btn = document.getElementById('submit-btn');
inp.addEventListener('keydown', function(e){ if(e.key==='Enter') auth(); err.classList.remove('show'); });
btn.addEventListener('click', auth);
async function auth() {
  var code = inp.value.trim();
  if (!code) { inp.focus(); return; }
  btn.disabled = true;
  btn.textContent = 'AUTHENTICATING...';
  try {
    var r = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:code}) });
    var d = await r.json();
    if (d.ok) {
      btn.textContent = '✓  ACCESS GRANTED  ✓';
      btn.classList.add('granted');
      setTimeout(function(){ location.reload(); }, 700);
    } else {
      err.textContent = '▶ INVALID CODE — ACCESS DENIED';
      err.classList.add('show');
      inp.value = '';
      inp.focus();
      btn.disabled = false;
      btn.textContent = '▶  Authenticate  ◀';
    }
  } catch(e) {
    err.textContent = '▶ CONNECTION ERROR — RETRY';
    err.classList.add('show');
    btn.disabled = false;
    btn.textContent = '▶  Authenticate  ◀';
  }
}
</script>
</body>
</html>`;

// ─── SERVER ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Static: GES logo (no auth needed) ───────────────────────────────────────
  if (req.method === 'GET' && req.url === '/logo.webp') {
    fs.readFile(path.join(__dirname, 'GES-logo.webp'), (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
    return;
  }

  // ── SPA: show login or app depending on auth ─────────────────────────────────
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(isAuthenticated(req) ? HTML : LOGIN_HTML);
    return;
  }

  // ── Parse POST body (10 MB limit) ───────────────────────────────────────────
  const chunks = [];
  let bodySize = 0;
  const bodyOk = await new Promise(r => {
    req.on('data', c => { bodySize += c.length; if (bodySize > 10_000_000) { req.destroy(); r(false); } else chunks.push(c); });
    req.on('end', () => r(true));
  });
  if (!bodyOk) { res.writeHead(413); res.end('Payload too large'); return; }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); }
  catch(e) { send(res, 400, { error: 'Invalid JSON body' }); return; }

  // ── Login ────────────────────────────────────────────────────────────────────
  if (req.url === '/api/login') {
    if (body.password === APP_PASSWORD) {
      const token = createSession();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'ges_session=' + token + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400'
      });
      res.end(JSON.stringify({ ok: true }));
    } else {
      send(res, 401, { ok: false });
    }
    return;
  }

  // ── All other API routes require auth ────────────────────────────────────────
  if (!isAuthenticated(req)) { send(res, 401, { error: 'Unauthorized' }); return; }

  // ── Rate limit ───────────────────────────────────────────────────────────────
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  if (isRateLimited(ip)) { send(res, 429, { error: 'Too many requests — please wait a moment' }); return; }

  // ── Claude proxy ─────────────────────────────────────────────────────────────
  if (req.url === '/api/claude') {
    const apiKey = body.__api_key || process.env.ANTHROPIC_API_KEY || '';
    delete body.__api_key;
    if (!apiKey) { send(res, 400, { error: { message: 'Missing Anthropic API key — set ANTHROPIC_API_KEY env var or enter it in API Keys' } }); return; }
    try {
      console.log('  Claude -> model:', body.model, '| messages:', body.messages && body.messages.length);
      const r = await httpsPost('api.anthropic.com', '/v1/messages',
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body);
      console.log('  Claude <-', r.status);
      if (r.body && r.body.content && r.body.content[0]) {
        const preview = r.body.content[0].text || '';
        console.log('  Claude response preview (first 500 chars):\n' + preview.slice(0, 500));
        console.log('  Claude response length:', preview.length, '| stop_reason:', r.body.stop_reason);
      }
      send(res, r.status, r.body);
    } catch(e) {
      console.error('  Claude error:', e.message);
      send(res, 502, { error: { message: e.message } });
    }
    return;
  }

  // ── Stability AI proxy ───────────────────────────────────────────────────────
  if (req.url === '/api/image') {
    const apiKey = body.__stability_key || process.env.STABILITY_API_KEY || '';
    const { prompt, negative_prompt } = body;
    if (!apiKey) { send(res, 400, { error: 'Missing Stability AI API key — set STABILITY_API_KEY env var or enter it in API Keys' }); return; }
    if (!prompt)  { send(res, 400, { error: 'Missing image prompt' }); return; }
    try {
      console.log('  Stability AI -> submitting...');
      if (negative_prompt) console.log('  Stability AI negative prompt:', negative_prompt.slice(0, 120));
      const r = await stabilityPost(apiKey, prompt, negative_prompt);
      if (r.status !== 200 || !r.body.image) {
        const errMsg = (r.body.errors && r.body.errors[0]) ? r.body.errors[0]
          : (r.body.message || JSON.stringify(r.body));
        console.error('  Stability AI error:', errMsg);
        send(res, r.status, { error: errMsg }); return;
      }
      console.log('  Stability AI -> done, finish_reason:', r.body.finish_reason);
      send(res, 200, { image_b64: r.body.image, content_type: 'image/jpeg' });
    } catch(e) {
      console.error('  Stability AI error:', e.message);
      send(res, 500, { error: e.message });
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  +--------------------------------------+');
  console.log('  |   GES Booth Visualizer v2            |');
  console.log('  |   http://localhost:' + PORT + '              |');
  console.log('  +--------------------------------------+');
  console.log('');
  console.log('  Open the URL above in your browser.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
