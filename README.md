# GES Booth Visualizer

**AI-Powered Trade Show Booth Design Tool**
*GES (Global Experience Specialists) — TradeTech Transformers Hackathon 2026*

---

## Overview

The GES Booth Visualizer is a password-protected, single-page web application that lets trade show exhibitors design their booth using plain language. Users describe their booth dimensions, industry, style, and vision — the app then uses AI to produce:

- A written booth concept (layout narrative, visitor flow, hero element)
- A photorealistic rendered image of the booth (16:9 JPEG)
- A detailed, itemized equipment and furniture order list (8–14 line items)
- A summary card with key booth facts and a link to the GES Store

After the initial concept is generated, users can refine it through a chat interface ("Add 2 chairs", "Make it more premium") and re-render the image as many times as needed. Concepts can be shared via a URL or exported as a PDF.

---

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  BROWSER  (Vanilla HTML / CSS / JavaScript)                         │
│                                                                     │
│   Login Screen ──► Main SPA                                         │
│     Form inputs       ├── Concept tab   (AI design narrative)       │
│     Reference photo   ├── Orders tab    (itemized equipment list)   │
│     Chat refinement   └── Summary tab  (key facts + GES Store link) │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  HTTP (TLS terminated by reverse proxy)
┌──────────────────────────────▼──────────────────────────────────────┐
│  NODE.JS SERVER  (server.js — single file, Node built-ins only)     │
│                                                                     │
│   • Cookie-based session auth   (in-memory, 24-hour expiry)         │
│   • Per-IP rate limiter         (20 API req/IP/min)                 │
│   • CORS allowlist              (fixed set of origins)              │
│   • GET  /                      serves login HTML or main SPA       │
│   • GET  /logo.webp             serves static GES logo              │
│   • POST /api/login             validates password, sets cookie     │
│   • POST /api/claude            reverse proxy → Anthropic API       │
│   • POST /api/image             reverse proxy → Stability AI API    │
└────────────────┬────────────────────────────┬───────────────────────┘
                 │                            │
  ┌──────────────▼──────────────┐  ┌──────────▼──────────────────────┐
  │  ANTHROPIC API              │  │  STABILITY AI API               │
  │  claude-sonnet-4-6          │  │  stable-image/generate/ultra    │
  │  Returns: JSON concept      │  │  Returns: base64 JPEG (16:9)    │
  │  (concept, order_items,     │  │  Photorealistic booth render    │
  │   image_prompt, tips,       │  │                                 │
  │   summary)                  │  │                                 │
  └─────────────────────────────┘  └─────────────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|---|---|
| Backend runtime | Node.js >= 18 (built-in modules only — no npm packages) |
| Frontend | Vanilla HTML5, CSS3, JavaScript (no framework, no build step) |
| AI — concept generation | Anthropic Claude Sonnet (`claude-sonnet-4-6`) |
| AI — image rendering | Stability AI Stable Image Ultra |
| Authentication | Shared password + in-memory cookie sessions |
| Deployment target | Azure App Service (reads `PORT` env var automatically) |
| TLS termination | Azure App Service / reverse proxy layer |

> **Note:** The entire application — server, authentication, API proxies, and the frontend SPA — lives in a single file (`server.js`, ~1,600 lines). There are zero npm dependencies and no build or compilation step.

---

## Data Flow

1. **Input** — User fills the booth form (dimensions, type, industry, brand colors, style vibe, free-text vision, and an optional reference photo encoded as base64).

2. **Concept generation** — Browser POSTs to `/api/claude`. The server proxies the request to the Anthropic API with a system prompt defining it as a certified GES booth design expert. Claude returns a structured JSON object: `{ concept, image_prompt, design_tips, order_items[], summary }`.

3. **Results display** — The written concept, design tips, order list, and summary are displayed across three tabs.

4. **Image render** — User clicks "Visualize My Booth". The browser POSTs the AI-generated `image_prompt` to `/api/image`. The server proxies it to Stability AI. The resulting base64 JPEG is displayed inline.

5. **Refinement (optional)** — The user types a change in the chat popup. The full conversation history is re-POSTed to `/api/claude`, which returns an updated JSON concept. The user can then re-render the image.

6. **Share / Export** — The user can share a URL (all form state base64-encoded in the URL hash), export to PDF via `window.print()`, or start over.

---

## Repository Structure

```
BoothVisualizer/
├── server.js         — Entire application: Node HTTP server, session auth,
│                       rate limiter, API proxy routes, and the complete
│                       frontend SPA (HTML/CSS/JS) as an embedded string
├── GES-logo.webp     — GES brand logo, served statically at /logo.webp
├── package.json      — App metadata; declares Node >= 18 and start script
├── .env              — Local environment variables (NOT committed to git)
├── .gitignore        — Excludes .env, node_modules, logs, Office docs
└── README.md         — This file
```

---

## Prerequisites

- **Node.js >= 18.0.0** — verify with `node --version`
- **Anthropic API key** — for Claude Sonnet concept generation
- **Stability AI API key** — for photorealistic booth image rendering
- **APP_PASSWORD** — a shared passcode of your choice that gates app access

> No `npm install` is required. The application has zero npm dependencies.

---

## Environment Variables

Create a `.env` file in the project root (same directory as `server.js`). The server reads this file automatically on startup.

