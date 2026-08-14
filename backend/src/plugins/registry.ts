import { Plugin } from './types';
import { keywordResponderPlugin } from './keywordResponder';
import * as remoteRegistry from './remoteRegistry';
import { createRemotePluginAdapter } from './remotePlugin';

// Static, built-in registry (strategy pattern) — no dynamic loading. Add a
// new local plugin by writing a file exporting a Plugin and adding it here.
// Remote plugins (see remoteRegistry.ts/remotePlugin.ts) register themselves
// at runtime and are merged in below — they never appear in this array.
const staticPlugins: Plugin[] = [keywordResponderPlugin];
export const staticPluginIds = new Set(staticPlugins.map((p) => p.id));

const staticPluginsById = new Map<string, Plugin>(staticPlugins.map((p) => [p.id, p]));

// Adapters are cheap stateless closures over a registration snapshot, so
// there's no need to cache them — build fresh from the current registry
// state on every call, which also means a plugin's updated
// name/description/baseUrl/schema (re-registered) is picked up immediately.
export function listPlugins(): Plugin[] {
  return [...staticPlugins, ...remoteRegistry.list().map(createRemotePluginAdapter)];
}

export function getPlugin(id: string): Plugin | undefined {
  const local = staticPluginsById.get(id);
  if (local) return local;
  const remote = remoteRegistry.get(id);
  return remote ? createRemotePluginAdapter(remote) : undefined;
}
