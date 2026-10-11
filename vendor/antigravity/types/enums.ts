export enum ThinkingEffort {
  Off = "off",
  Minimal = "minimal",
  Low = "low",
  Medium = "medium",
  High = "high",
  Xhigh = "xhigh",
}

export const ToolChoice = {
  Auto: "auto",
  None: "none",
  Any: "any",
  Required: "required",
} as const;
export type ToolChoice = (typeof ToolChoice)[keyof typeof ToolChoice];

export enum GeminiToolCallingMode {
  None = "NONE",
  Any = "ANY",
  Auto = "AUTO",
  Validated = "VALIDATED",
}

export enum GeminiRole {
  User = "user",
  Model = "model",
}

export enum AntigravityRequestType {
  Agent = "agent",
}

export enum AntigravityUserAgent {
  Antigravity = "antigravity",
}

export enum StopReason {
  Stop = "stop",
  Length = "length",
  ToolUse = "toolUse",
  Error = "error",
}
