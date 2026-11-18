import { requestUrl } from "obsidian";
import { lowerHeaders, type HttpFn, type HttpResponse } from "../gdrive/http";

/**
 * Every network call in the plugin goes through Obsidian's requestUrl, which
 * is not subject to CORS on desktop or iOS. `text` is decoded lazily so large
 * binary downloads aren't also turned into a giant string.
 */
export const obsidianHttp: HttpFn = async (req) => {
  const r = await requestUrl({
    url: req.url,
    method: req.method ?? "GET",
    headers: req.headers,
    body: req.body,
    contentType: req.contentType,
    throw: false,
  });
  let text: string | undefined;
  const res: HttpResponse = {
    status: r.status,
    headers: lowerHeaders(r.headers),
    get arrayBuffer() {
      return r.arrayBuffer;
    },
    get text() {
      if (text === undefined) {
        try {
          text = r.text;
        } catch {
          text = "";
        }
      }
      return text;
    },
  };
  return res;
};
