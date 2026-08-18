================================================================================
  GES BOOTH VISUALIZER  |  v2.0.0
  AI-Powered Trade Show Booth Design Tool
  GES (Global Experience Specialists) — TradeTech Transformers Hackathon 2026
================================================================================

TABLE OF CONTENTS
-----------------
  1.  Project Overview
  2.  High-Level Architecture
  3.  Data Flow
  4.  Repository Structure
  5.  Prerequisites
  6.  Environment Variables
  7.  Running Locally
  8.  Deploying to Azure App Service
  9.  API Endpoint Reference
  10. Security Model
  11. Known Limitations


================================================================================
  1. PROJECT OVERVIEW
================================================================================

The GES Booth Visualizer is a password-protected, single-page web application
that lets trade show exhibitors design their booth using plain language. Users
describe their booth dimensions, industry, style, and vision — the app then
uses AI to produce:

  • A written booth concept (layout narrative, visitor flow, hero element)
  • A photorealistic rendered image of the booth (16:9 JPEG)
  • A detailed, itemized equipment and furniture order list (8–14 line items)
  • A summary card with key booth facts and a link to the GES Store

After the initial concept is generated, users can refine it through a chat
interface ("Add 2 chairs", "Make it more premium") and re-render the image
as many times as needed. Concepts can be shared via a URL or exported as a PDF.


================================================================================
  2. HIGH-LEVEL ARCHITECTURE
================================================================================

The application is a zero-dependency, single-file Node.js server. There are
no npm packages, no build step, and no compiled assets.

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  BROWSER  (Vanilla HTML / CSS / JavaScript)                             │
  │                                                                         │
  │   Login Screen ──► Main SPA                                             │
  │     Form inputs       ├── Concept tab   (AI-generated design narrative) │
  │     Reference photo   ├── Orders tab    (itemized equipment list)       │
  │     Chat refinement   └── Summary tab  (key facts + GES Store link)     │
  └───────────────────────────────┬─────────────────────────────────────────┘
                                  │  HTTP (plain text over TLS via reverse proxy)
  ┌───────────────────────────────▼─────────────────────────────────────────┐
  │  NODE.JS SERVER  (server.js — single file, Node built-ins only)         │
  │                                                                         │
  │   • http.createServer()     — routes all traffic                        │
  │   • Auth gate               — cookie-based session (in-memory Map)      │
  │   • Rate limiter            — 20 API req/IP/min (in-memory Map)         │
  │   • CORS allowlist          — fixed set of origins                      │
  │   • GET  /                  — serves login HTML or main SPA HTML        │
  │   • GET  /logo.webp         — serves static GES logo                    │
  │   • POST /api/login         — validates password, sets session cookie   │
  │   • POST /api/claude        — reverse proxy → Anthropic API             │
  │   • POST /api/image         — reverse proxy → Stability AI API          │
  └──────────────┬───────────────────────────┬────────────────────────────--┘
                 │                           │
  ┌──────────────▼───────────┐  ┌────────────▼──────────────────────────────┐
  │  ANTHROPIC  API          │  │  STABILITY AI  API                        │
  │  api.anthropic.com       │  │  api.stability.ai                         │
  │  Model: claude-sonnet-4-6│  │  Endpoint: stable-image/generate/ultra    │
  │  Returns: JSON concept   │  │  Returns: base64-encoded JPEG             │
  │  (concept, order_items,  │  │  Aspect ratio: 16:9                       │
  │   image_prompt, tips,    │  │                                           │
  │   summary)               │  │                                           │
  └──────────────────────────┘  └───────────────────────────────────────────┘

Tech Stack
----------
  Backend runtime  : Node.js >= 18  (built-in modules only — http, https,
                     fs, path, crypto)
  Frontend         : Vanilla HTML5, CSS3, JavaScript (no framework)
  AI (text)        : Anthropic Claude Sonnet (claude-sonnet-4-6)
                     max_tokens: 8192, structured JSON output
  AI (images)      : Stability AI Stable Image Ultra
                     16:9 JPEG, photorealistic trade show renders
  Authentication   : Shared password + in-memory cookie sessions (24 h)
  Deployment       : Azure App Service (reads PORT env var automatically)
  TLS termination  : Handled by Azure App Service / reverse proxy layer


================================================================================
  3. DATA FLOW
================================================================================

  Step 1 — User fills the booth input form (dimensions, type, industry,
           brand colors, style vibe, free-text vision, optional reference
           photo encoded as base64).

  Step 2 — Browser POSTs to /api/claude. The server proxies the request to
           the Anthropic API with a system prompt defining it as a certified
           GES booth design expert. Claude returns a JSON structure:
             { concept, image_prompt, design_tips, order_items[], summary }

  Step 3 — Browser displays the concept, tips, orders, and summary across
           three result tabs.

  Step 4 — User clicks "Visualize My Booth". Browser POSTs the AI-generated
           image_prompt to /api/image. The server proxies it to Stability AI
           using multipart/form-data. The response is a base64 JPEG displayed
           inline.

  Step 5 — (Optional) User types a refinement message in the chat popup.
           The full conversation history is re-POSTed to /api/claude, which
           returns a fully updated JSON concept. The UI updates in place.
           User can then re-render the image.

  Step 6 — User can Share (URL hash encodes all form state as base64 JSON),
           Export PDF (window.print() with print CSS), or Start Over.


