export const ALIAS_PROVIDER = "aliases" as const;
export const VIRTUAL_MODEL_API = "pi-virtual" as const;
export const ALIAS_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AliasThinkingLevel = (typeof ALIAS_THINKING_LEVELS)[number];

export interface ModelTarget {
  provider: string;
  model: string;
}

export interface ModelAlias {
  name: string;
  target: ModelTarget;
}

export interface AliasDiagnostic {
  path: string;
  message: string;
}

export interface LoadedAliasConfig {
  aliases: ModelAlias[];
  diagnostics: AliasDiagnostic[];
  fatal: boolean;
}
