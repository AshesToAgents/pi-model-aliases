import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  Container,
  Input,
  SelectList,
  Text,
  type Component,
  type SelectItem,
  type TUI,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { normalizeAliasName } from "./config.js";
import { INVALID_NAME_ERROR, type AliasManagerUI } from "./manager.js";
import type { LoadedAliasConfig, ModelAlias } from "./types.js";

interface PickerItem<T> {
  key: string;
  value: T;
  label: string;
  description?: string;
  searchText: string;
}

function targetId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function pickerTheme(theme: Theme) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

class SearchPicker<T> implements Component {
  private readonly input: Input;
  private readonly container: Container;
  private list: SelectList;
  private _focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly title: string,
    private readonly items: readonly PickerItem<T>[],
    private readonly done: (value: T | undefined) => void,
    private readonly diagnostics: readonly string[] = [],
  ) {
    this.input = new Input({ prompt: `${theme.fg("accent", "Search")} ` });
    this.container = new Container();
    this.list = this.createList("");
    this.rebuild();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "tui.select.up") ||
      this.keybindings.matches(data, "tui.select.down") ||
      this.keybindings.matches(data, "tui.select.confirm") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.list.handleInput(data);
      this.tui.requestRender();
      return;
    }

    const before = this.input.getValue();
    this.input.handleInput(data);
    const after = this.input.getValue();
    if (before !== after) {
      this.list = this.createList(after);
      this.rebuild();
    }
    this.tui.requestRender();
  }

  invalidate(): void {
    this.container.invalidate();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  private createList(query: string): SelectList {
    const normalizedQuery = query.toLowerCase();
    const visibleItems = this.items.filter((item) =>
      item.searchText.toLowerCase().includes(normalizedQuery),
    );
    // SelectList filters by `value.startsWith(filter)` when setFilter() is
    // called; items are already filtered here, so the list is constructed with
    // exactly the visible items and its internal filter stays untouched.
    const selectItems: SelectItem[] = visibleItems.map((item) => ({
      value: item.key,
      label: item.label,
      description: item.description,
    }));
    const list = new SelectList(
      selectItems,
      Math.min(Math.max(selectItems.length, 1), 10),
      pickerTheme(this.theme),
    );
    list.onSelect = (selected) => {
      const item = this.items.find((candidate) => candidate.key === selected.value);
      if (item) this.done(item.value);
    };
    list.onCancel = () => this.done(undefined);
    return list;
  }

  private rebuild(): void {
    this.container.clear();
    this.container.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.title))));
    if (this.diagnostics.length > 0) {
      this.container.addChild(new Text(this.theme.fg("warning", "Configuration diagnostics:")));
      for (const diagnostic of this.diagnostics) {
        this.container.addChild(new Text(this.theme.fg("warning", `• ${diagnostic}`)));
      }
    }
    this.container.addChild(this.input);
    this.container.addChild(this.list);
    this.container.addChild(
      new Text(this.theme.fg("dim", "↑↓ navigate • type to search • enter select • esc cancel")),
    );
  }
}

function customPicker<T>(
  ctx: ExtensionCommandContext,
  title: string,
  items: readonly PickerItem<T>[],
  diagnostics: readonly string[] = [],
): Promise<T | undefined> {
  return ctx.ui.custom<T | undefined>((tui, theme, keybindings, done) => {
    return new SearchPicker(tui, theme, keybindings, title, items, done, diagnostics);
  });
}

export function createManagerUI(ctx: ExtensionCommandContext): AliasManagerUI {
  return {
    async selectAlias(config: LoadedAliasConfig, availableTargetIds) {
      const items: PickerItem<ModelAlias | "add">[] = [
        {
          key: "__add__",
          value: "add",
          label: "Add model alias",
          description: "Create a new aliases/<name> route",
          searchText: "add new model alias",
        },
        ...config.aliases.map((alias) => {
          const id = targetId(alias.target.provider, alias.target.model);
          const unavailable = !availableTargetIds.has(id);
          return {
            key: alias.name,
            value: alias,
            label: `aliases/${alias.name}`,
            description: `${id}${unavailable ? " (unavailable)" : ""}`,
            searchText: `${alias.name} ${id} ${unavailable ? "unavailable" : ""}`,
          };
        }),
      ];
      const diagnostics = config.diagnostics.map(
        (diagnostic) => `${diagnostic.path}: ${diagnostic.message}`,
      );
      return customPicker(ctx, "Manage model aliases", items, diagnostics);
    },

    async selectAction(alias) {
      return ctx.ui.select(`Manage aliases/${alias.name}`, ["retarget", "rename", "remove"]) as Promise<
        "retarget" | "rename" | "remove" | undefined
      >;
    },

    async inputName(title, initial) {
      let placeholder = initial;
      while (true) {
        const value = await ctx.ui.input(title, placeholder);
        if (value === undefined) {
          return undefined;
        }

        const normalized = normalizeAliasName(value);
        if (normalized === undefined) {
          ctx.ui.notify(INVALID_NAME_ERROR, "error");
          placeholder = value;
          continue;
        }

        if (await ctx.ui.confirm(title, `Use aliases/${normalized}?`)) {
          return value;
        }
        placeholder = value;
      }
    },

    async selectTarget(models: readonly Model<Api>[]) {
      const items: PickerItem<Model<Api>>[] = models.map((model) => {
        const displayName = model.name ?? model.id;
        const id = targetId(model.provider, model.id);
        return {
          key: id,
          value: model,
          label: id,
          description: displayName,
          searchText: `${model.provider} ${model.id} ${displayName}`,
        };
      });
      return customPicker(ctx, "Select physical model target", items);
    },

    confirmRemove(alias) {
      return ctx.ui.confirm(
        "Remove model alias",
        `Remove aliases/${alias.name}? This changes the saved configuration.`,
      );
    },

    notify(message, kind) {
      ctx.ui.notify(message, kind);
    },
  };
}
