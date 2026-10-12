import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  addAlias,
  filterPhysicalTargets,
  formatAliasReport,
  removeAlias,
  renameAlias,
  retargetAlias,
  runAliasManager,
} from "./manager.js";
import type {
  AliasManagerDependencies,
  AliasManagerUI,
} from "./manager.js";
import { createManagerUI } from "./ui.js";
import type { ModelAlias } from "./types.js";

const smart: ModelAlias = {
  name: "smart",
  target: { provider: "zai", model: "glm-5.3" },
};
const fast: ModelAlias = {
  name: "fast",
  target: { provider: "openai", model: "gpt-4.1-mini" },
};

function model(
  provider: string,
  id: string,
  api = "openai-responses",
  name = id,
): Model<Api> {
  return { provider, id, api, name } as Model<Api>;
}

describe("alias mutations", () => {
  it("adds a normalized alias without changing the input", () => {
    const aliases = [smart];

    const result = addAlias(aliases, " Fast ", fast.target);

    expect(result).toEqual({ ok: true, aliases: [smart, fast] });
    expect(aliases).toEqual([smart]);
  });

  it("retargets an alias and describes the active-selection change", () => {
    const aliases = [smart, fast];
    const target = { provider: "anthropic", model: "claude-sonnet-4" };

    const result = retargetAlias(aliases, "smart", target);

    expect(result).toEqual({
      ok: true,
      aliases: [{ name: "smart", target }, fast],
      change: {
        kind: "retarget",
        before: smart,
        after: { name: "smart", target },
      },
    });
    expect(aliases).toEqual([smart, fast]);
  });

  it("renames an alias with normalization and describes the selection change", () => {
    const aliases = [smart, fast];

    const result = renameAlias(aliases, "smart", " Daily.Driver ");

    expect(result).toEqual({
      ok: true,
      aliases: [{ name: "daily.driver", target: smart.target }, fast],
      change: {
        kind: "rename",
        before: smart,
        after: { name: "daily.driver", target: smart.target },
      },
    });
    expect(aliases).toEqual([smart, fast]);
  });

  it("removes an alias and describes the selection change", () => {
    const aliases = [smart, fast];

    const result = removeAlias(aliases, "smart");

    expect(result).toEqual({
      ok: true,
      aliases: [fast],
      change: { kind: "remove", before: smart },
    });
    expect(aliases).toEqual([smart, fast]);
  });

  it("rejects duplicate normalized names without changing the input", () => {
    const aliases = [smart, fast];

    expect(addAlias(aliases, " SMART ", fast.target)).toEqual({
      ok: false,
      error: 'Alias "smart" already exists.',
    });
    expect(renameAlias(aliases, "smart", " FAST ")).toEqual({
      ok: false,
      error: 'Alias "fast" already exists.',
    });
    expect(aliases).toEqual([smart, fast]);
  });

  it("rejects invalid names without changing the input", () => {
    const aliases = [smart];

    expect(addAlias(aliases, "bad/name", fast.target)).toEqual({
      ok: false,
      error: "Alias name must match ^[a-z0-9][a-z0-9._-]*$ after normalization.",
    });
    expect(renameAlias(aliases, "smart", " ")).toEqual({
      ok: false,
      error: "Alias name must match ^[a-z0-9][a-z0-9._-]*$ after normalization.",
    });
    expect(aliases).toEqual([smart]);
  });

  it("rejects changes to an alias that no longer exists", () => {
    expect(retargetAlias([smart], "missing", fast.target)).toEqual({
      ok: false,
      error: 'Alias "missing" no longer exists; configuration was changed externally.',
    });
    expect(renameAlias([smart], "missing", "renamed")).toEqual({
      ok: false,
      error: 'Alias "missing" no longer exists; configuration was changed externally.',
    });
    expect(removeAlias([smart], "missing")).toEqual({
      ok: false,
      error: 'Alias "missing" no longer exists; configuration was changed externally.',
    });
  });
});

