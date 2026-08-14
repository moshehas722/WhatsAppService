import { z } from 'zod';
import * as registry from './registry';
import * as assignmentStore from './assignmentStore';
import { PluginContext, PluginMessage, PluginSummary } from './types';

export const PLUGIN_HISTORY_LIMIT = 20;

export function loadPluginAssignments(): void {
  assignmentStore.loadPersistedPluginAssignments();
}

export function listAvailablePlugins(): PluginSummary[] {
  return registry.listPlugins().map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    configJsonSchema: p.configSchema ? (z.toJSONSchema(p.configSchema) as object) : undefined,
  }));
}

export interface AssignmentView {
  chatJid: string;
  pluginId: string;
  pluginName?: string;
  config: unknown;
  enabled: boolean;
}

function toView(assignment: assignmentStore.PluginAssignment): AssignmentView {
  return {
    chatJid: assignment.chatJid,
    pluginId: assignment.pluginId,
    pluginName: registry.getPlugin(assignment.pluginId)?.name,
    config: assignment.config,
    enabled: assignment.enabled,
  };
}

export function getAssignment(chatJid: string): AssignmentView | undefined {
  const assignment = assignmentStore.getPluginAssignment(chatJid);
  return assignment ? toView(assignment) : undefined;
}

export function listAssignments(): AssignmentView[] {
  return assignmentStore.listPluginAssignments().map(toView);
}

export function hasAssignment(chatJid: string): boolean {
  return !!assignmentStore.getPluginAssignment(chatJid);
}

// Whether a plugin should actually fire for this chat — assigned AND enabled.
export function isActive(chatJid: string): boolean {
  return !!assignmentStore.getPluginAssignment(chatJid)?.enabled;
}

export function setEnabled(chatJid: string, enabled: boolean): { ok: true } | { ok: false; error: string } {
  const updated = assignmentStore.setAssignmentEnabled(chatJid, enabled);
  if (!updated) {
    return { ok: false, error: 'No plugin is assigned to this conversation.' };
  }
  return { ok: true };
}

export function assignPlugin(chatJid: string, pluginId: string, config: unknown): { ok: true } | { ok: false; error: string } {
  const plugin = registry.getPlugin(pluginId);
  if (!plugin) {
    return { ok: false, error: `Unknown plugin id "${pluginId}".` };
  }

  if (!plugin.configSchema) {
    // No schema means config is meaningless for this plugin — drop it
    // silently rather than erroring on an unexpected body field.
    assignmentStore.setPluginAssignment(chatJid, pluginId, undefined);
    return { ok: true };
  }

  const parsed = plugin.configSchema.safeParse(config);
  if (!parsed.success) {
    const error = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    return { ok: false, error };
  }

  assignmentStore.setPluginAssignment(chatJid, pluginId, parsed.data);
  return { ok: true };
}

export function clearAssignment(chatJid: string): void {
  assignmentStore.clearPluginAssignment(chatJid);
}

export async function runAssignedPlugin(chatJid: string, history: PluginMessage[]): Promise<string | undefined> {
  const assignment = assignmentStore.getPluginAssignment(chatJid);
  if (!assignment || !assignment.enabled) return undefined;

  const plugin = registry.getPlugin(assignment.pluginId);
  if (!plugin) {
    console.error(`[plugins] chat ${chatJid} is assigned to unknown plugin "${assignment.pluginId}" (removed from registry?)`);
    return undefined;
  }

  if (history.length === 0) return undefined;

  const ctx: PluginContext = {
    chatJid,
    message: history[history.length - 1],
    history,
    config: assignment.config,
  };

  try {
    const result = await plugin.onMessage(ctx);
    return typeof result === 'string' && result.trim() ? result : undefined;
  } catch (err) {
    console.error(`[plugins] plugin "${plugin.id}" threw for chat ${chatJid}:`, err);
    return undefined;
  }
}
