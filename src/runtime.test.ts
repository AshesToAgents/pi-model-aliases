import { describe, expect, it } from "vitest";
import type { ModelAlias } from "./types.js";
import { ALIAS_PROVIDER, ALIAS_THINKING_LEVELS, VIRTUAL_MODEL_API } from "./types.js";
import {
  AliasRuntime,
  createVirtualAlias,
  reconcileActiveSelection,
} from "./runtime.js";

type FakeModel = {
  api: string;
  id: string;
  name: string;
  provider: string;
};

type FakeContext = {
  modelRegistry: {
    find: (provider: string, id: string) => FakeModel | undefined;
    getAvailable: () => FakeModel[];
  };
};

const alias: ModelAlias = {
  name: "smart",
  target: { provider: "zai", model: "glm-5.3" },
};

const physicalModel: FakeModel = {
  api: "zhipu",
  id: "glm-5.3",
  name: "GLM 5.3",
  provider: "zai",
};

function request(thinkingLevel: string = "xhigh") {
  return { thinkingLevel } as never;
}

function context(found: FakeModel | undefined, available: FakeModel[] = [physicalModel]): FakeContext {
  return {
    modelRegistry: {
      find: (provider, id) => {
        expect(provider).toBe(alias.target.provider);
        expect(id).toBe(alias.target.model);
        return found;
      },
      getAvailable: () => available,
    },
  };
}

describe("createVirtualAlias", () => {
  it("emits the synthetic provider, alias identity, target-aware name, and all thinking levels", () => {
    const virtual = createVirtualAlias(alias);

    expect(virtual.provider).toBe(ALIAS_PROVIDER);
    expect(virtual.id).toBe("smart");
    expect(virtual.name).toBe("smart (zai/glm-5.3)");
    expect(virtual.thinkingLevels).toEqual(ALIAS_THINKING_LEVELS);
  });

  it("normalizes valid names and rejects invalid names before registration", () => {
    const normalized = createVirtualAlias({ ...alias, name: " Smart " });

    expect(normalized.id).toBe("smart");
    expect(normalized.name).toBe("smart (zai/glm-5.3)");
    expect(() => createVirtualAlias({ ...alias, name: "bad/name" })).toThrow(
      /invalid alias name/i,
    );
  });

  it("routes to the exact available physical target and preserves thinking level", () => {
    const virtual = createVirtualAlias(alias);
    const availableCopy = { ...physicalModel };

    const result = virtual.route(request(), context(physicalModel, [availableCopy]) as never);

    expect(result).toEqual({ model: physicalModel, thinkingLevel: "xhigh" });
  });

  it("rejects a target missing from the catalog", () => {
    const virtual = createVirtualAlias(alias);

    expect(() => virtual.route(request(), context(undefined, []) as never)).toThrow(
      /smart.*zai\/glm-5\.3/,
    );
  });

  it("rejects a catalog target that is no longer available", () => {
    const virtual = createVirtualAlias(alias);

    expect(() => virtual.route(request(), context(physicalModel, []) as never)).toThrow(
      /smart.*zai\/glm-5\.3/,
    );
  });

  it("rejects another virtual model as a physical target", () => {
    const virtual = createVirtualAlias(alias);
    const virtualTarget = { ...physicalModel, api: VIRTUAL_MODEL_API };

    expect(() => virtual.route(request(), context(virtualTarget, [virtualTarget]) as never)).toThrow(
      /smart.*zai\/glm-5\.3.*virtual/i,
    );
  });
});

type FakePi = {
  calls: string[];
  failRegistrationFor: Set<string>;
  api: {
    registerVirtualModel: (model: { provider: string; id: string }) => void;
    unregisterVirtualModel: (provider: string, id: string) => void;
  };
};

function fakePi(failRegistrationFor = new Set<string>()): FakePi {
  const calls: string[] = [];
  const api = {
    registerVirtualModel(model: { provider: string; id: string }) {
      calls.push(`register:${model.provider}/${model.id}`);
      if (failRegistrationFor.has(model.id)) {
        throw new Error(`cannot register ${model.id}`);
      }
    },
    unregisterVirtualModel(provider: string, id: string) {
      calls.push(`unregister:${provider}/${id}`);
    },
  };
  return { calls, failRegistrationFor, api };
}

const fast: ModelAlias = {
  name: "fast",
  target: { provider: "openai", model: "gpt-4.1-mini" },
};
const renamed: ModelAlias = {
  name: "renamed",
  target: { provider: "zai", model: "glm-5.3" },
};