describe("filterPhysicalTargets", () => {
  it("removes virtual models, de-duplicates identities, and sorts provider then ID", () => {
    const openaiZ = model("openai", "z-model", "openai-responses", "Zed");
    const zai = model("zai", "glm", "openai-completions", "GLM");
    const openaiA = model("openai", "a-model", "openai-responses", "Alpha");
    const duplicate = model("openai", "a-model", "openai-responses", "Duplicate");
    const virtual = model("aliases", "smart", "pi-virtual", "Smart");

    expect(filterPhysicalTargets([zai, virtual, openaiZ, duplicate, openaiA])).toEqual([
      openaiA,
      openaiZ,
      zai,
    ]);
  });
});

describe("formatAliasReport", () => {
  it("reports every alias, unavailable target, diagnostic, and TUI guidance", () => {
    const report = formatAliasReport(
      {
        aliases: [smart, fast],
        diagnostics: [
          { path: "aliases[2].name", message: "invalid alias name" },
          { path: "aliases[3].target", message: "target must be an object" },
        ],
        fatal: false,
      },
      new Set(["zai/glm-5.3"]),
    );

    expect(report).toContain("aliases/smart -> zai/glm-5.3");
    expect(report).toContain("aliases/fast -> openai/gpt-4.1-mini (unavailable)");
    expect(report).toContain("aliases[2].name: invalid alias name");
    expect(report).toContain("aliases[3].target: target must be an object");
    expect(report).toMatch(/management requires interactive TUI mode\.$/);
  });

  it("reports an empty configuration before TUI guidance", () => {
    expect(
      formatAliasReport(
        { aliases: [], diagnostics: [], fatal: false },
        new Set(),
      ),
    ).toBe(
      "No model aliases configured.\n\nAlias management requires interactive TUI mode.",
    );
  });
});

type ManagerHarness = {
  deps: AliasManagerDependencies;
  ctx: ExtensionCommandContext;
  ui: AliasManagerUI;
  store: ModelAlias[];
  events: string[];
  notifications: Array<{ message: string; kind: string }>;
  setAvailable(models: Model<Api>[]): void;
  getAvailableCalls(): number;
  setWriteError(error: Error | undefined): void;
  setRuntimeErrors(errors: string[]): void;
};

function managerHarness(options: {
  aliases?: ModelAlias[];
  mode?: "tui" | "print";
  currentModel?: Model<Api>;
  ui?: Partial<AliasManagerUI>;
} = {}): ManagerHarness {
  const events: string[] = [];
  const notifications: Array<{ message: string; kind: string }> = [];
  let available = [model("zai", "glm-5.3", "openai-completions", "GLM 5.3")];
  let availableCalls = 0;
  let writeError: Error | undefined;
  let runtimeErrors: string[] = [];
  const harness = {} as ManagerHarness;
  harness.store = (options.aliases ?? [smart]).map((alias) => ({
    name: alias.name,
    target: { ...alias.target },
  }));

  const ui: AliasManagerUI = {
    selectAlias: async () => undefined,
    selectAction: async () => undefined,
    inputName: async () => undefined,
    selectTarget: async () => undefined,
    confirmRemove: async () => false,
    notify(message, kind) {
      notifications.push({ message, kind });
    },
    ...options.ui,
  };

  const pi = {
    async setModel(selected: Model<Api>) {
      events.push(`selection:${selected.provider}/${selected.id}`);
      return true;
    },
  } as ExtensionAPI;
  const runtime = {
    reconcile(aliases: readonly ModelAlias[]) {
      events.push(`runtime:${aliases.map((alias) => alias.name).join(",")}`);
      return { errors: runtimeErrors };
    },
  };
  const registry = {
    getAvailable() {
      availableCalls += 1;
      return available;
    },
    find(provider: string, id: string) {
      return available.find(
        (candidate) => candidate.provider === provider && candidate.id === id,
      );
    },
  };
  const ctx = {
    mode: options.mode ?? "tui",
    model: options.currentModel,
    modelRegistry: registry,
    ui: {
      notify(message: string, kind: string) {
        notifications.push({ message, kind });
      },
    },
    async waitForIdle() {
      events.push("idle");
    },
  } as unknown as ExtensionCommandContext;
  const deps: AliasManagerDependencies = {
    pi,
    runtime: runtime as never,
    configPath: "/aliases.json",
    load() {
      events.push("load");
      return {
        aliases: harness.store.map((alias) => ({
          name: alias.name,
          target: { ...alias.target },
        })),
        diagnostics: [],
        fatal: false,
      };
    },
    write(aliases) {
      events.push(`write:${aliases.map((alias) => alias.name).join(",")}`);
      if (writeError) {
        throw writeError;
      }
      harness.store = aliases.map((alias) => ({
        name: alias.name,
        target: { ...alias.target },
      }));
    },
    createUI() {
      events.push("createUI");
      return ui;
    },
  };

  Object.assign(harness, {
    deps,
    ctx,
    ui,
    events,
    notifications,
    setAvailable(models: Model<Api>[]) {
      available = models;
    },
    getAvailableCalls() {
      return availableCalls;
    },
    setWriteError(error: Error | undefined) {
      writeError = error;
    },
    setRuntimeErrors(errors: string[]) {
      runtimeErrors = errors;
    },
  });
  return harness;
}

