import type { ToolId } from './types';

/** What detection found for one tool. */
export type ToolEntry = { id: ToolId; found: boolean; models: string[] };

export type ToolChoice =
  | { kind: 'ok'; id: ToolId; model: string }
  /** The tool the user chose is not installed. */
  | { kind: 'missing'; id: ToolId }
  /** The tool is installed but lists no models. */
  | { kind: 'noModels'; id: ToolId }
  /** No tool was detected at all. */
  | { kind: 'none' };

/**
 * Picks the tool and model to run. Falls back to another detected tool only when the user never
 * set `commitsmith.tool`; a tool they chose is never silently replaced.
 */
export function chooseTool(entries: ToolEntry[], cfg: { tool?: string; toolSetByUser: boolean; model: string }): ToolChoice {
  const configured = entries.find((e) => e.id === cfg.tool);
  const modelFor = (e: ToolEntry) => (e.id === cfg.tool && cfg.model ? cfg.model : e.models[0]);
  if (cfg.toolSetByUser && configured) {
    if (!configured.found) return { kind: 'missing', id: configured.id };
    if (configured.models.length === 0) return { kind: 'noModels', id: configured.id };
    return { kind: 'ok', id: configured.id, model: modelFor(configured) };
  }
  const usable = entries.filter((e) => e.found && e.models.length > 0);
  const entry = usable.find((e) => e.id === cfg.tool) ?? usable[0];
  if (entry) return { kind: 'ok', id: entry.id, model: modelFor(entry) };
  const found = entries.find((e) => e.id === cfg.tool && e.found) ?? entries.find((e) => e.found);
  return found ? { kind: 'noModels', id: found.id } : { kind: 'none' };
}
