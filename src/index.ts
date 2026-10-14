import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getAliasConfigPath, loadAliasConfig, writeAliasConfig } from "./config.js";
import {
  filterPhysicalTargets,
  formatAliasReport,
  runAliasManager,
} from "./manager.js";
import { createManagerUI } from "./ui.js";
import { AliasRuntime } from "./runtime.js";

export interface ModelAliasesActivationOptions {
  configPath?: string;
  /** Replaced in tests; writes human-visible output for print mode. */
  writeOutput?: (text: string) => void;
}

function registerAliasCommand(
  pi: ExtensionAPI,
  runtime: AliasRuntime,
  configPath: string,
  writeOutput: (text: string) => void,
): void {
  pi.registerCommand("model-aliases", {
    description: "Manage model aliases",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        const config = loadAliasConfig(configPath);
        const targets = filterPhysicalTargets(ctx.modelRegistry.getAvailable());
        const report = formatAliasReport(
          config,
          new Set(targets.map((target) => `${target.provider}/${target.id}`)),
        );
        // Print mode outputs only the final assistant message, so a command
        // report must be written to stdout itself. RPC and JSON modes receive
        // the custom message through session events instead.
        if (ctx.mode === "print") {
          writeOutput(`${report}\n`);
        }
        pi.sendMessage(
          {
            customType: "model-aliases",
            content: report,
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      await runAliasManager(
        {
          pi,
          runtime,
          configPath,
          load: loadAliasConfig,
          write: writeAliasConfig,
          createUI: createManagerUI,
        },
        ctx,
      );
    },
  });
}

export function activateModelAliases(
  pi: ExtensionAPI,
  options: ModelAliasesActivationOptions = {},
): AliasRuntime {
  const configPath = options.configPath ?? getAliasConfigPath();
  const writeOutput =
    options.writeOutput ?? ((text: string) => {
      process.stdout.write(text);
    });
  const runtime = new AliasRuntime(pi);
  const config = loadAliasConfig(configPath);

  if (!config.fatal) {
    runtime.initialize(config.aliases);
  }

  registerAliasCommand(pi, runtime, configPath, writeOutput);
  return runtime;
}

export default function modelAliasesExtension(pi: ExtensionAPI): void {
  activateModelAliases(pi);
}
