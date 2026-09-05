import { FineTuneProvider } from './types.js';
import { LocalProvider } from './local.js';
import { FireworksProvider } from './fireworks.js';

// Select a fine-tune provider from config. `local` is the offline default;
// `fireworks` is the hosted provider. Add new providers here to let companies
// plug in their own model backend.
export function getFineTuneProvider(config: any): FineTuneProvider {
  const name = config.finetuneProvider || 'local';
  if (name === 'local') return new LocalProvider({ outputDir: config.distillOutputDir });
  if (name === 'fireworks') {
    return new FireworksProvider({
      apiKey: config.fireworksApiKey,
      accountId: config.fireworksAccountId,
      baseUrl: config.fireworksBaseUrl,
    });
  }
  throw new Error(`Unknown FINETUNE_PROVIDER: ${name}`);
}

export { LocalProvider, FireworksProvider };
