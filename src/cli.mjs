#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SessionStore, RaftClient, SafeError, originUrl } from './client.mjs';
import { createServer } from './server.mjs';
import { uuid, Controller } from './controller.mjs';

async function main() {
  const command = process.argv[2] ?? 'serve';
  if (command === '--help') {
    process.stderr.write(
      'Usage: raft-agent-mcp [login|logout|servers|serve]\nSet RAFT_MCP_API_URL to an HTTPS API origin and RAFT_MCP_SERVER_ID to your server UUID.\nSession cache: RAFT_MCP_SESSION_FILE or ~/.config/raft-agent-mcp/session.json.\nLogin runs outside MCP; approve the displayed device code in your own browser.\n',
    );
    return;
  }
  if (!['serve', 'login', 'logout', 'servers'].includes(command))
    throw new SafeError('unknown_command');
  const origin = originUrl(process.env.RAFT_MCP_API_URL ?? 'https://api.raft.build');
  const file =
    process.env.RAFT_MCP_SESSION_FILE ??
    join(homedir(), '.config', 'raft-agent-mcp', 'session.json');
  const serverId = process.env.RAFT_MCP_SERVER_ID;
  if (command === 'serve') uuid(serverId ?? '');
  const client = new RaftClient({ origin, serverId, store: new SessionStore(file, origin) });
  if (command === 'servers') {
    process.stdout.write(
      JSON.stringify(await new Controller(client).listServers(), null, 2) + '\n',
    );
    return;
  }
  if (command === 'login') {
    const grant = await client.beginLogin();
    process.stderr.write(
      `Open ${grant.url}\nApprove code: ${grant.userCode}\nWaiting for your approval; session credentials will not be printed.\n`,
    );
    while (Date.now() < grant.deadline) {
      await delay(grant.interval * 1000);
      try {
        await client.pollLogin(grant);
        process.stderr.write('Login complete. Session saved privately.\n');
        return;
      } catch (e) {
        if (e instanceof SafeError && e.code === 'authorization_pending') continue;
        if (e instanceof SafeError && e.code === 'slow_down') {
          grant.interval += 5;
          continue;
        }
        throw e; // Uncertain token consumption must not replay.
      }
    }
    throw new SafeError('expired_token');
  }
  if (command === 'logout') {
    await client.logout();
    process.stderr.write('Session revoked and local cache removed.\n');
    return;
  }
  await createServer(client).connect(new StdioServerTransport());
}
main().catch((e) => {
  process.stderr.write(`Raft MCP: ${e instanceof SafeError ? e.code : 'startup_failed'}\n`);
  process.exitCode = 1;
});
