import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const DB = process.env.DATABASE_URL;

test(
  'MCP store_trace + search_memory over stdio',
  { skip: DB ? false : 'DATABASE_URL not set' },
  async () => {
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const pkcs8 = await exportPKCS8(privateKey);

    const transport = new StdioClientTransport({
      command: 'node',
      args: ['--import', 'tsx', 'server/mcp/stdio.ts'],
      env: { ...process.env, PRIVATE_KEY: pkcs8, TRUST_DOMAIN: 'acme', DATABASE_URL: DB },
    });
    const client = new Client({ name: 'carma-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      assert.ok(names.includes('store_trace'));
      assert.ok(names.includes('search_memory'));

      const stored = await client.callTool({
        name: 'store_trace',
        arguments: {
          task: 'mcp trace',
          content: 'reasoning about vector search and pgvector retrieval invoked via mcp',
        },
      });
      const storedObj = JSON.parse(stored.content[0].text);
      assert.ok(storedObj.uri.startsWith('trace://acme/'));
      assert.equal(storedObj.stored, true);

      const searched = await client.callTool({
        name: 'search_memory',
        arguments: { query: 'pgvector retrieval', k: 3 },
      });
      const res = JSON.parse(searched.content[0].text);
      assert.ok(Array.isArray(res.results) && res.results.length >= 1);
    } finally {
      await client.close();
    }
  }
);
