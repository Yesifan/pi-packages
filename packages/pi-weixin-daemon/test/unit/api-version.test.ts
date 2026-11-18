import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGetFetch, getUpdates } from "../../src/weixin/api/api.js";

const { version } = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
) as { version: string };

// iLink encodes the three version components as 0x00MMNNPP.
const clientVersion = version
  .split(".")
  .reduce((encoded, component) => encoded * 256 + (Number.parseInt(component, 10) & 0xff), 0);

afterEach(() => vi.unstubAllGlobals());

describe("Weixin API version metadata", () => {
  it("sends the manifest version in POST metadata and POST/GET headers", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ ret: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const baseUrl = "https://weixin.invalid/";

    await getUpdates({ baseUrl });
    await apiGetFetch({ baseUrl, endpoint: "ilink/bot/get_bot_qrcode", label: "test" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const post = fetchMock.mock.calls[0]?.[1];
    const get = fetchMock.mock.calls[1]?.[1];
    expect(post?.method).toBe("POST");
    expect(get?.method).toBe("GET");
    expect.soft(JSON.parse(String(post?.body)).base_info).toEqual({
      channel_version: version,
      bot_agent: `pi-weixin-daemon/${version}`,
    });
    for (const request of [post, get]) {
      const headers = new Headers(request?.headers);
      expect.soft(headers.get("iLink-App-ClientVersion")).toBe(String(clientVersion));
      expect(headers.get("iLink-App-Id")).toBe("bot");
    }
  });
});
