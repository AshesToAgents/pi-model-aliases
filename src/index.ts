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
}

function registerAliasCommand(
  pi: ExtensionAPI,
  runtime: AliasRuntime,
  configPath: string,
): void {
  pi.registerCommand("model-aliases", {
    description: "Manage model aliases",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        const config = loadAliasConfig(configPath);
        const targets = filterPhysicalTargets(ctx.modelRegistry.getAvailable());
        pi.sendMessage(
          {
            customType: "model-aliases",
            content: formatAliasReport(
              config,
              new Set(targets.map((target) => `${target.provider}/${target.id}`)),
            ),
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
  const runtime = new AliasRuntime(pi);
  const config = loadAliasConfig(configPath);

  if (!config.fatal) {
    runtime.initialize(config.aliases);
  }

  registerAliasCommand(pi, runtime, configPath);
  return runtime;
}

export default function modelAliasesExtension(pi: ExtensionAPI): void {
  activateModelAliases(pi);
}
