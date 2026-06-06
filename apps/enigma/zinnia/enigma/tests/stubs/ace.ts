// Lightweight stand-in for ace-builds so tests never spin up the real editor
// (it needs a live DOM/measure cycle that jsdom doesn't provide).
const editor = {
  setTheme() {},
  session: { setMode() {}, on() {} },
  setOptions() {},
  setValue() {},
  getValue() {
    return "";
  },
  destroy() {},
};

export default {
  config: { set() {} },
  edit() {
    return editor;
  },
};
