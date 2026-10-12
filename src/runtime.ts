import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionVirtualModel,
} from "@earendil-works/pi-coding-agent";
import {
  ALIAS_PROVIDER,
  ALIAS_THINKING_LEVELS,
  VIRTUAL_MODEL_API,
} from "./types.js";
import { normalizeAliasName } from "./config.js";
import type { ModelAlias } from "./types.js";

function targetLabel(target: { provider: string; model: string }): string {
  return `${target.provider}/${target.model}`;
}

function virtualAliasName(alias: ModelAlias): string {
  return `${alias.name} (${targetLabel(alias.target)})`;
}

export function createVirtualAlias(alias: ModelAlias): ExtensionVirtualModel {
  const name = normalizeAliasName(alias.name);
  if (name === undefined) {
    throw new Error(`Invalid alias name: ${alias.name}`);
  }

  const target = Object.freeze({ ...alias.target });
  const label = targetLabel(target);

  return {
    provider: ALIAS_PROVIDER,
    id: name,
    name: virtualAliasName({ name, target }),
    thinkingLevels: ALIAS_THINKING_LEVELS,
    route(request, ctx: ExtensionContext) {
      const model = ctx.modelRegistry.find(target.provider, target.model);
      const available = model
        ? ctx.modelRegistry
            .getAvailable()
            .some(
              (candidate) =>
                candidate === model ||
                (candidate.provider === target.provider && candidate.id === target.model),
            )
        : false;

      if (!model || !available) {
        throw new Error(`Alias "${name}" target "${label}" is missing or unavailable`);
      }
      if (model.api === VIRTUAL_MODEL_API) {
        throw new Error(`Alias "${name}" target "${label}" resolves to a virtual model`);
      }

      return { model, thinkingLevel: request.thinkingLevel };
    },
  };
}

export type AliasSyncResult = { errors: string[]; converged: boolean };

type AliasRegistry = Pick<
  ExtensionAPI,
  "registerVirtualModel" | "unregisterVirtualModel"
>;

function copyAlias(alias: ModelAlias): ModelAlias {
  return { name: alias.name, target: { ...alias.target } };
}

function aliasMap(aliases: readonly ModelAlias[]): Map<string, ModelAlias> {
  return new Map(aliases.map((alias) => [alias.name, copyAlias(alias)]));
}

function sameAlias(left: ModelAlias, right: ModelAlias): boolean {
  return (
    left.name === right.name &&
    left.target.provider === right.target.provider &&
    left.target.model === right.target.model
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type AliasSelectionChange =
  | { kind: "retarget"; before: ModelAlias; after: ModelAlias }
  | { kind: "rename"; before: ModelAlias; after: ModelAlias }
  | { kind: "remove"; before: ModelAlias };

export async function reconcileActiveSelection(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  change: AliasSelectionChange,
): Promise<string | undefined> {
  if (
    ctx.model?.provider !== ALIAS_PROVIDER ||
    ctx.model.id !== change.before.name
  ) {
    return undefined;
  }

  const target =
    change.kind === "remove"
      ? change.before.target
      : { provider: ALIAS_PROVIDER, model: change.after.name };
  const destination = ctx.modelRegistry.find(target.provider, target.model);
  const label = `${target.provider}/${target.model}`;
  const available = destination
    ? ctx.modelRegistry
        .getAvailable()
        .some(
          (candidate) =>
            candidate === destination ||
            (candidate.provider === target.provider && candidate.id === target.model),
        )
    : false;

  if (!destination || !available) {
    return `Alias selection could not move to ${label}: model is missing or unavailable; select another model or restore authentication.`;
  }
  if (change.kind !== "remove" && destination.api !== VIRTUAL_MODEL_API) {
    return `Alias selection could not move to ${label}: replacement is not a virtual model; select another model or reload aliases.`;
  }
  if (
    change.kind !== "remove" &&
    destination.name !== virtualAliasName(change.after)
  ) {
    return `Alias selection could not move to ${label}: the registered alias still points at a different target; select another model or reload aliases.`;
  }
  if (change.kind === "remove" && destination.api === VIRTUAL_MODEL_API) {
    return `Alias selection could not move to ${label}: the former target is virtual; select another model.`;
  }

  try {
    if (!(await pi.setModel(destination))) {
      return `Alias selection could not move to ${label}: authentication is unavailable; select another model or restore authentication.`;
    }
  } catch (error) {
    return `Alias selection could not move to ${label}: ${errorMessage(error)}; select another model or restore authentication.`;
  }

  return undefined;
}

export class AliasRuntime {
  private desired = new Map<string, ModelAlias>();
  private registered = new Map<string, ModelAlias>();

  constructor(private readonly pi: AliasRegistry) {}

  initialize(aliases: readonly ModelAlias[]): AliasSyncResult {
    return this.reconcileFully(aliases);
  }

  reconcile(aliases: readonly ModelAlias[]): AliasSyncResult {
    const desired = aliasMap(aliases);
    this.desired = desired;
    const errors: string[] = [];

    try {
      for (const name of this.registered.keys()) {
        if (!desired.has(name)) {
          this.pi.unregisterVirtualModel(ALIAS_PROVIDER, name);
          this.registered.delete(name);
        }
      }

      for (const [name, next] of desired) {
        const previous = this.registered.get(name);
        if (previous && !sameAlias(previous, next)) {
          this.pi.registerVirtualModel(createVirtualAlias(next));
          this.registered.set(name, next);
        }
      }

      for (const [name, next] of desired) {
        if (!this.registered.has(name)) {
          this.pi.registerVirtualModel(createVirtualAlias(next));
          this.registered.set(name, next);
        }
      }
    } catch {
      return this.reconcileFully(aliases);
    }

    return { errors: [], converged: true };
  }

  reconcileFully(aliases: readonly ModelAlias[]): AliasSyncResult {
    this.desired = aliasMap(aliases);
    const errors: string[] = [];

    for (const name of [...this.registered.keys()]) {
      try {
        this.pi.unregisterVirtualModel(ALIAS_PROVIDER, name);
        this.registered.delete(name);
      } catch (error) {
        errors.push(errorMessage(error));
      }
    }

    for (const [name, alias] of this.desired) {
      try {
        this.pi.registerVirtualModel(createVirtualAlias(alias));
        this.registered.set(name, alias);
      } catch (error) {
        errors.push(errorMessage(error));
      }
    }

    return { errors, converged: errors.length === 0 };
  }

  snapshot(): readonly ModelAlias[] {
    return [...this.desired.values()].map(copyAlias);
  }
}
