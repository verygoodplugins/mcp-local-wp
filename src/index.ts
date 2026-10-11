#!/usr/bin/env node
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { config } from 'dotenv';
import { createServer } from './server.js';
import { installLifecycle } from './lifecycle.js';

// Capture the original parent before asynchronous work or Local detection.
const parentPid = process.ppid;
process.env.DOTENV_CONFIG_QUIET = 'true';
config({ quiet: true });
const instances: ReturnType<typeof createServer>[] = [];
const transport = new StdioServerTransport();
const handle = serveStdio(
  () => {
    const instance = createServer();
    instances.push(instance);
    return instance.server;
  },
  { transport, onerror: (error) => console.error('Stdio error:', error.message) },
);
const shutdown = installLifecycle(parentPid, async () => {
  await handle.close();
  await Promise.all(instances.map((instance) => instance.disconnect()));
});
console.error('WordPress Local MCP Server running on stdio');

const onclose = transport.onclose;
transport.onclose = () => {
  onclose?.();
  void shutdown();
};
