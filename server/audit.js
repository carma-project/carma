// Best-effort append-only audit writer. Audit failures must never break the
// request path, but they are logged so a broken audit sink is visible.

export class Audit {
  constructor(adapter, logger, { enabled = true } = {}) {
    this.adapter = adapter;
    this.logger = logger;
    this.enabled = enabled;
  }

  // entry: { actor, action, uri, trustDomain, result, requestId, detail }
  record(entry) {
    if (!this.enabled || !this.adapter) return Promise.resolve();
    return this.adapter
      .audit(entry)
      .catch((e) => this.logger?.warn?.('audit_write_failed', { error: e.message, requestId: entry.requestId }));
  }
}
