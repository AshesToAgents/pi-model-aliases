import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AliasDiagnostic, LoadedAliasConfig, ModelAlias } from "./types.js";

const CONFIG_VERSION = 1;
const ALIAS_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function diagnostic(path: string, message: string): AliasDiagnostic {
  return { path, message };
}

function emptyConfig(): LoadedAliasConfig {
  return { aliases: [], diagnostics: [], fatal: false };
}

export function normalizeAliasName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const name = value.trim().toLowerCase();
  return ALIAS_NAME_PATTERN.test(name) ? name : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAliasConfig(raw: unknown): LoadedAliasConfig {
  if (!isObject(raw)) {
    return {
      aliases: [],
      diagnostics: [diagnostic("root", "configuration root must be an object")],
      fatal: true,
    };
  }

  if (raw.version !== CONFIG_VERSION) {
    return {
      aliases: [],
      diagnostics: [diagnostic("version", "configuration version must be 1")],
      fatal: true,
    };
  }

  if (!Array.isArray(raw.aliases)) {
    return {
      aliases: [],
      diagnostics: [diagnostic("aliases", "aliases must be an array")],
      fatal: true,
    };
  }

  const aliases: ModelAlias[] = [];
  const diagnostics: AliasDiagnostic[] = [];
  const names = new Set<string>();

  raw.aliases.forEach((entry, index) => {
    const entryPath = `aliases[${index}]`;
    if (!isObject(entry)) {
      diagnostics.push(diagnostic(entryPath, "alias entry must be an object"));
      return;
    }

    const name = normalizeAliasName(entry.name);
    if (name === undefined) {
      diagnostics.push(
        diagnostic(
          `${entryPath}.name`,
          "alias name must match ^[a-z0-9][a-z0-9._-]*$ after normalization",
        ),
      );
      return;
    }

    if (names.has(name)) {
      diagnostics.push(diagnostic(`${entryPath}.name`, `duplicate alias name: ${name}`));
      return;
    }

    if (!isObject(entry.target)) {
      diagnostics.push(diagnostic(`${entryPath}.target`, "target must be an object"));
      return;
    }

    const provider = entry.target.provider;
    const model = entry.target.model;
    const providerText = typeof provider === "string" ? provider.trim() : "";
    const modelText = typeof model === "string" ? model.trim() : "";
    let targetValid = true;

    if (providerText === "") {
      diagnostics.push(
        diagnostic(`${entryPath}.target.provider`, "target provider must be a non-empty string"),
      );
      targetValid = false;
    }
    if (modelText === "") {
      diagnostics.push(
        diagnostic(`${entryPath}.target.model`, "target model must be a non-empty string"),
      );
      targetValid = false;
    }
    if (!targetValid) {
      return;
    }

    names.add(name);
    aliases.push({ name, target: { provider: providerText, model: modelText } });
  });

  return { aliases, diagnostics, fatal: false };
}

export function getAliasConfigPath(): string {
  return join(getAgentDir(), "model-aliases.json");
}

export function loadAliasConfig(configPath = getAliasConfigPath()): LoadedAliasConfig {
  let rawText: string;
  try {
    rawText = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyConfig();
    }
    throw error;
  }

  try {
    return parseAliasConfig(JSON.parse(rawText) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      aliases: [],
      diagnostics: [diagnostic("json", `invalid JSON: ${message}`)],
      fatal: true,
    };
  }
}

export function writeAliasConfig(
  aliases: readonly ModelAlias[],
  configPath = getAliasConfigPath(),
): void {
  mkdirSync(dirname(configPath), { recursive: true });

  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify({ version: CONFIG_VERSION, aliases }, null, 2)}\n`;
  let fileDescriptor: number | undefined;
  let temporaryCreated = false;

  try {
    fileDescriptor = openSync(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    writeFileSync(fileDescriptor, contents, "utf8");
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temporaryPath, configPath);
    temporaryCreated = false;
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // Preserve the original write or rename error.
      }
    }
    if (temporaryCreated) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Preserve the original write or rename error.
      }
    }
    throw error;
  }
}

