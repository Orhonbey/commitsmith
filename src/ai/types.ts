export type ToolId = 'claude' | 'codex';
export type ModelInfo = { id: string; label: string; detail?: string };
export type RunOptions = {
  model: string;
  cwd: string;
  jsonSchema?: object;
  timeoutMs: number;
  signal?: AbortSignal;
};

export interface AiTool {
  id: ToolId;
  displayName: string;
  /** Absolute path of the executable, or undefined when the tool is not installed. */
  detect(): Promise<string | undefined>;
  listModels(extra: string[]): Promise<ModelInfo[]>;
  /** Returns the final text (or the JSON string when `jsonSchema` is set). */
  run(prompt: string, opts: RunOptions): Promise<string>;
}

export type AiErrorKind = 'notFound' | 'exit' | 'timeout' | 'cancelled' | 'badOutput';

export class AiError extends Error {
  readonly stderrTail: string;
  constructor(
    public readonly kind: AiErrorKind,
    message: string,
    stderr = '',
  ) {
    super(message);
    this.name = 'AiError';
    this.stderrTail = stderr.length > 2000 ? stderr.slice(-2000) : stderr;
  }
}
