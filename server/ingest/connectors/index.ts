// Connector registry. Each connector `collect`s a source into normalized memory
// items (+ optional derived outcomes); server/ingest/run.ts handles the common
// storage/tiering/policy so adding a connector never touches the write path.
// Keeping this table small and declarative is how CARMA draws on "multiple
// systems for context, repos for history, databases for all info".
import type { IngestItem, OutcomeItem } from '../extract.js';
import { collectGit } from './git.js';
import { collectPostgres } from './postgres.js';
import { collectHttp } from './http.js';
import { collectGithub } from './github.js';

export interface CollectContext {
  trustDomain: string;
  subject?: string;
  dryRun?: boolean;
  log: (event: string, detail?: any) => void;
}

export interface CollectResult {
  items: IngestItem[];
  outcomes?: OutcomeItem[];
  meta?: Record<string, any>;
}

export type Connector = (source: any, config: any, ctx: CollectContext) => Promise<CollectResult>;

const connectors: Record<string, Connector> = {
  git: collectGit,
  postgres: collectPostgres,
  http: collectHttp,
  github: collectGithub,
};

export const CONNECTOR_TYPES = Object.keys(connectors);

export function getConnector(type: string): Connector | null {
  return connectors[type] || null;
}
