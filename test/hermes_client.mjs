// Hermes external test client for CARMA
const CARMA_URL = process.env.CARMA_URL || 'http://localhost:7100';
const JWT = process.env.CARMA_JWT || '';

async function resolve(uri) {
  const res = await fetch(`${CARMA_URL}/resolve?uri=${encodeURIComponent(uri)}`, {
    headers: JWT ? { Authorization: `Bearer ${JWT}` } : {},
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${body}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(JSON.parse(body), null, 2));
}

const uri = process.argv[2] || 'memory://acme/sem/worldview';
await resolve(uri);
