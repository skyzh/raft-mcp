import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Controller } from './controller.mjs';
import { SafeError } from './client.mjs';

const agentId = z.string().uuid().describe('Agent ID returned by list_agents.');
export function createServer(client) {
  const server = new McpServer({ name: 'raft-agent-control', version: '0.2.0' }, { instructions: 'Use the explicitly configured server and list_agents to select the target. Login is a separate human browser-approved device flow. Config edits do not implicitly restart. Full workspace reset requires reset_agent(mode=full) followed by confirm_full_reset and an actual human elicitation response; never substitute tool arguments for confirmation. Accepted lifecycle requests are asynchronous, not proof of completion. Never blindly repeat uncertain writes.' });
  const controller = new Controller(client);
  const register = (name, description, inputSchema, readOnly, fn) => server.registerTool(name, {
    description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: true },
  }, async args => {
    try { const result = await fn(args); return { ...(result?.writeOutcome === 'unknown' ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(result) }] }; }
    catch (e) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e instanceof SafeError ? e.code : 'internal_error', ...(e instanceof SafeError && e.status ? { httpStatus: e.status } : {}), ...(e instanceof SafeError && e.issues.length ? { issues: e.issues } : {}) }) }] }; }
  });
  register('list_servers', 'List servers visible to the signed-in human. Login first with the standalone login command.', {}, true, () => controller.listServers());
  register('list_agents', 'List agent identity, runtime, model, state and environment key names in the configured server. Secret values are omitted.', {}, true, () => controller.listAgents());
  register('get_agent', 'Get current agent configuration summary and observed state. Environment values, provider credentials and session tokens are omitted.', { agentId }, true, args => controller.getAgent(args.agentId));
  register('plan_agent_config', 'Prepare an expiring config change without writing. Preserve unrelated fields and env keys. No implicit restart: next_start is default. Explicit restart/session may reset a running Codex model session. Environment values stay private in the process.', {
    agentId, model: z.string().min(1).optional(), reasoningEffort: z.string().min(1).optional(), fastMode: z.boolean().optional(),
    envSet: z.record(z.string()).optional(), envUnset: z.array(z.string()).optional(), applyMode: z.enum(['next_start', 'restart', 'session']).default('next_start'),
  }, true, args => controller.planConfig(args));
  register('commit_agent_config', 'Commit one exact plan after inspecting it. Rechecks configuration and consumes the plan once; never automatically retries a write. Upstream lacks atomic compare-and-swap. Readback distinguishes saved settings from runtime application.', { planId: z.string().uuid() }, false, args => controller.commitConfig(args.planId));
  register('start_agent', 'Explicitly start the selected agent. Returns dispatch acceptance and freshly observed state; acceptance does not prove a running process. No retries.', { agentId }, false, args => controller.lifecycle(args.agentId, 'start'));
  register('stop_agent', 'Explicitly stop the selected agent. Returns acceptance and observed state; offline computers may apply the stop on reconnect. No retries.', { agentId }, false, args => controller.lifecycle(args.agentId, 'stop'));
  register('restart_agent', 'Restart the agent process while preserving its workspace and runtime session. Explicit action; returns asynchronous acceptance and observed state, never completion proof.', { agentId }, false, args => controller.reset(args.agentId, 'restart'));
  register('reset_agent', 'Reset mode: restart preserves session/workspace; session clears the runtime session but keeps workspace; full ONLY prepares a dangerous full-workspace deletion for separate human confirmation. This tool never directly executes full reset.', { agentId, mode: z.enum(['restart', 'session', 'full']) }, false, args => controller.reset(args.agentId, args.mode));
  register('confirm_full_reset', 'DANGEROUS: permanently clear the selected agent workspace and runtime session. Consume an agent/server-bound full-reset plan and request a separate human confirmation in the MCP client. Requires typed target name plus explicit deletion checkbox. Refuses unsupported clients, decline/cancel, stale or expired plans; no fallback confirmation argument.', { confirmationId: z.string().uuid() }, false, async args => {
    if (!server.server.getClientCapabilities()?.elicitation?.form) throw new SafeError('human_confirmation_unsupported');
    return controller.confirmFullReset(args.confirmationId, p => server.server.elicitInput({ mode: 'form', message: `DANGER: delete the entire workspace and runtime session of agent ${p.agentName} (${p.agentId}) on server ${p.serverId}. This cannot be undone. This is a separate confirmation; only proceed if you intend this exact full reset.`, requestedSchema: { type: 'object', properties: { agentName: { type: 'string', title: `Type the exact agent name: ${p.agentName}` }, deleteWorkspace: { type: 'boolean', title: 'I confirm deletion of the entire agent workspace and runtime session', default: false } }, required: ['agentName', 'deleteWorkspace'] } }, { timeout: 120000 }));
  });
  return server;
}
