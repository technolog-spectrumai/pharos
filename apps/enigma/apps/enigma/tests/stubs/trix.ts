// Inert stand-in for `trix` under jsdom. The real module registers the
// <trix-editor>/<trix-toolbar> custom elements at import time and drives a
// contenteditable surface; component tests only need the import to succeed —
// editor behavior is covered through the orchestrator's plain-string API.
export default {};
