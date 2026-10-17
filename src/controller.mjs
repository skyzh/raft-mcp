import { createHash, randomUUID } from 'node:crypto';
import { SafeError } from './client.mjs';

export const uuid = (value) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new SafeError('uuid_required');
  return value;
};
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const envKey = (value) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new SafeError('invalid_env_key');
};
export function publicAgent(a) {
  const out = {};
  for (const key of [
    'id',
    'name',
    'displayName',
    'runtime',
    'model',
    'reasoningEffort',
    'status',
    'activity',
    'machineId',
    'serverId',
  ])
    if (a[key] !== undefined) out[key] = a[key];
  out.environmentKeys = Object.keys(a.runtimeConfig?.envVars ?? a.envVars ?? {}).sort();
  if (a.runtimeConfig?.mode) out.fastMode = a.runtimeConfig.mode.kind === 'fast';
  return out;
}
export class Controller {
  constructor(client, { now = Date.now } = {}) {
    this.client = client;
    this.now = now;
    this.plans = new Map();
    this.fullResetPlans = new Map();
  }
  agentPath(id) {
    return `/api/agents/${uuid(id)}`;
  }
  async listServers() {
    const rows = await this.client.request('/api/servers', { server: false });
    if (!Array.isArray(rows)) throw new SafeError('invalid_servers_response');
    return rows.map((s) => ({ id: s.id, name: s.name, slug: s.slug }));
  }
  async listAgents() {
    const rows = await this.client.request('/api/agents');
    if (!Array.isArray(rows)) throw new SafeError('invalid_agents_response');
    return rows.map(publicAgent);
  }
  async getAgent(id) {
    return publicAgent(await this.client.request(this.agentPath(id)));
  }
  async form(id) {
    const a = await this.client.request(this.agentPath(id));
    if (a.runtime === 'external') throw new SafeError('external_runtime_unsupported');
    const f = await this.client.request(`${this.agentPath(id)}/runtime-form`);
    if (
      f.protocolVersion !== 2 ||
      typeof f.runtimeId !== 'string' ||
      !f.values ||
      !f.dataSchema?.properties
    )
      throw new SafeError('unsupported_runtime_form');
    return f;
  }
  async planConfig({
    agentId,
    model,
    reasoningEffort,
    fastMode,
    envSet = {},
    envUnset = [],
    applyMode = 'next_start',
  }) {
    if (
      model === undefined &&
      reasoningEffort === undefined &&
      fastMode === undefined &&
      !Object.keys(envSet).length &&
      !envUnset.length
    )
      throw new SafeError('empty_change');
    const form = await this.form(agentId);
    const values = structuredClone(form.values);
    const fields = form.dataSchema.properties;
    const changed = [];
    for (const [k, value] of Object.entries({ model, reasoningEffort, fastMode })) {
      if (value === undefined) continue;
      if (!Object.hasOwn(fields, k)) throw new SafeError(`unsupported_field_${k}`);
      values[k] = value;
      changed.push(k);
    }
    if (Object.keys(envSet).length || envUnset.length) {
      if (!Object.hasOwn(fields, 'envVars')) throw new SafeError('unsupported_field_envVars');
      const env = { ...(values.envVars ?? {}) };
      for (const key of envUnset) {
        envKey(key);
        delete env[key];
      }
      for (const [key, value] of Object.entries(envSet)) {
        envKey(key);
        if (typeof value !== 'string' || value.includes('\0'))
          throw new SafeError('invalid_env_value');
        if (envUnset.includes(key)) throw new SafeError('conflicting_env_change');
        Object.defineProperty(env, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      values.envVars = env;
      changed.push('envVars');
    }
    // Secrets and saved-connection-owned fields must never be echoed or resubmitted.
    for (const pointer of form.capabilities?.writeOnlyPointers ?? [])
      delete values[pointer.slice(1)];
    if (typeof values.providerId === 'string' && values.providerId.startsWith('connection:')) {
      for (const [key, field] of Object.entries(fields))
        if (field['x-connectionOwned']) delete values[key];
    }
    if (!['next_start', 'restart', 'session'].includes(applyMode))
      throw new SafeError('invalid_apply_mode');
    const body = {
      formDefinitionRef: { protocolVersion: 2, runtimeId: form.runtimeId },
      formValues: values,
      ...(applyMode === 'next_start' ? {} : { restartMode: applyMode }),
    };
    for (const [key, plan] of this.plans) if (plan.expiresAt <= this.now()) this.plans.delete(key);
    if (this.plans.size >= 100) throw new SafeError('plan_limit');
    const planId = randomUUID();
    this.plans.set(planId, {
      agentId,
      formHash: digest(form),
      body,
      expiresAt: this.now() + 5 * 60000,
      changed,
    });
    setTimeout(() => this.plans.delete(planId), 5 * 60000).unref();
    return {
      planId,
      agentId,
      changedFields: changed,
      ...(model === undefined ? {} : { model }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(fastMode === undefined ? {} : { fastMode }),
      environmentSetKeys: Object.keys(envSet).sort(),
      environmentUnsetKeys: envUnset,
      applyMode,
      expiresInSeconds: 300,
      note: 'Environment values stay private. Commit checks for intervening configuration changes. The upstream PATCH has no atomic compare-and-swap.',
    };
  }
  async commitConfig(planId) {
    const p = this.plans.get(planId);
    if (!p || p.expiresAt <= this.now()) {
      this.plans.delete(planId);
      throw new SafeError('plan_missing_or_expired');
    }
    // Consume before any remote work: uncertain mutation outcomes must never replay.
    this.plans.delete(planId);
    const form = await this.form(p.agentId);
    if (digest(form) !== p.formHash) throw new SafeError('configuration_changed_replan');
    try {
      const written = await this.client.request(this.agentPath(p.agentId), {
        method: 'PATCH',
        body: p.body,
      });
      if (written?.id !== p.agentId) throw new SafeError('outcome_unknown_do_not_retry');
    } catch (e) {
      if (!(e instanceof SafeError) || e.code !== 'outcome_unknown_do_not_retry') throw e;
      let verification = 'unavailable';
      let checkedFields;
      try {
        const actual = await this.form(p.agentId);
        checkedFields = Object.fromEntries(
          p.changed.map((k) => [
            k,
            digest(actual.values[k] ?? null) === digest(p.body.formValues[k] ?? null),
          ]),
        );
        verification = Object.values(checkedFields).every(Boolean) ? 'matched' : 'mismatch';
      } catch {
        /* Readback does not justify replaying the write. */
      }
      return {
        writeOutcome: 'unknown',
        saved: null,
        verification,
        ...(checkedFields ? { checkedFields } : {}),
        error: e.code,
        runtimeApplication: p.body.restartMode ? 'unknown' : 'not_requested',
        note: 'Config may have persisted before a restart or response failure. Readback describes observed settings only; it does not prove this write or runtime application. Do not retry this plan.',
      };
    }
    try {
      const actual = await this.form(p.agentId);
      const checks = Object.fromEntries(
        p.changed.map((k) => [
          k,
          digest(actual.values[k] ?? null) === digest(p.body.formValues[k] ?? null),
        ]),
      );
      return {
        writeOutcome: 'acknowledged',
        saved: true,
        verification: Object.values(checks).every(Boolean) ? 'matched' : 'mismatch',
        checkedFields: checks,
        applyMode: p.body.restartMode ?? 'next_start',
        runtimeApplication: p.body.restartMode ? 'requested_not_verified' : 'not_requested',
      };
    } catch {
      return {
        writeOutcome: 'acknowledged',
        saved: true,
        verification: 'unavailable',
        runtimeApplication: p.body.restartMode ? 'requested_not_verified' : 'not_requested',
        note: 'PATCH succeeded; readback failed. Do not repeat the mutation.',
      };
    }
  }
  async lifecycle(agentId, action) {
    if (!['start', 'stop'].includes(action)) throw new SafeError('unsupported_action');
    const before = await this.getAgent(agentId);
    if (before.runtime === 'external') throw new SafeError('external_runtime_unsupported');
    const r = await this.client.request(`${this.agentPath(agentId)}/${action}`, {
      method: 'POST',
      body: {},
    });
    if (r?.ok !== true) throw new SafeError('outcome_unknown_do_not_retry');
    let observedState = null;
    try {
      observedState = await this.getAgent(agentId);
    } catch {
      /* Accepted action is not replayed for a failed readback. */
    }
    return {
      accepted: true,
      action,
      appliesOnReconnect: r.appliesOnReconnect === true,
      observedState,
      note: 'Observed state may lag dispatch. An offline computer may apply a stop when it reconnects.',
    };
  }
  async resetTarget(agentId) {
    const a = await this.client.request(this.agentPath(agentId));
    if (a?.id !== agentId) throw new SafeError('invalid_agent_response');
    if (a.runtime === 'external') throw new SafeError('external_runtime_unsupported');
    if (a.serverId && a.serverId !== this.client.serverId)
      throw new SafeError('agent_server_mismatch');
    const binding = Object.fromEntries(
      [
        'id',
        'name',
        'machineId',
        'runtime',
        'serverId',
        'model',
        'reasoningEffort',
        'runtimeConfig',
        'envVars',
      ].map((k) => [k, a[k] ?? null]),
    );
    return { name: a.name, hash: digest(binding), agent: publicAgent(a) };
  }
  async reset(agentId, mode) {
    if (!['restart', 'session', 'full'].includes(mode)) throw new SafeError('invalid_reset_mode');
    const target = await this.resetTarget(agentId);
    if (mode !== 'full') return this.dispatchReset(agentId, mode);
    if (!target.agent.machineId) throw new SafeError('full_reset_machine_required');
    if (typeof target.name !== 'string' || !target.name) throw new SafeError('agent_name_required');
    for (const [key, plan] of this.fullResetPlans)
      if (plan.expiresAt <= this.now()) this.fullResetPlans.delete(key);
    if (this.fullResetPlans.size >= 100) throw new SafeError('confirmation_limit');
    const confirmationId = randomUUID();
    this.fullResetPlans.set(confirmationId, {
      agentId,
      serverId: this.client.serverId,
      targetHash: target.hash,
      agentName: target.name,
      expiresAt: this.now() + 300000,
    });
    setTimeout(() => this.fullResetPlans.delete(confirmationId), 300000).unref();
    return {
      prepared: true,
      accepted: false,
      mode: 'full',
      confirmationId,
      agentId,
      agentName: target.name,
      serverId: this.client.serverId,
      expiresInSeconds: 300,
      warning:
        'Full reset clears the entire agent workspace and runtime session. Nothing has been reset. Call confirm_full_reset only after reviewing this target; it requires a separate human confirmation through your MCP client.',
    };
  }
  async confirmFullReset(confirmationId, confirmHuman) {
    const p = this.fullResetPlans.get(confirmationId);
    this.fullResetPlans.delete(confirmationId);
    if (!p || p.expiresAt <= this.now()) throw new SafeError('confirmation_missing_or_expired');
    if (p.serverId !== this.client.serverId) throw new SafeError('confirmation_server_changed');
    if ((await this.resetTarget(p.agentId)).hash !== p.targetHash)
      throw new SafeError('reset_target_changed_prepare_again');
    let result;
    try {
      result = await confirmHuman(p);
    } catch {
      throw new SafeError('human_confirmation_unavailable');
    }
    if (
      result?.action !== 'accept' ||
      result.content?.deleteWorkspace !== true ||
      result.content?.agentName !== p.agentName
    )
      throw new SafeError('full_reset_not_confirmed');
    if (p.expiresAt <= this.now()) throw new SafeError('confirmation_missing_or_expired');
    if (
      p.serverId !== this.client.serverId ||
      (await this.resetTarget(p.agentId)).hash !== p.targetHash
    )
      throw new SafeError('reset_target_changed_prepare_again');
    return this.dispatchReset(p.agentId, 'full');
  }
  async dispatchReset(agentId, mode) {
    const r = await this.client.request(`${this.agentPath(agentId)}/reset`, {
      method: 'POST',
      body: { mode },
    });
    if (r?.ok !== true || r?.status !== 'accepted')
      throw new SafeError('outcome_unknown_do_not_retry');
    let observedState = null;
    try {
      observedState = await this.getAgent(agentId);
    } catch {
      /* The asynchronous action must not replay for a failed readback. */
    }
    return {
      accepted: true,
      completed: false,
      mode,
      observedState,
      note: 'Raft accepted an asynchronous reset. Observed state may lag; this does not prove reset completion or workspace deletion. Do not blindly repeat it.',
    };
  }
}
