import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionVirtualModel,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { activateModelAliases } from "./index.js";
import { ALIAS_PROVIDER } from "./types.js";

const tempDirectories: string[] = [];

function configFile(aliases: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-model-aliases-"));
  tempDirectories.push(directory);
  const path = join(directory, "model-aliases.json");
  writeFileSync(path, JSON.stringify({ version: 1, aliases }), "utf8");
  return path;
}

function model(provider: string, id: string, name = id): Model<Api> {
  return {
    provider,
    id,
    name,
    api: "openai-responses",
  } as Model<Api>;
}

type FakeCommand = {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

type FakeExtension = {
  virtualModels: ExtensionVirtualModel[];
  commands: Map<string, FakeCommand>;
  messages: Array<{ customType: string; content: string; display?: boolean }>;
  api: ExtensionAPI;
};

function fakeExtension(availableModels: Model<Api>[]): FakeExtension {
  const extension: FakeExtension = {
    virtualModels: [],
    commands: new Map(),
    messages: [],
    api: undefined as never,
  };
  extension.api = {
    registerVirtualModel(modelDefinition) {
      extension.virtualModels.push(modelDefinition);
    },
    unregisterVirtualModel(provider, id) {
      extension.virtualModels = extension.virtualModels.filter(
        (modelDefinition) =>
          modelDefinition.provider !== provider || modelDefinition.id !== id,
      );
    },
    registerCommand(name, options) {
      extension.commands.set(name, options as FakeCommand);
    },
    sendMessage(message) {
      extension.messages.push({
        customType: message.customType,
        content: message.content as string,
        display: message.display,
      });
    },
  } as ExtensionAPI;

  void availableModels;
  return extension;
}

function commandContext(
  availableModels: Model<Api>[],
  mode: "print" | "rpc" = "print",
): ExtensionCommandContext {
  return {
    mode,
    model: undefined,
    modelRegistry: {
      getAvailable: () => availableModels,
    },
    ui: {
      notify() {
        throw new Error("non-TUI command must not use UI notifications");
      },
      custom: async () => {
        throw new Error("non-TUI command must not open custom UI");
      },
    },
  } as unknown as ExtensionCommandContext;
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    rmSync(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("activateModelAliases", () => {
  it("loads valid aliases and queues virtual registrations before returning", () => {
    const path = configFile([
      { name: " Smart ", target: { provider: "zai", model: "glm-5.3" } },
      { name: "fast", target: { provider: "openai", model: "gpt-4.1-mini" } },
    ]);
    const extension = fakeExtension([]);

    const runtime = activateModelAliases(extension.api, { configPath: path });

    expect(runtime.snapshot()).toEqual([
      { name: "smart", target: { provider: "zai", model: "glm-5.3" } },
      { name: "fast", target: { provider: "openai", model: "gpt-4.1-mini" } },
    ]);
    expect(extension.virtualModels.map(({ provider, id }) => `${provider}/${id}`)).toEqual([
      `${ALIAS_PROVIDER}/smart`,
      `${ALIAS_PROVIDER}/fast`,
    ]);
  });

  it("registers no virtual aliases for a fatal config but still registers /model-aliases", () => {
    const path = configFile("not-an-array");
    const extension = fakeExtension([]);

    const runtime = activateModelAliases(extension.api, { configPath: path });

    expect(runtime.snapshot()).toEqual([]);
    expect(extension.virtualModels).toEqual([]);
    expect(extension.commands.has("model-aliases")).toBe(true);
  });

  it("prints the report to stdout and sends it as a custom message in print mode", async () => {
    const path = configFile([
      { name: "smart", target: { provider: "zai", model: "glm-5.3" } },
    ]);
    const extension = fakeExtension([model("zai", "glm-5.3", "GLM 5.3")]);
    const written: string[] = [];
    activateModelAliases(extension.api, {
      configPath: path,
      writeOutput: (text) => written.push(text),
    });

    await extension.commands.get("model-aliases")!.handler(
      "",
      commandContext([model("zai", "glm-5.3", "GLM 5.3")]),
    );

    expect(written).toHaveLength(1);
    expect(written[0]).toContain("aliases/smart -> zai/glm-5.3");
    expect(written[0]!.endsWith("\n")).toBe(true);
    expect(extension.messages).toHaveLength(1);
    expect(extension.messages[0]).toMatchObject({
      customType: "model-aliases",
      display: true,
    });
    expect(extension.messages[0]!.content).toContain(
      "aliases/smart -> zai/glm-5.3",
    );
  });

  it("sends the report without writing stdout outside print mode", async () => {
    const path = configFile([
      { name: "smart", target: { provider: "zai", model: "glm-5.3" } },
    ]);
    const extension = fakeExtension([model("zai", "glm-5.3", "GLM 5.3")]);
    const written: string[] = [];
    activateModelAliases(extension.api, {
      configPath: path,
      writeOutput: (text) => written.push(text),
    });

    await extension.commands.get("model-aliases")!.handler(
      "",
      commandContext([model("zai", "glm-5.3", "GLM 5.3")], "rpc"),
    );

    expect(written).toEqual([]);
    expect(extension.messages).toHaveLength(1);
    expect(extension.messages[0]).toMatchObject({
      customType: "model-aliases",
      display: true,
    });
  });

  it("uses the persisted file as the source of truth for each fresh extension instance", () => {
    const path = configFile([
      { name: "first", target: { provider: "zai", model: "glm-5.3" } },
    ]);
    const first = fakeExtension([]);
    activateModelAliases(first.api, { configPath: path });

    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        aliases: [
          { name: "second", target: { provider: "openai", model: "gpt-4.1-mini" } },
        ],
      }),
      "utf8",
    );

    const second = fakeExtension([]);
    const runtime = activateModelAliases(second.api, { configPath: path });

    expect(runtime.snapshot()).toEqual([
      { name: "second", target: { provider: "openai", model: "gpt-4.1-mini" } },
    ]);
    expect(second.virtualModels.map(({ id }) => id)).toEqual(["second"]);
  });
});
