# Desktop provider bridge

Agent extension `local.pi-provider-bridge` supports Antigravity account slots (`antigravity`, `antigravity-2` … `antigravity-8`) and `opencode-console` / `opencode-go-console`.

## Loopback ports (0.5.4)

Windows reserved the whole TCP block 50080–54360 on this machine (Hyper-V/HNS container networking; `netsh interface ipv4 show excludedportrange` does not list it). Nothing listens there, yet `bind` fails with `EADDRINUSE` on every interface and for every process, so both former ports were unusable forever:

- gateway: `127.0.0.1:51124` (`manifest.json` `baseUrl`, `antigravity-native.cjs` `PORT`, and the `antigravity-gateway.cjs` default)
- Google OAuth callback: `localhost:51123` (`vendor/antigravity/auth/oauth.ts`; `ANTIGRAVITY_CALLBACK_PORT` overrides it). The gateway and callback use separate loopback ports so a gateway bind failure cannot block OAuth setup.

Keep one directory loaded per plugin id: `plugins/providers`, `plugins/providers-backup-0.4.0` and `plugins/providers-quota` all declare `local.pi-provider-bridge`, and the first two still carry the old ports.

## Read-only subscription quota (0.5.0)

The four declared providers now declare `vendorKey` plus `oauth.subscriptionUsage: true`, and `main.js` answers the Host's `usage` operation on the existing OAuth handler. `provider-adapters.cjs` holds the two read-only transports; the plugin only ever sees this contribution's own refreshed credential and returns metrics, never a token or a URL of its choosing.

- OpenCode Go (all three declarations) reads `https://opencode.ai/inference/go/v1/usage` and maps `usage.rolling/weekly/monthly` to the 5h, weekly and monthly windows. Verified against the live account: HTTP 200. The public `https://opencode.ai/zen/go/v1` gateway answers 401 for a subscription token, so it is not a fallback.
- Antigravity verifies the gateway's signed envelope with its own machine key (`loadSecret`), then reads `POST {project}/v1internal:fetchAvailableModels` per declared model. Verified against the live account. The request must carry the vendor CLI `User-Agent`: without it every endpoint candidate answers 429, with it the same request succeeds.

The plugin needs `net.fetch` for those reads; the Host refuses egress outside `net.domains` (`opencode.ai`, the three `cloudcode-pa` hosts) and refuses unknown response bodies. The gateway binds to 127.0.0.1:51124 and the OAuth callback binds to localhost:51123.

To roll back: restore `manifest.json`, `main.js` and `antigravity-native.cjs` from `../providers-backup-0.4.0/` and delete `provider-adapters.cjs`.

## Antigravity Gemini native subscription (0.4.0)

Use Plugins > Load development plugin and re-select this plugin directory (do not uninstall). Settings > AI Models > Subscriptions then declares three independent Antigravity slots: **Antigravity Gemini (Google Subscription)**, **Antigravity Gemini (Google Subscription) · 2**, and **Antigravity Gemini (Google Subscription) · 3**. Google login uses the original Antigravity Authorization Code + PKCE/state flow and localhost callback on port 51123; Desktop owns encrypted credentials and renewal. No original TUI auth/settings are read or written by this native login path, and previous imported session credentials are not silently copied into native accounts.

Desktop's native request style is OpenAI-compatible only at the boundary: the plugin owns an authenticated HTTP gateway on **127.0.0.1:51124**, which converts messages/tools/SSE to the original Antigravity stream. Full source model descriptions and cached routing/enums are retained; no upstream wire protocol is reimplemented. A signed local bearer contains Google access/project information; its HMAC key is Windows DPAPI-encrypted in the plugin data directory, separate from Google refresh metadata in Desktop's encrypted store. Never share that local bearer or paste it into URLs. The gateway binds loopback only, rejects browser Origin requests, and never allows arbitrary fetch targets. Unload closes the listener and cancels active requests; port/key errors fail closed. Do not expose this port externally.

The native manifest declares all 11 previously discovered Gemini IDs (not Claude/other models). Display labels use explicit model IDs because older IDs may be aliases in the original routing table. The snapshot does not prove account entitlements and does not auto-discover new models. OAuth, stream conversion, tools, images, cancellation and actual Desktop login/inference must be distinguished in validation results. Images are supported only as bounded data URIs at the local boundary, not arbitrary remote URL downloads.

