import http from 'http';
import url from 'url';

const PORT = process.env.PORT || 7100;

const store = new Map([
  ['memory://cyberorbit/sem/worldview', {
    '@context': 'https://json-am.org/context/v0.1',
    id: 'memory://cyberorbit/sem/worldview',
    type: 'Memory',
    uriScheme: 'memory',
    trustDomain: 'cyberorbit',
    version: '1',
    issuedAt: new Date().toISOString(),
    provenance: { createdBy: 'agent://system', createdAt: new Date().toISOString() },
    memoryKind: 'semantic',
    content: { title: 'Worldview', body: 'CyberOrbit worldview' },
    links: []
  }]
]);

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url || '', true);
  if (parsed.pathname === '/resolve' && req.method === 'GET') {
    const uri = parsed.query.uri as string;
    const envelope = store.get(uri);
    if (!envelope) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(envelope));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`CARMA listening on ${PORT}`);
});
