const go = require('./native-oauth.cjs');
const antigravity = require('./antigravity-native.cjs');
const quota = require('./provider-adapters.cjs');
const { verifyCredential } = require('./antigravity-gateway.cjs');

/** Go rows that share one OpenCode Go account. */
const GO_CONTRIBUTIONS = ['opencode-go-subscription', 'opencode-go-anthropic', 'opencode-go-responses'];
/** Only the models this manifest declares, so the Host accepts every quota bucket. */
const ANTIGRAVITY_MODEL_IDS = (
  require('./manifest.json').contributes.providers.find(provider => provider.id === antigravity.PROVIDER_ID)?.models ?? []
).map(model => model.id);

/**
 * Read-only subscription quota for this plugin's own account. The Host supplies
 * only this contribution's refreshed credential, and the reply carries metrics
 * only: never a token, and never a URL the plugin chose.
 */
async function subscriptionUsage(input, context) {
  if (GO_CONTRIBUTIONS.includes(input.providerId)) {
    return quota.queryOpenCodeGo(input.credential, context.signal);
  }
  if (input.providerId === 'antigravity-gemini-subscription') {
    // The stored Antigravity access token is this gateway's signed envelope, so
    // verify it with the plugin's own machine key. Treating it as a Google bearer
    // token would leak the envelope and fail upstream anyway.
    const secret = await antigravity.loadSecret();
    return quota.queryAntigravity(input.credential, context.signal, {
      modelIds: ANTIGRAVITY_MODEL_IDS,
      unwrap: credential => verifyCredential(secret, credential.accessToken),
    });
  }
  throw new Error('Unsupported subscription provider');
}

module.exports = {
  onLoad: () => antigravity.onLoad(),
  onUnload: () => antigravity.onUnload(),
  onProviderOAuth: (input, context) => {
    // `usage` is additive: login and refresh keep their existing handlers.
    if (input.operation === 'usage') return subscriptionUsage(input, context);
    return input.providerId === 'antigravity-gemini-subscription'
      ? antigravity.onProviderOAuth(input, context)
      : go.onProviderOAuth(input, context);
  },
};