const selectedSmart = model("aliases", "smart", "pi-virtual", "Smart alias");
const selectedRenamed = model("aliases", "renamed", "pi-virtual", "Renamed alias");
const glm = model("zai", "glm-5.3", "openai-completions", "GLM 5.3");
const claude = model(
  "anthropic",
  "claude-sonnet-4",
  "anthropic-messages",
  "Claude Sonnet 4",
);

describe("public manager UI", () => {
  function customHarness() {
    let component: {
      handleInput?(data: string): void;
      render(width: number): string[];
      invalidate(): void;
    } | undefined;
    let finish!: (value: unknown) => void;
    const result = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const keybindings = {
      matches(data: string, binding: string) {
        return (
          (binding === "tui.select.up" && data === "up") ||
          (binding === "tui.select.down" && data === "down") ||
          (binding === "tui.select.confirm" && data === "\r") ||
          (binding === "tui.select.cancel" && data === "\u001b")
        );
      },
    };
    const ctx = {
      ui: {
        async custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown) {
          component = factory(
            { requestRender() {} },
            theme,
            keybindings,
            finish,
          ) as typeof component;
          return result;
        },
        async input() {
          return undefined;
        },
        async select() {
          return undefined;
        },
        async confirm() {
          return false;
        },
        notify() {},
      },
    } as never;
    return {
      ctx,
      getComponent() {
        if (!component) throw new Error("custom UI was not created");
        return component;
      },
      result,
    };
  }

  it("searches targets by provider, ID, and display name", async () => {
    const harness = customHarness();
    const target = model("anthropic", "claude-sonnet-4", "anthropic-messages", "Claude Sonnet");
    const ui = createManagerUI(harness.ctx);
    const selected = ui.selectTarget([target]);

    const component = harness.getComponent();
    component.handleInput?.("s");
    component.handleInput?.("\r");

    expect(await selected).toBe(target);
  });

  it("shows the normalized alias name before accepting a name change", async () => {
    const prompts: string[] = [];
    const ctx = {
      ui: {
        async input() {
          return " Fast ";
        },
        async confirm(title: string, message: string) {
          prompts.push(`${title}: ${message}`);
          return true;
        },
      },
    } as never;

    await expect(createManagerUI(ctx).inputName("Add model alias")).resolves.toBe(" Fast ");
    expect(prompts).toEqual(["Add model alias: Use aliases/fast?"]);
  });
});

