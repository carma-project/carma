import http from 'http';
import url from 'url';
import { PostgresAdapter } from '../adapters/postgres.js';

const PORT = process.env.PORT || 7100;
const adapter = new PostgresAdapter(process.env.DATABASE_URL || '');

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url || '', true);
  if (parsed.pathname === '/resolve' && req.method === 'GET') {
    const uri = parsed.query.uri as string;
    if (!uri) {
      res.writeHead(400); res.end('Missing uri'); return;
    }
    try {
      const envelope = await adapter.resolve(uri);
      if (!envelope) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(envelope));
    } catch (e) {
      res.writeHead(500); res.end('Error');
    }
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`CARMA listening on ${PORT}`));
