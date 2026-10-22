// File helpers that have nothing to do with any one editor: how to show a size
// and a date, what a path's last component is, and which bytes are a picture.
export { formatSize, formatDate, baseName } from "./format";
export { IMAGE_MIME, isImageName, toDataUri } from "./images";

// The workspace store — one folder, browsed. Shared because three apps must not
// hold three opinions about what is on disk, and because the sealed-file probe
// cache belongs with the tree it badges.
export {
  useWorkspace, setSealProbe, setFileBackend, filterRows,
  type Entry, type Row, type SealProbe, type FileBackend,
} from "./useWorkspace";
