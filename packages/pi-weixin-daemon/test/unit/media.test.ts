import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { encryptAesEcb, decryptAesEcb, aesEcbPaddedSize } from "../../src/weixin/cdn/aes-ecb.js";
import { downloadAttachmentsFromMessage, detectImageMime } from "../../src/weixin/media/media-download.js";
import { getMimeFromFilename } from "../../src/weixin/media/mime.js";
import { createLogger } from "../../src/util/logger.js";

const logger = createLogger({ level: "silent" });

describe("aes-ecb", () => {
  it("roundtrips arbitrary buffers", () => {
    const key = Buffer.from("0123456789abcdef");
    const plain = Buffer.from("hello weixin media 微信");
    const encrypted = encryptAesEcb(plain, key);
    expect(decryptAesEcb(encrypted, key).toString("utf-8")).toBe(plain.toString("utf-8"));
  });

  it("padded size is 16-byte aligned", () => {
    expect(aesEcbPaddedSize(1)).toBe(16);
    expect(aesEcbPaddedSize(16)).toBe(32);
    expect(aesEcbPaddedSize(31)).toBe(32);
  });
});

describe("detectImageMime", () => {
  it("detects png/jpeg/gif/webp", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(detectImageMime(png)).toBe("image/png");
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(detectImageMime(jpg)).toBe("image/jpeg");
    const gif = Buffer.from("GIF89a", "ascii");
    expect(detectImageMime(gif)).toBe("image/gif");
    const webp = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii")]);
    expect(detectImageMime(webp)).toBe("image/webp");
    expect(detectImageMime(Buffer.from("nope"))).toBeUndefined();
  });
});

describe("getMimeFromFilename", () => {
  it("maps known extensions", () => {
    expect(getMimeFromFilename("a.pdf")).toBe("application/pdf");
    expect(getMimeFromFilename("b.ZIP")).toBe("application/zip");
    expect(getMimeFromFilename("c.unknown")).toBe("application/octet-stream");
  });
});

describe("downloadAttachmentsFromMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads, decrypts and saves an inbound image with detected mime", async () => {
    const inboxDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "inbox-"));
    const key = Buffer.from("0123456789abcdef");
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const ciphertext = encryptAesEcb(pngBytes, key);

    vi.stubGlobal("fetch", vi.fn(async () => {
      return new Response(new Uint8Array(ciphertext), { status: 200 });
    }));

    const raw = {
      message_id: 123,
      from_user_id: "user-1",
      item_list: [
        {
          type: 2, // IMAGE
          image_item: {
            aeskey: key.toString("hex"),
            media: { encrypt_query_param: "eqp-abc" },
          },
        },
      ],
    };

    const { attachments } = await downloadAttachmentsFromMessage(raw as never, { inboxDir, logger });
    expect(attachments).toHaveLength(1);
    const img = attachments[0]!;
    expect(img.kind).toBe("image");
    expect(img.mimeType).toBe("image/png");
    expect(fs.existsSync(img.localPath)).toBe(true);
    expect(fs.readFileSync(img.localPath)).toEqual(pngBytes);
    expect(img.localPath).toContain(path.join("123", "image.png"));
  });

  it("saves inbound files under <messageKey>/<filename> with sanitized name", async () => {
    const inboxDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "inbox-file-"));
    const key = Buffer.from("0123456789abcdef");
    const content = Buffer.from("pdf-content-here");
    const ciphertext = encryptAesEcb(content, key);
    // file aes_key is base64(hex string) per Tencent's format
    const aesKeyBase64 = Buffer.from(key.toString("hex"), "ascii").toString("base64");

    vi.stubGlobal("fetch", vi.fn(async () => {
      return new Response(new Uint8Array(ciphertext), { status: 200 });
    }));

    const raw = {
      message_id: 456,
      from_user_id: "user-1",
      item_list: [
        {
          type: 4, // FILE
          file_item: {
            file_name: "report\u0001.pdf",
            media: { encrypt_query_param: "eqp", aes_key: aesKeyBase64 },
          },
        },
      ],
    };

    const { attachments } = await downloadAttachmentsFromMessage(raw as never, { inboxDir, logger });
    expect(attachments).toHaveLength(1);
    const file = attachments[0]!;
    expect(file.kind).toBe("file");
    expect(file.filename).toBe("report\u0001.pdf");
    expect(fs.readFileSync(file.localPath).toString()).toBe("pdf-content-here");
    // sanitized on disk (control char stripped)
    expect(path.basename(file.localPath)).toBe("report.pdf");
  });

  it("records failing items as failures but still completes (no exception)", async () => {
    const inboxDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "inbox-skip-"));
    vi.stubGlobal("fetch", vi.fn(async () => {
      return new Response("oops", { status: 500 });
    }));
    const raw = {
      message_id: 789,
      from_user_id: "user-1",
      item_list: [
        { type: 4, file_item: { file_name: "x.pdf", media: { encrypt_query_param: "q", aes_key: "a2V5" } } },
        { type: 1, text_item: { text: "hi" } },
      ],
    };
    const { attachments, failures } = await downloadAttachmentsFromMessage(raw as never, { inboxDir, logger });
    expect(attachments).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe("file");
    expect(failures[0]?.filename).toBe("x.pdf");
  });
});
