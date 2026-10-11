const GROUPS = [
  { id: 'opencode-go-subscription', name: 'OpenCode Go (Subscription)', api: 'openai-completions', apiStyle: 'chat_completions', baseUrl: 'https://opencode.ai/inference/go/openai/v1' },
  { id: 'opencode-go-anthropic', name: 'OpenCode Go (Anthropic protocol)', api: 'anthropic-messages', apiStyle: 'anthropic_messages' },
  { id: 'opencode-go-responses', name: 'OpenCode Go (Responses protocol)', api: 'openai-responses', apiStyle: 'responses' },
];
const BASE_URL = 'https://opencode.ai/zen/go/v1';
function buildNativeProviders(models) {
  if (!Array.isArray(models) || !models.length) throw new Error('Discovered Go catalog is empty');
  const seen = new Set();
  for (const model of models) {
    if (!GROUPS.some(group => group.api === model.api)) throw new Error(`Unsupported discovered API: ${model.api}`);
    if (model.baseUrl !== BASE_URL) throw new Error('Unexpected Go endpoint');
    if (model.wireId && model.wireId !== model.id) throw new Error('Native declaration cannot preserve differing wireId');
    if (!model.id || seen.has(model.id)) throw new Error('Invalid or duplicate model id');
    seen.add(model.id);
    for (const field of ['contextWindow', 'maxTokens']) if (!Number.isSafeInteger(model[field]) || model[field] <= 0) throw new Error(`Invalid ${field}`);
  }
  return GROUPS.map(group => ({
    id: group.id, name: group.name, baseUrl: group.baseUrl ?? BASE_URL, apiStyle: group.apiStyle, authKind: 'oauth',
    oauth: { loginLabel: 'Sign in to OpenCode Go', isSubscription: true },
    models: models.filter(model => model.api === group.api).map(model => ({
      id: model.id, name: model.name || model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      supportsImages: model.input?.includes('image') === true,
    })),
  })).filter(group => group.models.length);
}
module.exports = { GROUPS, BASE_URL, buildNativeProviders };
