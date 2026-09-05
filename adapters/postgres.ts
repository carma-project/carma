import { Pool } from 'pg';

export interface MemoryRecord {
  uri: string;
  kind: string;
  trustDomain: string;
  envelope: any;
  signature: string;
  content: string;
  embedding: string; // pgvector literal, e.g. "[0.1,0.2,...]"
}

export class PostgresAdapter {
  private pool: any;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async resolve(uri: string) {
    const query =
      'SELECT uri, kind, trust_domain, envelope, signature, created_at FROM agent_memory WHERE uri = $1';
    const res = await this.pool.query(query, [uri]);
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  async store(rec: MemoryRecord) {
    const query = `
      INSERT INTO agent_memory (uri, kind, trust_domain, envelope, signature, content, embedding)
      VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
      ON CONFLICT (uri) DO UPDATE SET
        kind = EXCLUDED.kind,
        trust_domain = EXCLUDED.trust_domain,
        envelope = EXCLUDED.envelope,
        signature = EXCLUDED.signature,
        content = EXCLUDED.content,
        embedding = EXCLUDED.embedding
      RETURNING uri`;
    const res = await this.pool.query(query, [
      rec.uri,
      rec.kind,
      rec.trustDomain,
      JSON.stringify(rec.envelope),
      rec.signature,
      rec.content,
      rec.embedding,
    ]);
    return res.rows[0];
  }

  // Semantic retrieval: returns JSON-AM pointers ranked by cosine similarity.
  async search(opts: { embedding: string; k?: number; trustDomain?: string | null; kind?: string | null }) {
    const params: any[] = [opts.embedding];
    let where = 'embedding IS NOT NULL';
    if (opts.trustDomain) {
      params.push(opts.trustDomain);
      where += ` AND trust_domain = $${params.length}`;
    }
    if (opts.kind) {
      params.push(opts.kind);
      where += ` AND kind = $${params.length}`;
    }
    params.push(opts.k ?? 5);
    const query = `
      SELECT uri, kind, trust_domain, 1 - (embedding <=> $1::vector) AS score
      FROM agent_memory
      WHERE ${where}
      ORDER BY embedding <=> $1::vector
      LIMIT $${params.length}`;
    const res = await this.pool.query(query, params);
    return res.rows;
  }

  async create(envelope: any) {
    const query = `INSERT INTO agent_memory (uri, data) VALUES ($1, $2)`;
    await this.pool.query(query, [envelope.id, JSON.stringify(envelope)]);
  }

  // Generic escape hatch used by e.g. the distillation adapter.
  async query(text: string, params: any[] = []) {
    return this.pool.query(text, params);
  }

  async close() {
    await this.pool.end();
  }

  async check() {
    const t = await this.pool.query("SELECT to_regclass('public.agent_memory') AS tbl");
    const ext = await this.pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    let hasEmbedding = false;
    try {
      const col = await this.pool.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_memory' AND column_name = 'embedding'"
      );
      hasEmbedding = col.rows.length > 0;
    } catch {
      /* ignore */
    }
    return {
      connected: true,
      schemaReady: t.rows[0]?.tbl !== null,
      ragReady: ext.rows.length > 0 && hasEmbedding,
    };
  }
}
