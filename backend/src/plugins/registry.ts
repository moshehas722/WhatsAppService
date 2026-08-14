import { Plugin } from './types';
import { keywordResponderPlugin } from './keywordResponder';

// Static, built-in registry (strategy pattern) — no dynamic loading. Add a
// new plugin by writing a file exporting a Plugin and adding it here.
const plugins: Plugin[] = [keywordResponderPlugin];

const pluginsById = new Map<string, Plugin>(plugins.map((p) => [p.id, p]));

export function listPlugins(): Plugin[] {
  return plugins;
}

export function getPlugin(id: string): Plugin | undefined {
  return pluginsById.get(id);
}
