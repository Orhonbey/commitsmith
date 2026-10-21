import { AiTool } from './types';

export async function detectTools(tools: AiTool[]): Promise<{ tool: AiTool; exe?: string }[]> {
  return Promise.all(
    tools.map(async (tool) => {
      let exe: string | undefined;
      try {
        exe = await tool.detect();
      } catch {
        exe = undefined;
      }
      return { tool, exe };
    }),
  );
}
