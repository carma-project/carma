// Turn stored JSON-AM trace envelopes into a fine-tuning dataset.
//
// Default format is OpenAI-compatible chat JSONL (what Fireworks SFT expects):
// each line is { "messages": [ {role,content}, ... ] }. A trace maps to a
// supervised example as task -> user prompt, reasoning/outcome -> assistant.
// The assistant reasoning can additionally be carried as `reasoning_content`
// (a thinking trace) which Fireworks supports for SFT.

export interface BuildOptions {
  format?: 'chat' | 'completion';
  system?: string | null;
  reasoningField?: boolean; // duplicate content into reasoning_content
}

export interface BuildResult {
  jsonl: string;
  count: number;
  skipped: number;
  includedUris: string[];
  format: string;
}

function envelopeOf(row: any): any {
  return row?.envelope ?? row ?? {};
}

export function buildDataset(rows: any[], opts: BuildOptions = {}): BuildResult {
  const format = opts.format || 'chat';
  const system = opts.system ?? null;
  const lines: string[] = [];
  const includedUris: string[] = [];
  let skipped = 0;

  for (const row of rows) {
    const env = envelopeOf(row);
    const task = typeof env.task === 'string' ? env.task.trim() : '';
    const content = typeof env.content === 'string' ? env.content.trim() : '';
    // Supervised examples need both a prompt (task) and a target (content).
    if (!task || !content) {
      skipped++;
      continue;
    }

    if (format === 'completion') {
      lines.push(JSON.stringify({ prompt: task, completion: content }));
    } else {
      const messages: any[] = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: task });
      const assistant: any = { role: 'assistant', content };
      if (opts.reasoningField) assistant.reasoning_content = content;
      messages.push(assistant);
      lines.push(JSON.stringify({ messages }));
    }
    includedUris.push(env.id || row.uri);
  }

  return {
    jsonl: lines.length ? lines.join('\n') + '\n' : '',
    count: lines.length,
    skipped,
    includedUris,
    format,
  };
}
