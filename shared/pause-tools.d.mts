// Types for pause-tools.mjs, so the Agent API (TypeScript) reads the one definition (ADR-0361).

export interface PauseToolDefinition {
  readonly name: "pause" | "request_resume";
  readonly title: string;
  readonly method: "POST";
  readonly path: "/v1/pause" | "/v1/pause/resume-ask";
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, { type: string; enum?: readonly string[]; description: string }>>;
    readonly additionalProperties: false;
  };
  readonly annotations: {
    readonly title: string;
    readonly readOnlyHint: false;
    readonly destructiveHint: false;
    readonly idempotentHint: true;
    readonly openWorldHint: false;
  };
}

export declare const PAUSE_PAGE_PATH: "/pause";
export declare const PAUSE_TOOL_DESCRIPTION: string;
export declare const REQUEST_RESUME_TOOL_DESCRIPTION: string;
export declare const PAUSE_TOOLS: readonly [PauseToolDefinition, PauseToolDefinition];
export declare const PAUSE_TOOL_NAMES: readonly ["pause", "request_resume"];
export declare const PAUSE_STATUS_RESUME_LINE: string;
