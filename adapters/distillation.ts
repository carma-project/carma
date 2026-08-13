import { PostgresAdapter } from './postgres.js';

export class DistillationAdapter {
  constructor(private store: PostgresAdapter) {}

  async *exportTraces(filterUri: string) {
    const traces = await this.store.query(`SELECT * FROM agent_memory WHERE uri LIKE $1`, [filterUri]);
    for (const t of traces.rows) {
      const envelope = JSON.parse(t.data);
      yield JSON.stringify(envelope);
    }
  }
}