================================================================================
  4. REPOSITORY STRUCTURE
================================================================================

  BoothVisualizer/
  ├── server.js         — ENTIRE APPLICATION: Node HTTP server, session auth,
  │                       rate limiter, API proxy routes, and the complete
  │                       frontend SPA (HTML/CSS/JS) as an embedded string
  ├── GES-logo.webp     — GES brand logo, served statically at /logo.webp
  ├── package.json      — App metadata; declares Node >= 18, start script
  ├── .env              — Local environment variables (NOT committed to git)
  ├── .gitignore        — Excludes .env, node_modules, logs, Office docs
  └── README.txt        — This file


================================================================================
  5. PREREQUISITES
================================================================================

  • Node.js >= 18.0.0
      Verify: node --version
      Download: https://nodejs.org/

  • An Anthropic API key
      Used to call the Claude Sonnet model for booth concept generation.
      Obtain at: https://console.anthropic.com/

  • A Stability AI API key
      Used to generate photorealistic booth images.
      Obtain at: https://platform.stability.ai/

  • An APP_PASSWORD of your choice
      A shared password that gates access to the application. You set this
      value — any non-empty string is valid (e.g. a random 16-char phrase).

  • No package installation required
      The application has zero npm dependencies. Do NOT run npm install.


================================================================================
  6. ENVIRONMENT VARIABLES
================================================================================

  Create a file named .env in the project root (same directory as server.js).
  The server reads this file automatically on startup.

  Variable              Required   Description
  ─────────────────────────────────────────────────────────────────────────────
  APP_PASSWORD          YES        Shared passcode shown to all users on the
                                   login screen. The server exits with an error
                                   if this variable is missing or empty.

  ANTHROPIC_API_KEY     YES        API key for the Anthropic Claude API.
                                   Required to generate booth concepts and
                                   process chat refinements.

  STABILITY_API_KEY     YES        API key for the Stability AI API.
                                   Required to render photorealistic booth
                                   images.

  PORT                  No         HTTP port the server listens on.
                                   Defaults to 3000 if not set.
                                   Azure App Service sets this automatically.
  ─────────────────────────────────────────────────────────────────────────────

  Example .env file:
  ------------------
    APP_PASSWORD=YourSecurePassphraseHere
    ANTHROPIC_API_KEY=sk-ant-...
    STABILITY_API_KEY=sk-...
    PORT=3000

  IMPORTANT: Never commit the .env file to source control. It is listed in
  .gitignore. For Azure deployments, set these as Application Settings in the
  App Service Configuration panel instead of using a .env file.


================================================================================
  7. RUNNING LOCALLY
================================================================================

  1. Clone the repository
       git clone <repo-url>
       cd BoothVisualizer

  2. Create the .env file
       Copy the example from Section 6 above and fill in your real API keys.

  3. Start the server
       node server.js

  4. Open the application
       Navigate to http://localhost:3000 in your browser.
       Enter the APP_PASSWORD you set in .env.

  There is no build step, no npm install, and no compilation required.
  The server is ready immediately after "node server.js" outputs:

    GES Booth Visualizer v2 running at http://localhost:3000


================================================================================
  8. DEPLOYING TO AZURE APP SERVICE
================================================================================

  The application is designed for zero-configuration deployment to Azure App
  Service on a Node.js runtime. Azure automatically sets the PORT environment
  variable and handles TLS termination.

  Recommended approach: Azure App Service (Linux, Node 18 LTS)
  ─────────────────────────────────────────────────────────────

  Step 1 — Provision an App Service
    • Runtime stack : Node 18 LTS (Linux)
    • Pricing tier  : B1 or higher (F1 free tier has CPU limits that may
                      cause timeouts on AI image generation)

  Step 2 — Configure Application Settings
    In the Azure Portal → App Service → Configuration → Application Settings,
    add the following (do NOT use a .env file in production):
      APP_PASSWORD       = <your passcode>
      ANTHROPIC_API_KEY  = sk-ant-...
      STABILITY_API_KEY  = sk-...
    Do not set PORT — Azure manages this automatically.

  Step 3 — Set the startup command
    In Configuration → General Settings → Startup Command:
      node server.js

  Step 4 — Deploy the code
    Option A — Azure DevOps Pipeline (recommended)
      Add a Node.js pipeline in azure-pipelines.yml:

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

    Option B — Azure CLI (manual)
      az webapp up \
        --name <app-name> \
        --resource-group <rg-name> \
        --runtime "NODE:18-lts" \
        --sku B1

    Option C — VS Code Azure App Service extension
      Right-click the project folder and select "Deploy to Web App".

  Step 5 — CORS configuration
    The CORS allowlist is hardcoded in server.js (search for ALLOWED_ORIGINS).
    Update this set to include your App Service hostname before deploying:
      'https://<your-app-name>.azurewebsites.net'

  Step 6 — Verify
    Navigate to https://<your-app-name>.azurewebsites.net
    Log in with APP_PASSWORD and generate a test booth concept.

  Files NOT required in the deployment package:
    .env  (use App Service Application Settings instead)
    .git/


