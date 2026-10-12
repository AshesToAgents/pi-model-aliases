import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { normalizeAliasName } from "./config.js";
import {
  reconcileActiveSelection,
  type AliasRuntime,
  type AliasSelectionChange,
} from "./runtime.js";
import { ALIAS_PROVIDER, VIRTUAL_MODEL_API } from "./types.js";
import type { LoadedAliasConfig, ModelAlias, ModelTarget } from "./types.js";

export type AliasMutationResult =
  | { ok: true; aliases: ModelAlias[]; change?: AliasSelectionChange }
  | { ok: false; error: string };

const INVALID_NAME_ERROR =
  "Alias name must match ^[a-z0-9][a-z0-9._-]*$ after normalization.";

function duplicateError(name: string): AliasMutationResult {
  return { ok: false, error: `Alias "${name}" already exists.` };
}

function missingError(name: string): AliasMutationResult {
  return {
    ok: false,
    error: `Alias "${name}" no longer exists; configuration was changed externally.`,
  };
}

export function addAlias(
  aliases: readonly ModelAlias[],
  rawName: string,
  target: ModelTarget,
): AliasMutationResult {
  const name = normalizeAliasName(rawName);
  if (name === undefined) {
    return { ok: false, error: INVALID_NAME_ERROR };
  }
  if (aliases.some((alias) => alias.name === name)) {
    return duplicateError(name);
  }

  return {
    ok: true,
    aliases: [...aliases, { name, target: { ...target } }],
  };
}

export function retargetAlias(
  aliases: readonly ModelAlias[],
  name: string,
  target: ModelTarget,
): AliasMutationResult {
  const index = aliases.findIndex((alias) => alias.name === name);
  if (index < 0) {
    return missingError(name);
  }

  const before = aliases[index]!;
  const after: ModelAlias = { name: before.name, target: { ...target } };
  const next = aliases.slice();
  next[index] = after;
  return {
    ok: true,
    aliases: next,
    change: { kind: "retarget", before, after },
  };
}

export function renameAlias(
  aliases: readonly ModelAlias[],
  name: string,
  rawName: string,
): AliasMutationResult {
  const index = aliases.findIndex((alias) => alias.name === name);
  if (index < 0) {
    return missingError(name);
  }

  const normalized = normalizeAliasName(rawName);
  if (normalized === undefined) {
    return { ok: false, error: INVALID_NAME_ERROR };
  }
  if (normalized !== name && aliases.some((alias) => alias.name === normalized)) {
    return duplicateError(normalized);
  }

  const before = aliases[index]!;
  const after: ModelAlias = { name: normalized, target: { ...before.target } };
  const next = aliases.slice();
  next[index] = after;
  return {
    ok: true,
    aliases: next,
    change: { kind: "rename", before, after },
  };
}

export function removeAlias(
  aliases: readonly ModelAlias[],
  name: string,
): AliasMutationResult {
  const index = aliases.findIndex((alias) => alias.name === name);
  if (index < 0) {
    return missingError(name);
  }

  const before = aliases[index]!;
  return {
    ok: true,
    aliases: aliases.filter((_, aliasIndex) => aliasIndex !== index),
    change: { kind: "remove", before },
  };
}

function targetId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function filterPhysicalTargets(
  models: readonly Model<Api>[],
): Model<Api>[] {
  const unique = new Map<string, Model<Api>>();
  for (const model of models) {
    if (model.api !== VIRTUAL_MODEL_API) {
      unique.set(targetId(model.provider, model.id), model);
    }
  }

  return [...unique.values()].sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
  );
}

export function formatAliasReport(
  config: LoadedAliasConfig,
  availableTargetIds: ReadonlySet<string>,
): string {
  const sections: string[] = [];

  if (config.aliases.length === 0) {
    sections.push("No model aliases configured.");
  } else {
    sections.push(
      [
        "Model aliases:",
        ...config.aliases.map((alias) => {
          const id = targetId(alias.target.provider, alias.target.model);
          const availability = availableTargetIds.has(id) ? "" : " (unavailable)";
          return `- aliases/${alias.name} -> ${id}${availability}`;
        }),
      ].join("\n"),
    );
  }

  if (config.diagnostics.length > 0) {
    sections.push(
      [
        "Configuration diagnostics:",
        ...config.diagnostics.map(
          (diagnostic) => `- ${diagnostic.path}: ${diagnostic.message}`,
        ),
      ].join("\n"),
    );
  }

  sections.push("Alias management requires interactive TUI mode.");
  return sections.join("\n\n");
}

export interface AliasManagerUI {
  selectAlias(
    config: LoadedAliasConfig,
    availableTargetIds: ReadonlySet<string>,
  ): Promise<ModelAlias | "add" | undefined>;
  selectAction(alias: ModelAlias): Promise<"retarget" | "rename" | "remove" | undefined>;
  inputName(title: string, initial?: string): Promise<string | undefined>;
  selectTarget(models: readonly Model<Api>[]): Promise<Model<Api> | undefined>;
  confirmRemove(alias: ModelAlias): Promise<boolean>;
  notify(message: string, kind: "info" | "warning" | "error"): void;
}

