import http from 'http';
import url from 'url';
import { verifyCapability } from './middleware/jwt.js';
import { enforceCapability, validateEnvelope, sanitizeUri } from './middleware/guardrails.js';

const PORT = process.env.PORT || 7100;

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url || '', true);
  
  if (parsed.pathname === '/health') {
    res.writeHead(200); res.end('ok'); return;
  }
  
  if (parsed.pathname === '/resolve' && req.method === 'GET') {
    try {
      const uri = sanitizeUri(parsed.query.uri);
      const auth = req.headers.authorization || '';
      const token = auth.replace('Bearer ', '');
      
      // TODO: verify JWT and enforce capability
      // const claims = await verifyCapability(token, publicKey);
      // enforceCapability(claims, uri, 'read');
      
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({id: uri, note: 'stub'}));
      return;
    } catch (e) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`CARMA listening on ${PORT}`));
