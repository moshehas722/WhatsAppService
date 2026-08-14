import * as registry from './registry';
import * as assignmentStore from './assignmentStore';
import * as remoteRegistry from './remoteRegistry';
import * as configSchemaHelpers from './configSchema';
import { PluginContext, PluginMessage, PluginSummary } from './types';

export const PLUGIN_HISTORY_LIMIT = 20;

export function loadPluginAssignments(): void {
  assignmentStore.loadPersistedPluginAssignments();
}

// Health fields only apply to remote plugins — undefined for local/static ones.
function healthFields(pluginId: string): { remote: boolean; healthy?: boolean; lastSeenAt?: number } {
  const remote = !registry.staticPluginIds.has(pluginId);
  if (!remote) return { remote: false };
  const registration = remoteRegistry.get(pluginId);
  if (!registration) return { remote: true };
  return { remote: true, healthy: remoteRegistry.isHealthy(registration), lastSeenAt: registration.lastSeenAt };
}

export function listAvailablePlugins(): PluginSummary[] {
  return registry.listPlugins().map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    configJsonSchema: configSchemaHelpers.toJsonSchema(p),
    ...healthFields(p.id),
  }));
}

export interface AssignmentView {
  chatJid: string;
  pluginId: string;
  pluginName?: string;
  config: unknown;
  enabled: boolean;
  pluginFound: boolean;
  remote: boolean;
  healthy?: boolean;
  lastSeenAt?: number;
}

function toView(assignment: assignmentStore.PluginAssignment): AssignmentView {
  const plugin = registry.getPlugin(assignment.pluginId);
  return {
    chatJid: assignment.chatJid,
    pluginId: assignment.pluginId,
    pluginName: plugin?.name,
    config: assignment.config,
    enabled: assignment.enabled,
    pluginFound: !!plugin,
    ...healthFields(assignment.pluginId),
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

  const result = configSchemaHelpers.validateConfig(plugin, config);
  if (!result.success) {
    return { ok: false, error: result.error };
  }

  assignmentStore.setPluginAssignment(chatJid, pluginId, result.data);
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