================================================================================
  9. API ENDPOINT REFERENCE
================================================================================

  Method  Path             Auth      Description
  ─────────────────────────────────────────────────────────────────────────────
  GET     /                No        Serves the main SPA (if authenticated) or
                                     the login page (if not authenticated)

  GET     /logo.webp       No        Serves the GES logo as a static file
                                     Cache-Control: public, max-age=86400

  POST    /api/login       No        Authenticates the user.
                                     Body: { "password": "<APP_PASSWORD>" }
                                     Success: 200 { "ok": true }
                                       Sets HttpOnly session cookie (24 h)
                                     Failure: 401 { "ok": false }

  POST    /api/claude      Yes       Proxies request to Anthropic API.
                                     Body: Anthropic Messages API payload
                                     Returns: Anthropic API response verbatim
                                     Rate limited: 20 req/IP/min → 429

  POST    /api/image       Yes       Proxies request to Stability AI API.
                                     Body: { "prompt": "...",
                                             "negative_prompt": "..." }
                                     Returns: { "image_b64": "<base64 JPEG>",
                                                "content_type": "image/jpeg" }
                                     Rate limited: 20 req/IP/min → 429
  ─────────────────────────────────────────────────────────────────────────────

  HTTP Status Codes Used
  ─────────────────────
    200  OK
    204  No Content (CORS preflight OPTIONS response)
    400  Bad Request (missing body, invalid JSON, missing API key)
    401  Unauthorized (wrong password or no session cookie)
    404  Not Found
    413  Payload Too Large (body exceeds 10 MB limit)
    429  Too Many Requests (rate limit exceeded)
    502  Bad Gateway (upstream API error from Anthropic or Stability AI)


================================================================================
  10. SECURITY MODEL
================================================================================

  Authentication
  ──────────────
  All routes except GET /logo.webp and POST /api/login require a valid
  session cookie (ges_session). The cookie is:
    • HttpOnly  — not accessible to JavaScript
    • Secure    — transmitted over HTTPS only
    • SameSite=Strict — CSRF mitigation
    • Max-Age=86400 — expires after 24 hours

  Sessions are stored in an in-memory Map keyed by a 32-byte random hex token.
  There is no persistent session storage — all sessions are lost on restart.

  Password
  ────────
  The APP_PASSWORD is compared using plain string equality. Use a strong,
  randomly generated passphrase. The password is never stored on the client.

  API Key Protection
  ──────────────────
  ANTHROPIC_API_KEY and STABILITY_API_KEY are stored only in the server
  environment and are never sent to the browser. All AI API calls are made
  server-side. Authenticated users may optionally supply their own keys in
  the __api_key / __stability_key request body fields (stripped before
  forwarding); this is an intentional escape hatch for development.

  Rate Limiting
  ─────────────
  A per-IP sliding window allows 20 API requests per 60 seconds. Exceeding
  this returns HTTP 429. The counter resets after 60 seconds of inactivity.
  IP is read from the X-Forwarded-For header (Azure App Service sets this).

  CORS
  ────
  The Access-Control-Allow-Origin header is only set for origins in the
  ALLOWED_ORIGINS set (server.js, search "ALLOWED_ORIGINS"). Update this
  before deploying to a new hostname.

  TLS
  ───
  The Node.js server speaks plain HTTP. TLS (HTTPS) is terminated by Azure
  App Service's reverse proxy. Do not expose the server directly on port 443.

  Body Size Limit
  ───────────────
  POST request bodies are capped at 10 MB. Larger requests return HTTP 413.


================================================================================
  11. KNOWN LIMITATIONS
================================================================================

  • In-memory sessions: All user sessions are stored in a JavaScript Map.
    Restarting the server logs out all active users. There is no sticky
    session requirement but scale-out to multiple instances would cause
    session loss on instance switches. For production scale, replace the
    session Map with an external store (Redis, Azure Cache for Redis).

  • In-memory rate limits: Same as above — rate limit counters reset on
    restart and are not shared across multiple App Service instances.

  • No conversation persistence: The multi-turn chat history is stored only
    in the browser's JavaScript memory. Refreshing the page loses the
    conversation. There is no server-side conversation storage.

  • Single shared password: All users share one APP_PASSWORD. There is no
    per-user authentication, roles, or audit trail.

  • No database: The application has no database layer. It is stateless
    beyond the in-memory session and rate limit maps.

  • CORS allowlist is hardcoded: To add a new allowed origin (e.g., a new
    Azure App Service hostname), edit the ALLOWED_ORIGINS set in server.js
    and redeploy.

  • API key exposure via client: Authenticated users can supply their own
    Anthropic/Stability AI keys in the request body. This is by design for
    development flexibility but should be reviewed for production.

================================================================================
  END OF README
  Questions? Contact the TradeTech Transformers team.
================================================================================