describe("AliasRuntime", () => {
  it("registers every alias once during initialization", () => {
    const pi = fakePi();
    const runtime = new AliasRuntime(pi.api as never);

    expect(runtime.initialize([alias, fast])).toEqual({ errors: [] });
    expect(pi.calls).toEqual(["register:aliases/smart", "register:aliases/fast"]);
  });

  it("does not call the registry for unchanged aliases", () => {
    const pi = fakePi();
    const runtime = new AliasRuntime(pi.api as never);
    runtime.initialize([alias]);
    pi.calls.length = 0;

    expect(runtime.reconcile([alias])).toEqual({ errors: [] });
    expect(pi.calls).toEqual([]);
  });

  it("unregisters removals, re-registers retargets, and replaces renamed IDs", () => {
    const pi = fakePi();
    const runtime = new AliasRuntime(pi.api as never);
    runtime.initialize([
      alias,
      fast,
      { name: "old-name", target: { provider: "zai", model: "glm-4" } },
    ]);
    pi.calls.length = 0;

    const retargeted: ModelAlias = {
      name: "smart",
      target: { provider: "zai", model: "glm-5.4" },
    };
    expect(runtime.reconcile([retargeted, renamed])).toEqual({ errors: [] });
    expect(pi.calls).toEqual([
      "unregister:aliases/fast",
      "unregister:aliases/old-name",
      "register:aliases/smart",
      "register:aliases/renamed",
    ]);
  });

  it("attempts one full reconciliation after a failure and reports remaining errors while keeping the desired snapshot", () => {
    const pi = fakePi();
    const runtime = new AliasRuntime(pi.api as never);
    runtime.initialize([alias]);
    pi.failRegistrationFor.add("smart");
    pi.calls.length = 0;

    const desired: ModelAlias = {
      name: "smart",
      target: { provider: "zai", model: "glm-5.4" },
    };
    const result = runtime.reconcile([desired]);

    expect(pi.calls).toEqual([
      "register:aliases/smart",
      "unregister:aliases/smart",
      "register:aliases/smart",
    ]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(runtime.snapshot()).toEqual([desired]);
  });
});

type SelectionState = {
  selected: FakeModel | undefined;
  setModelCalls: FakeModel[];
  pi: { setModel: (model: FakeModel) => Promise<boolean> };
  ctx: {
    model: FakeModel | undefined;
    modelRegistry: {
      find: (provider: string, id: string) => FakeModel | undefined;
      getAvailable: () => FakeModel[];
    };
  };
};

function selectionState(
  current: FakeModel | undefined,
  models: FakeModel[],
  available: FakeModel[] = models,
): SelectionState {
  const setModelCalls: FakeModel[] = [];
  return {
    selected: undefined,
    setModelCalls,
    pi: {
      setModel: async (model) => {
        setModelCalls.push(model);
        return true;
      },
    },
    ctx: {
      model: current,
      modelRegistry: {
        find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
        getAvailable: () => available,
      },
    },
  };
}

const selectedAliasModel: FakeModel = {
  api: VIRTUAL_MODEL_API,
  id: "smart",
  name: "smart (zai/glm-5.3)",
  provider: ALIAS_PROVIDER,
};

const replacementAliasModel: FakeModel = {
  api: VIRTUAL_MODEL_API,
  id: "new-name",
  name: "new-name (zai/glm-5.4)",
  provider: ALIAS_PROVIDER,
};

const formerPhysicalModel: FakeModel = {
  api: "zhipu",
  id: "glm-5.3",
  name: "GLM 5.3",
  provider: "zai",
};

describe("reconcileActiveSelection", () => {
  it("retargets the selected alias to its replacement virtual model", async () => {
    const replacement = { ...replacementAliasModel, id: "smart", name: "smart (zai/glm-5.4)" };
    const state = selectionState(selectedAliasModel, [replacement]);
    const before = alias;
    const after = { ...alias, target: { provider: "zai", model: "glm-5.4" } };

    const warning = await reconcileActiveSelection(
      state.pi as never,
      state.ctx as never,
      { kind: "retarget", before, after },
    );

    expect(warning).toBeUndefined();
    expect(state.setModelCalls).toEqual([replacement]);
  });

  it("renames the selected alias to the new virtual model", async () => {
    const state = selectionState(selectedAliasModel, [replacementAliasModel]);
    const before = alias;
    const after = { name: "new-name", target: before.target };

    const warning = await reconcileActiveSelection(
      state.pi as never,
      state.ctx as never,
      { kind: "rename", before, after },
    );

    expect(warning).toBeUndefined();
    expect(state.setModelCalls).toEqual([replacementAliasModel]);
  });

  it("returns to the former physical target when removing the selected alias", async () => {
    const state = selectionState(selectedAliasModel, [formerPhysicalModel]);

    const warning = await reconcileActiveSelection(
      state.pi as never,
      state.ctx as never,
      { kind: "remove", before: alias },
    );

    expect(warning).toBeUndefined();
    expect(state.setModelCalls).toEqual([formerPhysicalModel]);
  });

  it("does not change an unselected alias", async () => {
    const state = selectionState(
      { ...selectedAliasModel, id: "other" },
      [replacementAliasModel],
    );

    const warning = await reconcileActiveSelection(
      state.pi as never,
      state.ctx as never,
      { kind: "retarget", before: alias, after: { ...alias, target: { provider: formerPhysicalModel.provider, model: formerPhysicalModel.id } } },
    );

    expect(warning).toBeUndefined();
    expect(state.setModelCalls).toEqual([]);
  });

  it("warns without selecting an unrelated model when the replacement is missing", async () => {
    const state = selectionState(selectedAliasModel, []);

    const warning = await reconcileActiveSelection(
      state.pi as never,
      state.ctx as never,
      { kind: "rename", before: alias, after: { name: "new-name", target: alias.target } },
    );

    expect(warning).toMatch(/new-name.*unavailable|not found/i);
    expect(state.setModelCalls).toEqual([]);
  });

  it("warns when a replacement model at the exact alias ID is not virtual", async () => {
    const wrongApiReplacement = { ...replacementAliasModel, api: "zhipu" };
    const state = selectionState(selectedAliasModel, [wrongApiReplacement]);

    const warning = await reconcileActiveSelection(
      state.pi as never,
      state.ctx as never,
      { kind: "rename", before: alias, after: { name: "new-name", target: alias.target } },
    );

    expect(warning).toMatch(/new-name.*virtual/i);
    expect(state.setModelCalls).toEqual([]);
  });

  it("warns without selecting an unrelated model when the former target is unavailable", async () => {
    const state = selectionState(selectedAliasModel, [formerPhysicalModel], []);

    const warning = await reconcileActiveSelection(
      state.pi as never,
      state.ctx as never,
      { kind: "remove", before: alias },
    );

    expect(warning).toMatch(/zai\/glm-5\.3.*unavailable/i);
    expect(state.setModelCalls).toEqual([]);
  });
});