| Variable | Required | Description |
|---|:---:|---|
| `APP_PASSWORD` | **Yes** | Shared passcode for the login screen. The server exits on startup if this is missing or empty. |
| `ANTHROPIC_API_KEY` | **Yes** | API key for the Anthropic Claude API. Required for booth concept generation and chat refinement. |
| `STABILITY_API_KEY` | **Yes** | API key for the Stability AI API. Required for photorealistic booth image rendering. |
| `PORT` | No | HTTP listen port. Defaults to `3000`. Azure App Service sets this automatically — do not set it in production. |

**Example `.env` file:**

```env
APP_PASSWORD=YourSecurePassphraseHere
ANTHROPIC_API_KEY=sk-ant-...
STABILITY_API_KEY=sk-...
PORT=3000
```

> **Important:** Never commit `.env` to source control — it is listed in `.gitignore`. For Azure deployments, set these as Application Settings in the App Service Configuration panel instead.

---

## Running Locally

1. **Clone the repository**
   ```bash
   git clone <repo-url>
   cd BoothVisualizer
   ```

2. **Create the `.env` file** with your API keys (see Environment Variables above).

3. **Start the server**
   ```bash
   node server.js
   ```

4. **Open the application** at [http://localhost:3000](http://localhost:3000) and log in with `APP_PASSWORD`.

The server is ready immediately after printing:
```
GES Booth Visualizer v2 running at http://localhost:3000
```

---

## Deploying to Azure App Service

The application is designed for zero-configuration deployment to Azure App Service on a Node.js runtime. Azure automatically sets `PORT` and handles TLS termination.

### Step 1 — Provision an App Service

- **Runtime stack:** Node 18 LTS (Linux)
- **Pricing tier:** B1 or higher (the F1 free tier has CPU limits that may cause timeouts during AI image generation)

### Step 2 — Configure Application Settings

In the Azure Portal → App Service → **Configuration → Application Settings**, add:

| Name | Value |
|---|---|
| `APP_PASSWORD` | Your chosen passcode |
| `ANTHROPIC_API_KEY` | `sk-ant-...` |
| `STABILITY_API_KEY` | `sk-...` |

Do **not** set `PORT` — Azure manages this automatically.

### Step 3 — Set the Startup Command

In **Configuration → General Settings → Startup Command**:

```
node server.js
```

### Step 4 — Deploy the Code

**Option A — Azure DevOps Pipeline (recommended)**

Add the following to `azure-pipelines.yml` in the repository root:

```yaml
trigger:
  - main

pool:
  vmImage: 'ubuntu-latest'

steps:
  - task: AzureWebApp@1
    inputs:
      azureSubscription: '<service connection>'
      appName: '<app service name>'
      package: '$(System.DefaultWorkingDirectory)'
      runtimeStack: 'NODE|18-lts'
      startUpCommand: 'node server.js'
```

**Option B — Azure CLI**

```bash
az webapp up \
  --name <app-name> \
  --resource-group <rg-name> \
  --runtime "NODE:18-lts" \
  --sku B1
```

**Option C — VS Code Azure App Service Extension**

Right-click the project folder and select **Deploy to Web App**.

### Step 5 — Update the CORS Allowlist

The CORS allowlist is hardcoded in `server.js` (search for `ALLOWED_ORIGINS`). Add your App Service hostname before deploying:

```
https://<your-app-name>.azurewebsites.net
```

### Step 6 — Verify

Navigate to `https://<your-app-name>.azurewebsites.net`, log in with `APP_PASSWORD`, and generate a test booth concept.

---

## API Endpoint Reference

| Method | Path | Auth | Description |
|---|---|:---:|---|
| `GET` | `/` | No | Serves the main SPA (authenticated) or login page (unauthenticated) |
| `GET` | `/logo.webp` | No | Serves the GES logo static file (`Cache-Control: public, max-age=86400`) |
| `POST` | `/api/login` | No | Validates password; sets `ges_session` cookie on success |
| `POST` | `/api/claude` | Yes | Proxies request to Anthropic API; rate limited (20 req/IP/min) |
| `POST` | `/api/image` | Yes | Proxies request to Stability AI; returns `{ image_b64, content_type }` |

**HTTP status codes used:** `200`, `204` (CORS preflight), `400`, `401`, `404`, `413` (body > 10 MB), `429` (rate limit), `502` (upstream API error)

---

## Security Model

| Concern | Implementation |
|---|---|
| Session cookie | `HttpOnly`, `Secure`, `SameSite=Strict`, 24-hour `Max-Age` |
| Session storage | In-memory `Map` keyed by 32-byte random hex token |
| Rate limiting | 20 API requests per IP per 60-second window (in-memory) |
| API key protection | Keys stored server-side only; never sent to the browser |
| CORS | `Access-Control-Allow-Origin` set only for origins in `ALLOWED_ORIGINS` |
| TLS | Plain HTTP from Node.js; HTTPS terminated by Azure App Service |
| Body size | POST bodies capped at 10 MB; returns `413` if exceeded |

---

## Known Limitations

- **In-memory sessions and rate limits** — Lost on server restart. Scaling to multiple App Service instances would require an external session store (e.g., Azure Cache for Redis).
- **No conversation persistence** — Chat history lives in the browser's JavaScript memory. Refreshing the page loses the conversation.
- **Single shared password** — All users share one `APP_PASSWORD`. There is no per-user authentication, roles, or audit trail.
- **No database** — The application is fully stateless beyond in-memory maps.
- **Hardcoded CORS allowlist** — Adding a new hostname (e.g., a new App Service URL) requires editing `server.js` and redeploying.

---

*Questions? Contact the TradeTech Transformers team.*
