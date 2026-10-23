// Which names are pictures, and turning their bytes into something an <img>
// can show.
//
// One table, shared by the file panel and the deck editor, so the two cannot
// disagree about whether a `.bmp` previews. The byte conversion is pinned at
// sizes a naive version cannot survive.
import { describe, expect, it } from "vitest";
import { IMAGE_MIME, isImageName, toDataUri } from "../../src/files/images";

describe("recognising a picture by its name", () => {
  it.each(["photo.png", "photo.jpg", "photo.jpeg", "anim.gif", "shot.webp", "old.bmp", "favicon.ico", "new.avif"])(
    "previews %s",
    (name) => {
      expect(isImageName(name)).toBe(true);
    },
  );

  it("ignores the case of the extension", () => {
    // Cameras write `IMG_0001.JPG`. A case-sensitive check would open every
    // phone photo as text.
    expect(isImageName("IMG_0001.JPG")).toBe(true);
    expect(isImageName("Logo.Png")).toBe(true);
  });

  it("does not preview an svg, which has an editor and can carry a script", () => {
    expect(isImageName("diagram.svg")).toBe(false);
  });

  it("judges only the last extension", () => {
    expect(isImageName("backup.png.zip")).toBe(false);
    expect(isImageName("archive.tar.png")).toBe(true);
  });

  it("does not take a dotfile's whole name as its extension", () => {
    // `.png` is a hidden file named "png", not a picture with no name.
    expect(isImageName(".png")).toBe(false);
    expect(isImageName("README")).toBe(false);
  });

  it("is not fooled by an extension that names an object built-in", () => {
    // The lookup is an own-property check, so a file called `x.constructor`
    // does not find Object's constructor on the table's prototype.
    expect(isImageName("x.constructor")).toBe(false);
    expect(isImageName("x.__proto__")).toBe(false);
  });
});

describe("bytes as a data URI", () => {
  it("labels the bytes with the MIME type the extension calls for", () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    expect(toDataUri("p.png", png)).toBe("data:image/png;base64,iVBORw==");
    expect(toDataUri("p.JPG", png)).toBe("data:image/jpeg;base64,iVBORw==");
    expect(toDataUri("p.ico", png)).toBe(`data:${IMAGE_MIME.ico};base64,iVBORw==`);
  });

  it("falls back to an opaque type for a name that is not a picture", () => {
    // Labelled as octet-stream, an <img> refuses it rather than guessing.
    expect(toDataUri("notes.txt", new Uint8Array([104, 105]))).toBe(
      "data:application/octet-stream;base64,aGk=",
    );
    expect(toDataUri("diagram.svg", new Uint8Array([60]))).toBe(
      "data:application/octet-stream;base64,PA==",
    );
  });

  it("encodes an empty file as an empty payload", () => {
    expect(toDataUri("blank.png", new Uint8Array())).toBe("data:image/png;base64,");
  });

  it("encodes a picture far larger than one argument list, byte for byte", () => {
    // A megabyte spread into String.fromCharCode in one call exceeds the
    // engine's argument limit. Chunked, it must also come out exact: a chunk
    // boundary that dropped or repeated a byte would corrupt the picture
    // without failing, so the whole payload is compared.
    const bytes = new Uint8Array(1 << 20);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;

    const uri = toDataUri("big.png", bytes);

    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
    expect(uri.slice("data:image/png;base64,".length)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("encodes a buffer that ends exactly on a chunk boundary", () => {
    // 0x8000 is the chunk size. An off-by-one loop bound either skips the
    // last chunk or reads an empty one past the end.
    const bytes = new Uint8Array(0x8000 * 2).fill(0xab);
    expect(toDataUri("edge.png", bytes)).toBe(
      `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
    );
  });
});
