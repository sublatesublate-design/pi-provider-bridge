// Native Settings > AI Models > Subscriptions hook. Never reads TUI credentials.
const { join } = require('node:path');
const { createJiti } = require('jiti');
const { GROUPS } = require('./native-catalog.cjs');
let authPromise;
function auth() {
  return authPromise ||= createJiti(__filename, { moduleCache: false, tryNative: false }).import(join(__dirname, 'vendor/opencode/auth.ts'));
}
function encode(session) {
  // Desktop preserves only fixed fields. Store refresh metadata inside its encrypted
  // refreshToken field, never headers or plugin settings. Access remains a bare token.
  const metadata = { version: 1, server: session.server, refreshToken: session.refreshToken,
    accountId: session.accountId, email: session.email, orgs: session.orgs,
    orgId: session.orgId, orgName: session.orgName };
  const refreshToken = JSON.stringify(metadata);
  if (Buffer.byteLength(refreshToken) > 16 * 1024) throw new Error('Account metadata exceeds Desktop limit');
  return { accessToken: session.accessToken, refreshToken, expiresAt: session.expiresAt,
    accountLabel: String(session.email || session.accountId || 'OpenCode Go').slice(0, 256),
    ...(session.orgId ? { headers: { 'x-opencode-org-id': session.orgId, 'x-org-id': session.orgId } } : {}) };
}
function decode(credential) {
  const data = JSON.parse(credential.refreshToken);
  if (data.version !== 1 || data.server !== 'https://opencode.ai/console' || typeof data.refreshToken !== 'string') throw new Error('Invalid native credential metadata');
  return { ...data, accessToken: credential.accessToken, expiresAt: credential.expiresAt };
}
function createHandler(loadAuth = auth) {
  return async function onProviderOAuth(input, context) {
    if (!GROUPS.some(group => group.id === input.providerId)) throw new Error('Unsupported native subscription');
    const signal = context.signal;
    signal?.throwIfAborted();
    const sdk = await loadAuth();
    if (input.operation === 'refresh') return encode(await sdk.refreshSession(decode(input.credential), fetch, signal));
    if (input.operation !== 'login') throw new Error('Unsupported OAuth operation');
    const device = await sdk.requestDeviceCode('https://opencode.ai/console', (url, init) => fetch(url, { ...init, signal }));
    signal?.throwIfAborted();
    await pi.providers.oauth.notify(input.loginId, { kind: 'deviceCode', userCode: device.userCode,
      verificationUri: device.verificationUrl, expiresInSeconds: Math.max(1, Math.floor((device.expiresAt - Date.now()) / 1000)) });
    await pi.providers.oauth.notify(input.loginId, { kind: 'authUrl', url: device.verificationUrl, instructions: 'Authorize OpenCode Go with the displayed device code.' });
    const session = await sdk.completeDeviceSignIn(device, { signal });
    signal?.throwIfAborted();
    if (session.orgs.length) {
      const selected = await pi.providers.oauth.prompt(input.loginId, { type: 'select', message: 'Choose OpenCode organization',
        options: session.orgs.slice(0, 32).map(org => ({ id: org.id, label: org.name })) });
      signal?.throwIfAborted();
      const org = session.orgs.find(org => org.id === selected);
      if (!org) throw new DOMException('Organization selection cancelled', 'AbortError');
      session.orgId = org.id; session.orgName = org.name;
    }
    return encode(session);
  };
}
module.exports = { onProviderOAuth: createHandler(), createHandler, encode, decode };
