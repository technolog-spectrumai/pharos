// Lightweight stand-in for ace-builds so tests never spin up the real editor
// (it needs a live DOM/measure cycle that jsdom doesn't provide).
const editor = {
  setTheme() {},
  session: { setMode() {}, on() {}, setValue() {} },
  commands: { addCommand() {} },
  setOptions() {},
  setValue() {},
  getValue() {
    return "";
  },
  focus() {},
  destroy() {},
};

export default {
  config: { set() {}, setModuleUrl() {} },
  edit() {
    return editor;
  },
};