describe("runAliasManager", () => {
  it("commits an add before reconciling runtime", async () => {
    let aliasSelections = 0;
    const harness = managerHarness({
      aliases: [],
      ui: {
        selectAlias: async () => (aliasSelections++ === 0 ? "add" : undefined),
        inputName: async () => " Fast ",
        selectTarget: async () => claude,
      },
    });
    harness.setAvailable([claude]);

    await runAliasManager(harness.deps, harness.ctx);

    expect(harness.store).toEqual([
      {
        name: "fast",
        target: { provider: "anthropic", model: "claude-sonnet-4" },
      },
    ]);
    expect(harness.events.indexOf("write:fast")).toBeLessThan(
      harness.events.indexOf("runtime:fast"),
    );
    expect(harness.events.some((event) => event.startsWith("selection:"))).toBe(false);
  });

  it.each([
    ["retarget", "retarget", [selectedSmart, claude], "selection:aliases/smart"],
    ["rename", "rename", [selectedSmart, selectedRenamed], "selection:aliases/renamed"],
    ["remove", "remove", [selectedSmart, glm], "selection:zai/glm-5.3"],
  ] as const)(
    "commits a %s before runtime and active-selection reconciliation",
    async (_label, action, availableModels, selectionEvent) => {
      let aliasSelections = 0;
      const harness = managerHarness({
        currentModel: selectedSmart,
        ui: {
          selectAlias: async () => (aliasSelections++ === 0 ? smart : undefined),
          selectAction: async () => action,
          inputName: async () => "renamed",
          selectTarget: async () => claude,
          confirmRemove: async () => true,
        },
      });
      harness.setAvailable([...availableModels]);

      await runAliasManager(harness.deps, harness.ctx);

      const writeIndex = harness.events.findIndex((event) => event.startsWith("write:"));
      const runtimeIndex = harness.events.findIndex((event) => event.startsWith("runtime:"));
      const idleIndex = harness.events.indexOf("idle");
      const selectionIndex = harness.events.indexOf(selectionEvent);
      expect(writeIndex).toBeGreaterThan(-1);
      expect(writeIndex).toBeLessThan(runtimeIndex);
      expect(runtimeIndex).toBeLessThan(idleIndex);
      expect(idleIndex).toBeLessThan(selectionIndex);
    },
  );

  it.each(["alias", "name", "target", "action", "confirmation"] as const)(
    "does not write when %s selection is cancelled",
    async (cancelAt) => {
      let aliasSelections = 0;
      const harness = managerHarness({
        ui: {
          selectAlias: async () => {
            if (cancelAt === "alias") return undefined;
            return aliasSelections++ === 0
              ? cancelAt === "action" || cancelAt === "confirmation"
                ? smart
                : "add"
              : undefined;
          },
          selectAction: async () =>
            cancelAt === "action" ? undefined : "remove",
          inputName: async () => (cancelAt === "name" ? undefined : "fast"),
          selectTarget: async () => (cancelAt === "target" ? undefined : claude),
          confirmRemove: async () => cancelAt !== "confirmation",
        },
      });
      harness.setAvailable([claude]);

      await runAliasManager(harness.deps, harness.ctx);

      expect(harness.events.some((event) => event.startsWith("write:"))).toBe(false);
      expect(harness.events.some((event) => event.startsWith("runtime:"))).toBe(false);
    },
  );

  it("does not reconcile runtime or selection when persistence fails", async () => {
    let aliasSelections = 0;
    const harness = managerHarness({
      currentModel: selectedSmart,
      ui: {
        selectAlias: async () => (aliasSelections++ === 0 ? smart : undefined),
        selectAction: async () => "remove",
        confirmRemove: async () => true,
      },
    });
    harness.setWriteError(new Error("disk full"));

    await runAliasManager(harness.deps, harness.ctx);

    expect(harness.events.some((event) => event.startsWith("runtime:"))).toBe(false);
    expect(harness.events.some((event) => event.startsWith("selection:"))).toBe(false);
    expect(harness.notifications).toContainEqual({
      message: "Could not save model aliases: disk full",
      kind: "error",
    });
  });

  it("reports runtime divergence after the committed write with reload guidance", async () => {
    let aliasSelections = 0;
    const harness = managerHarness({
      aliases: [],
      ui: {
        selectAlias: async () => (aliasSelections++ === 0 ? "add" : undefined),
        inputName: async () => "fast",
        selectTarget: async () => claude,
      },
    });
    harness.setAvailable([claude]);
    harness.setRuntimeErrors(["registration failed"]);

    await runAliasManager(harness.deps, harness.ctx);

    expect(harness.store).toEqual([
      {
        name: "fast",
        target: { provider: "anthropic", model: "claude-sonnet-4" },
      },
    ]);
    expect(harness.notifications).toContainEqual({
      message:
        "Aliases were saved, but runtime reconciliation failed: registration failed. Run /reload to retry.",
      kind: "warning",
    });
  });

  it("reloads before each loop and mutation so external aliases survive writes", async () => {
    let aliasSelections = 0;
    const external: ModelAlias = {
      name: "external",
      target: { provider: "openai", model: "gpt-4.1" },
    };
    const harness = managerHarness({
      ui: {
        selectAlias: async () => {
          if (aliasSelections++ === 0) {
            return smart;
          }
          return undefined;
        },
        selectAction: async () => "rename",
        inputName: async () => {
          harness.store.push(external);
          return "renamed";
        },
      },
    });

    await runAliasManager(harness.deps, harness.ctx);

    expect(harness.store).toEqual([
      { name: "renamed", target: smart.target },
      external,
    ]);
    expect(harness.events.filter((event) => event === "load")).toHaveLength(3);
  });

  it("diagnoses a selected alias removed externally instead of recreating it", async () => {
    let aliasSelections = 0;
    const harness = managerHarness({
      ui: {
        selectAlias: async () => (aliasSelections++ === 0 ? smart : undefined),
        selectAction: async () => "rename",
        inputName: async () => {
          harness.store = [];
          return "renamed";
        },
      },
    });

    await runAliasManager(harness.deps, harness.ctx);

    expect(harness.store).toEqual([]);
    expect(harness.events.some((event) => event.startsWith("write:"))).toBe(false);
    expect(harness.notifications).toContainEqual({
      message: 'Alias "smart" no longer exists; configuration was changed externally.',
      kind: "error",
    });
  });

  it("refreshes availability per loop and again immediately before target selection", async () => {
    let aliasSelections = 0;
    const seenTargetLists: Array<readonly Model<Api>[]> = [];
    const seenAvailability: ReadonlySet<string>[] = [];
    const harness = managerHarness({
      aliases: [],
      ui: {
        selectAlias: async (_config, availableIds) => {
          seenAvailability.push(availableIds);
          return aliasSelections++ === 0 ? "add" : undefined;
        },
        inputName: async () => "fast",
        selectTarget: async (models) => {
          seenTargetLists.push(models);
          return undefined;
        },
      },
    });
    harness.setAvailable([claude]);

    await runAliasManager(harness.deps, harness.ctx);

    expect(harness.getAvailableCalls()).toBe(3);
    expect([...seenAvailability[0]!]).toEqual(["anthropic/claude-sonnet-4"]);
    expect(seenTargetLists[0]).toEqual([claude]);
  });

  it("emits a report without creating custom UI outside TUI mode", async () => {
    const harness = managerHarness({ mode: "print" });

    await runAliasManager(harness.deps, harness.ctx);

    expect(harness.events).not.toContain("createUI");
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]).toEqual({
      message:
        "Model aliases:\n- aliases/smart -> zai/glm-5.3\n\nAlias management requires interactive TUI mode.",
      kind: "info",
    });
  });
});