export interface AliasManagerDependencies {
  pi: ExtensionAPI;
  runtime: AliasRuntime;
  configPath: string;
  load(path: string): LoadedAliasConfig;
  write(aliases: readonly ModelAlias[], path: string): void;
  createUI(ctx: ExtensionCommandContext): AliasManagerUI;
}

type PendingMutation =
  | { kind: "add"; name: string; target: ModelTarget }
  | { kind: "retarget"; name: string; target: ModelTarget }
  | { kind: "rename"; name: string; nextName: string }
  | { kind: "remove"; name: string };

function applyMutation(
  aliases: readonly ModelAlias[],
  pending: PendingMutation,
): AliasMutationResult {
  switch (pending.kind) {
    case "add":
      return addAlias(aliases, pending.name, pending.target);
    case "retarget":
      return retargetAlias(aliases, pending.name, pending.target);
    case "rename":
      return renameAlias(aliases, pending.name, pending.nextName);
    case "remove":
      return removeAlias(aliases, pending.name);
  }
}

function availableTargetIds(models: readonly Model<Api>[]): Set<string> {
  return new Set(models.map((model) => targetId(model.provider, model.id)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fatalConfigMessage(config: LoadedAliasConfig): string {
  const details = config.diagnostics
    .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
    .join("; ");
  return `Model aliases were not saved because the configuration is invalid${
    details === "" ? "." : `: ${details}`
  }`;
}

async function chooseMutation(
  ui: AliasManagerUI,
  selection: ModelAlias | "add",
  ctx: ExtensionCommandContext,
): Promise<PendingMutation | undefined> {
  if (selection === "add") {
    const name = await ui.inputName("Add model alias");
    if (name === undefined) {
      return undefined;
    }
    const targets = filterPhysicalTargets(ctx.modelRegistry.getAvailable());
    const target = await ui.selectTarget(targets);
    return target
      ? {
          kind: "add",
          name,
          target: { provider: target.provider, model: target.id },
        }
      : undefined;
  }

  const action = await ui.selectAction(selection);
  if (action === undefined) {
    return undefined;
  }

  switch (action) {
    case "retarget": {
      const targets = filterPhysicalTargets(ctx.modelRegistry.getAvailable());
      const target = await ui.selectTarget(targets);
      return target
        ? {
            kind: "retarget",
            name: selection.name,
            target: { provider: target.provider, model: target.id },
          }
        : undefined;
    }
    case "rename": {
      const name = await ui.inputName("Rename model alias", selection.name);
      return name === undefined
        ? undefined
        : { kind: "rename", name: selection.name, nextName: name };
    }
    case "remove":
      return (await ui.confirmRemove(selection))
        ? { kind: "remove", name: selection.name }
        : undefined;
  }
}

export async function runAliasManager(
  deps: AliasManagerDependencies,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (ctx.mode !== "tui") {
    const config = deps.load(deps.configPath);
    const targets = filterPhysicalTargets(ctx.modelRegistry.getAvailable());
    ctx.ui.notify(formatAliasReport(config, availableTargetIds(targets)), "info");
    return;
  }

  const ui = deps.createUI(ctx);
  while (true) {
    const config = deps.load(deps.configPath);
    const targets = filterPhysicalTargets(ctx.modelRegistry.getAvailable());
    const selection = await ui.selectAlias(config, availableTargetIds(targets));
    if (selection === undefined) {
      return;
    }

    const pending = await chooseMutation(ui, selection, ctx);
    if (pending === undefined) {
      continue;
    }

    const latest = deps.load(deps.configPath);
    if (latest.fatal) {
      ui.notify(fatalConfigMessage(latest), "error");
      continue;
    }

    const mutation = applyMutation(latest.aliases, pending);
    if (!mutation.ok) {
      ui.notify(mutation.error, "error");
      continue;
    }

    try {
      deps.write(mutation.aliases, deps.configPath);
    } catch (error) {
      ui.notify(`Could not save model aliases: ${errorMessage(error)}`, "error");
      continue;
    }

    let runtimeErrors: string[];
    let runtimeConverged = false;
    try {
      const result = deps.runtime.reconcile(mutation.aliases);
      runtimeErrors = result.errors;
      runtimeConverged = result.converged;
    } catch (error) {
      runtimeErrors = [errorMessage(error)];
    }
    if (runtimeErrors.length > 0) {
      ui.notify(
        `Aliases were saved, but runtime reconciliation failed: ${runtimeErrors.join(
          "; ",
        )}. Run /reload to retry.`,
        "warning",
      );
    }

    if (
      runtimeConverged &&
      mutation.change &&
      ctx.model?.provider === ALIAS_PROVIDER &&
      ctx.model.id === mutation.change.before.name
    ) {
      await ctx.waitForIdle();
      const warning = await reconcileActiveSelection(
        deps.pi,
        ctx,
        mutation.change,
      );
      if (warning) {
        ui.notify(warning, "warning");
      }
    }
  }
}
