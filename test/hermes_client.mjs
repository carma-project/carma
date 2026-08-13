// Hermes external test client for CARMA
import { readFile } from 'fs/promises';

const CARMA_URL = process.env.CARMA_URL || 'http://localhost:7100';
const JWT = process.env.CARMA_JWT || '';

async function resolve(uri) {
  const res = await fetch(`${CARMA_URL}/resolve?uri=${encodeURIComponent(uri)}`, {
    headers: { Authorization: `Bearer ${JWT}` }
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

const uri = process.argv[2] || 'memory://cyberorbit/sem/worldview';
resolve(uri);