If the gateway port 51124 is unavailable, stop the stale gateway process/plugin before reloading. A port that nothing listens on yet still fails with `EADDRINUSE` is reserved by Windows; move the gateway port instead of hunting for a holder. Google callback port 51123 must be free during sign-in and is overridable with `ANTIGRAVITY_CALLBACK_PORT`. To disable the native Gemini service, disable this plugin; do not delete or overwrite TUI credentials. OpenCode Go declarations and account IDs are unchanged.

Validation completed: 51 tests across antigravity-gateway, antigravity-native, native-catalog, native-oauth and provider-bridge pass. Coverage includes HMAC rejection, loopback-only binding, body limits, browser-origin rejection, text/thinking/tool SSE, usage, cancellation/unload, Google native OAuth mock flows, real original SDK with mocked Google SSE, and an OpenAI SDK client consuming the gateway. PluginCheck passes; the running loopback endpoint rejects unauthenticated requests with HTTP 401. No real Google sign-in or paid/subscription inference was performed by these tests.

Manual acceptance: re-load this directory with **Load development plugin**, verify version **0.4.0**, then open Settings > AI Models > Subscriptions > **Antigravity Gemini (Google Subscription)** and select **Sign in with Google (Antigravity)**. Complete the browser consent/callback. After Desktop shows signed in, select a declared Gemini model in a new conversation and send `Only reply OK; do not call tools.` Report the exact native login/request error if any. Do not use /desktop-providers use as a replacement for this native flow. OpenCode Go accounts do not need re-login.

Known boundary: OpenAI transcript conversion does not preserve every Gemini thought-signature field. The original vendor stream downgrades thinking when replaying legacy tool history without signatures; complex multi-round thinking/tool conversations and live image requests are not verified. Use a fresh conversation for the first acceptance request. The native Gemini models and limits are snapshots, not guaranteed current account entitlements.

## Native subscription support (0.3.1; inference still needs verification)

**401 correction:** authenticated Console /api/config returned the Go OAuth route https://opencode.ai/inference/go/openai/v1, not the public https://opencode.ai/zen/go/v1 gateway. The main subscription endpoint is corrected without changing its ID or credentials. A read-only account probe returned HTTP 200; an empty (no model/messages) request returned 401 at the public gateway and 500 at the account route. This supports the endpoint correction but is NOT a successful inference test. Do not repeat login solely for this correction.

The live account config listed 29 Go models through a single @ai-sdk/openai-compatible provider. The older 38-model public catalog and its per-family protocol grouping are not proof of OAuth account entitlements or subscription routing. Anthropic/Responses profiles below are legacy, unverified declarations; do not use them as verified native subscription paths. Complete account-based catalog synchronization remains unfinished.

When manifest version/provider declarations change, use Plugins > Load development plugin and select C:\Users\24812\Documents\pi-desktop-migration\plugins\providers again. Do not uninstall or delete accounts. Desktop 0.17's ordinary Reload path calls only the plugin process loadFromPath, not Host plugins.loadDev; logs can show successful runtime reload while the registry version and native provider declarations remain stale. Load development plugin invokes both registrations; confirm requested permissions. Then verify version 0.3.1 and the main account endpoint before retrying inference. The three existing Go declarations are listed below, but only the main endpoint has the OAuth route correction:

- OpenCode Go (Subscription): 25 Completions models (original contribution ID retained).
- OpenCode Go (Anthropic protocol): 7 models, including MiniMax and Qwen.
- OpenCode Go (Responses protocol): 6 models, including GPT and Grok.

All 38 discovered IDs, names, context/output limits and image capabilities are preserved. They are an explicit snapshot, not live automatic catalog synchronization. native-catalog.cjs validates protocol grouping and refuses unknown APIs, duplicate IDs or lossy wire/endpoint changes rather than silently dropping models.

Desktop's native account transport has a fixed provider-level API and restricts incompatible per-model overrides. Therefore these are separate subscriptions/account rows, not a single unified login. Each uses the same device OAuth handler, but Desktop owns each encrypted credential separately; no automatic credential copying or shared-token mirroring is performed. Existing imported session credentials remain separate. Login/device-code/organization/refresh logic is tested with dummy credentials; actual UI login and inference remain unverified.

Antigravity native requests are now bridged by the authenticated local gateway described above, rather than an unsupported native apiStyle. Console's per-organization dynamic catalogs remain outside this change; its legacy session bridge is retained. Desktop installation files were not modified.

Verification: node --test tests/native-catalog.test.cjs tests/native-oauth.test.cjs tests/provider-bridge.test.mjs (25 tests), plus exact comparison of native declarations against the actual local 38-model cache. No real authentication or model requests are made by these tests.

## Commands

