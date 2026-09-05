import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { FineTuneProvider, JobResult, SubmitInput } from './types.js';

// Offline provider: writes the dataset to disk and returns a synthetic,
// already-succeeded job. Lets the whole distillation pipeline run end to end
// (and in CI) with no external API key. Also useful as an export-only mode.
export class LocalProvider implements FineTuneProvider {
  name = 'local';
  constructor(private opts: { outputDir: string }) {}

  async submit(input: SubmitInput): Promise<JobResult> {
    mkdirSync(this.opts.outputDir, { recursive: true });
    const id = 'ft-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const file = path.join(this.opts.outputDir, id + '.jsonl');
    writeFileSync(file, input.datasetJsonl);
    const base = input.baseModel || 'base';
    return {
      provider: 'local',
      jobId: id,
      status: 'succeeded',
      model: `local/${base}::${id}`,
      datasetId: id,
      datasetPath: file,
      count: input.count,
    };
  }

  async status(jobId: string): Promise<JobResult> {
    return { provider: 'local', jobId, status: 'succeeded' };
  }
}
