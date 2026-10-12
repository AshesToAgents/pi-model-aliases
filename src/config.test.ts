import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadAliasConfig,
  normalizeAliasName,
  parseAliasConfig,
  writeAliasConfig,
} from "./config.js";
import type { ModelAlias } from "./types.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-model-aliases-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("normalizeAliasName", () => {
  it("trims and lowercases valid names", () => {
    expect(normalizeAliasName(" Smart ")).toBe("smart");
    expect(normalizeAliasName("fast-1")).toBe("fast-1");
  });

  it("rejects invalid names", () => {
    expect(normalizeAliasName(" ")).toBeUndefined();
    expect(normalizeAliasName("sm/art")).toBeUndefined();
    expect(normalizeAliasName("ümlaut")).toBeUndefined();
    expect(normalizeAliasName(42)).toBeUndefined();
  });
});

describe("parseAliasConfig", () => {
  it("normalizes valid aliases and ignores unknown fields", () => {
    const result = parseAliasConfig({
      version: 1,
      aliases: [
        {
          name: " Smart ",
          target: { provider: " zai ", model: " glm-5.3 " },
          description: "ignored",
        },
      ],
      future: true,
    });

    expect(result).toEqual({
      aliases: [{ name: "smart", target: { provider: "zai", model: "glm-5.3" } }],
      diagnostics: [],
      fatal: false,
    });
  });

  it.each([
    [null, "root"],
    [{ aliases: [] }, "version"],
    [{ version: 2, aliases: [] }, "version"],
    [{ version: 1 }, "aliases"],
    [{ version: 1, aliases: {} }, "aliases"],
  ])("reports fatal diagnostics for invalid top-level input", (raw, path) => {
    const result = parseAliasConfig(raw);

    expect(result.fatal).toBe(true);
    expect(result.aliases).toEqual([]);
    expect(result.diagnostics.some((diagnostic) => diagnostic.path === path)).toBe(true);
  });

  it("diagnoses invalid entries while retaining valid siblings", () => {
    const result = parseAliasConfig({
      version: 1,
      aliases: [
        { name: "valid", target: { provider: "zai", model: "glm" } },
        { name: "ümlaut", target: { provider: "zai", model: "glm" } },
        { name: "   ", target: { provider: "zai", model: "glm" } },
        { name: "has/slash", target: { provider: "zai", model: "glm" } },
        { name: "missing-provider", target: { provider: "", model: "glm" } },
        { name: "missing-model", target: { provider: "zai", model: "" } },
        "not an object",
      ],
    });

    expect(result.fatal).toBe(false);
    expect(result.aliases).toEqual([
      { name: "valid", target: { provider: "zai", model: "glm" } },
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      "aliases[1].name",
      "aliases[2].name",
      "aliases[3].name",
      "aliases[4].target.provider",
      "aliases[5].target.model",
      "aliases[6]",
    ]);
  });

  it("keeps the first definition when normalized names duplicate", () => {
    const result = parseAliasConfig({
      version: 1,
      aliases: [
        { name: "Smart", target: { provider: "zai", model: "first" } },
        { name: " smart ", target: { provider: "zai", model: "second" } },
      ],
    });

    expect(result.aliases).toEqual([
      { name: "smart", target: { provider: "zai", model: "first" } },
    ]);
    expect(result.diagnostics).toEqual([
      { path: "aliases[1].name", message: "duplicate alias name: smart" },
    ]);
  });
});

describe("alias configuration files", () => {
  const aliases: ModelAlias[] = [
    { name: "smart", target: { provider: "zai", model: "glm" } },
  ];

  it("loads a missing file as an empty non-fatal config", () => {
    const config = loadAliasConfig(join(temporaryDirectory(), "missing.json"));

    expect(config).toEqual({ aliases: [], diagnostics: [], fatal: false });
  });

  it("reports malformed JSON without changing the file", () => {
    const configPath = join(temporaryDirectory(), "model-aliases.json");
    const original = '{"version": 1, "aliases": [\n';
    writeFileSync(configPath, original);

    const config = loadAliasConfig(configPath);

    expect(config.fatal).toBe(true);
    expect(config.aliases).toEqual([]);
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("creates parent directories and writes versioned JSON with a trailing newline", () => {
    const configPath = join(temporaryDirectory(), "nested", "model-aliases.json");

    writeAliasConfig(aliases, configPath);

    const contents = readFileSync(configPath, "utf8");
    expect(contents.endsWith("\n")).toBe(true);
    expect(JSON.parse(contents)).toEqual({ version: 1, aliases });
  });

  it("leaves no temporary sibling files after a successful write", () => {
    const directory = temporaryDirectory();
    const configPath = join(directory, "model-aliases.json");

    writeAliasConfig(aliases, configPath);

    expect(readdirSync(directory)).toEqual(["model-aliases.json"]);
  });

  it("preserves a destination and cleans up the temporary file when rename fails", () => {
    const directory = temporaryDirectory();
    const destination = join(directory, "model-aliases.json");
    mkdirSync(destination);
    const sentinel = join(destination, "sentinel");
    writeFileSync(sentinel, "unchanged");

    expect(() => writeAliasConfig(aliases, destination)).toThrow(/EISDIR|ENOTEMPTY|directory/);
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
    expect(readdirSync(directory)).toEqual(["model-aliases.json"]);
  });
});
