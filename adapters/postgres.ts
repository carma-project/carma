import { Pool } from 'pg';

export class PostgresAdapter {
  private pool: any;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }
  async resolve(uri: string) {
    const [scheme, trustDomain, ...path] = uri.split('://')[1]?.split('/') ?? [];
    const query = 'SELECT * FROM agent_memory WHERE uri = $1';
    const res = await this.pool.query(query, [uri]);
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }
  async create(envelope: any) {
    const query = `INSERT INTO agent_memory (uri, data) VALUES ($1, $2)`;
    await this.pool.query(query, [envelope.id, JSON.stringify(envelope)]);
  }
}
