// A recording stand-in for ACE, for tests that mount the notes editor. ACE needs
// a live layout/measure cycle jsdom does not have, so a test replaces
// aceSetup's default export with this and keeps the real mode table:
//
//   vi.mock("../../src/components/local/aceSetup", async (importOriginal) => ({
//     ...(await importOriginal<typeof import("../../src/components/local/aceSetup")>()),
//     default: (await import("../stubs/fakeAce")).fakeAce,
//   }));
//
// Each mount gets its own editor; `type()` and `press()` play the user's part.

export interface FakeAceCommand {
  name: string;
  bindKey: { win: string; mac: string };
  exec: () => void;
}

export interface FakeAceEditor {
  host: HTMLElement;
  options: Record<string, unknown>;
  /** Every setTheme / setMode call, in order. */
  themes: string[];
  modes: string[];
  commands: FakeAceCommand[] & { addCommand(c: FakeAceCommand): void };
  focused: number;
  destroyed: number;
  session: {
    setValue(v: string): void;
    on(event: string, fn: () => void): void;
    setMode(mode: string): void;
  };
  getValue(): string;
  setTheme(theme: string): void;
  focus(): void;
  destroy(): void;
  /** What typing does: the buffer changes and ACE fires "change". */
  type(next: string): void;
  /** Run a bound command, as its keyboard shortcut would. */
  press(name: string): void;
}

function makeEditor(host: HTMLElement, options: Record<string, unknown>): FakeAceEditor {
  let value = "";
  const onChange: Array<() => void> = [];
  const editor: FakeAceEditor = {
    host,
    options,
    themes: [],
    modes: [],
    commands: Object.assign([] as FakeAceCommand[], {
      addCommand(this: FakeAceCommand[], c: FakeAceCommand) {
        this.push(c);
      },
    }),
    focused: 0,
    destroyed: 0,
    session: {
      setValue(v) {
        value = v;
      },
      on(event, fn) {
        if (event === "change") onChange.push(fn);
      },
      setMode(mode) {
        editor.modes.push(mode);
      },
    },
    getValue: () => value,
    setTheme(theme) {
      editor.themes.push(theme);
    },
    focus() {
      editor.focused += 1;
    },
    destroy() {
      editor.destroyed += 1;
    },
    type(next) {
      value = next;
      for (const fn of onChange) fn();
    },
    press(name) {
      const cmd = editor.commands.find((c) => c.name === name);
      if (!cmd) throw new Error(`no ACE command ${name}`);
      cmd.exec();
    },
  };
  return editor;
}

const editors: FakeAceEditor[] = [];

export const fakeAce = {
  edit(host: HTMLElement, options: Record<string, unknown>): FakeAceEditor {
    const e = makeEditor(host, options);
    editors.push(e);
    return e;
  },
  /** The editor the most recent mount created. */
  last(): FakeAceEditor {
    const e = editors[editors.length - 1];
    if (!e) throw new Error("no ACE editor was created");
    return e;
  },
  count(): number {
    return editors.length;
  },
  reset(): void {
    editors.length = 0;
  },
};
