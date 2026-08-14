import { z } from 'zod';
import Ajv from 'ajv';
import { Plugin } from './types';

// Local (in-process) plugins declare their config as a zod schema; remote
// plugins can only hand over a plain JSON Schema object (no shared zod
// runtime across a network boundary). These helpers let manager.ts treat
// both uniformly without caring which one a given plugin uses.
const ajv = new Ajv({ allErrors: true, strict: false });

export function toJsonSchema(plugin: Plugin): object | undefined {
  if (plugin.configSchema) return z.toJSONSchema(plugin.configSchema) as object;
  return plugin.configJsonSchema;
}

export type ConfigValidationResult = { success: true; data: unknown } | { success: false; error: string };

export function validateConfig(plugin: Plugin, config: unknown): ConfigValidationResult {
  if (plugin.configSchema) {
    const parsed = plugin.configSchema.safeParse(config);
    if (!parsed.success) {
      const error = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
      return { success: false, error };
    }
    return { success: true, data: parsed.data };
  }

  if (plugin.configJsonSchema) {
    let validate;
    try {
      validate = ajv.compile(plugin.configJsonSchema);
    } catch (err) {
      return { success: false, error: `Plugin declared an invalid config schema: ${err instanceof Error ? err.message : err}` };
    }
    if (!validate(config)) {
      const error = (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ') || 'Invalid config.';
      return { success: false, error };
    }
    return { success: true, data: config };
  }

  // No schema declared at all — config is meaningless for this plugin.
  return { success: true, data: undefined };
}