- `/desktop-providers status`: credential presence and cached model counts; no secrets displayed.
- `/desktop-providers import` or `/desktop-provider-import`: UI-confirmed, one-time matching-entry import from `~/.pi/agent/auth.json`. Source is never written. Imported keys are remembered even after logout.
- `/desktop-providers login <id>`: explicit OAuth/device flow with URL/code and organization UI. Login saves credentials but does not discover models.
- `/desktop-providers refresh`: explicit authenticated-only catalog discovery; token rotation is serialized and saved before discovery. No placeholder models.
- `/desktop-providers use <id> [model-id]`: select a registered session model through Desktop's actual model registry and setModel API. Omitting model-id opens a selector. These are session extension models, not global Settings providers.
- `/desktop-providers logout <id>`: remove only the Desktop credential/provider.
- `/desktop-providers cancel`: cancel the active operation; closing a UI prompt also cancels through the Desktop operation signal.

Startup and before-agent hooks only hydrate/register authenticated cached models. They do not perform network requests, renew tokens, import, or log in. An explicit chat request can refresh an expired credential before streaming.

## Isolation and storage

All runtime data is in `~/.pi-desktop/plugins/data/local.pi-provider-bridge/`:

- `credentials.dpapi`: Windows ProtectedData CurrentUser ciphertext, including complete original credential metadata and one-time import markers. Credential bytes are piped to PowerShell stdin, never passed in command arguments or stored as plaintext files. Writes use encrypted temporary files and atomic rename.
- `catalog.json`: non-secret full model metadata; Antigravity private routing/enums state is preserved. Authentication headers are excluded.

No global environment variables are set. TUI auth/settings and project files are not changed. Vendor debug dumps and legacy cache deletion are disabled. Errors forwarded to UI/stream are generic, not arbitrary upstream credential-bearing messages. DPAPI deliberately fails closed on non-Windows or undecryptable stores.

File-level locks serialize credential rotation and catalog updates across separate Desktop sessions/processes. A crash can leave `credentials.dpapi.lock` or `catalog.json.lock`; operations fail closed rather than risk overwriting credentials. Only after stopping all provider operations and confirming the recorded PID is no longer running, remove the stale lock file (never the credential ciphertext).

## Runtime dependencies / upstream licenses

Vendored selected source modules and MIT licenses: `@dereknex/pi-antigravity` 0.8.0 and `pi-provider-opencode-console` 1.0.5. Neither original default extension entry is included/executed. OpenCode persistence/shared refresh helpers have been removed from its vendored auth module.

The Desktop runner virtual `pi-ai/compat` does **not** expose dialect stream factories. `desktop-provider-ai` is an isolated npm alias of `@earendil-works/pi-ai` 0.84.2, used only for OpenCode dialect streams; this avoids Desktop's virtual-module interception. Its actual SDK dependencies are installed under this plugin (no scripts executed). Official PluginPack excludes node_modules: this migration therefore uses the local development plugin, not a self-contained .piplug. To reproduce dependencies:

```powershell
npm ci --prefix plugins\providers --ignore-scripts --no-audit --no-fund
node --test tests\provider-bridge.test.mjs
```

Tests use mock credentials/network and a dummy DPAPI round-trip. The jiti load test defaults to the authorized local TUI jiti installation; override `PROVIDER_TEST_JITI` with a file URL elsewhere. PluginCheck/Pack and actual authentication/streaming are separate host validations; no real tokens are used by these tests.


## Gemini tool-history repair

The native gateway now retains Gemini tool signatures across Desktop's OpenAI
serialization and gateway restarts. Each outgoing tool receives a unique short
ID; a bounded AES-256-GCM cache restores signatures only for matching project,
model, tool ID, name and arguments. The cache stores hashes and signatures, not
prompts, argument text, tool outputs or OAuth tokens. It uses the existing
DPAPI-protected gateway key and lives at the plugin data directory's
`tool-signatures.enc` (up to 2048 signatures / 8 MiB; oldest entries are evicted).

Restart PI Desktop after updating. Signatures already lost in pre-fix history
cannot be recovered: a fresh conversation gives the cleanest verification.
There is no automatic replay of user tools or synthetic “continue” loop.

Gemini 3 thinking is no longer disabled merely by legacy unsigned history.
`auto`, `none` and `required` tool choices are forwarded; unsupported named-tool
choice objects are rejected explicitly. SSE final lines without a newline are
parsed, missing finish markers or malformed data report errors, and MAX_TOKENS
is not converted to a successful tool-use response.

Offline regression test (set PI_SCRATCH_DIR to an existing temporary directory):
`node --test test/antigravity-tool-roundtrip.test.mjs`
