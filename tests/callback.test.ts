/**
 * The public GitHub Pages callback page, in a real browser: correct forwarding,
 * no XSS with hostile query strings, code removed from history, CSP in force.
 */
import { expect } from "chai";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import type { Browser, Page } from "playwright";

const root = join(__dirname, "..");
const html = readFileSync(join(root, "callback/index.html"), "utf8");

describe("callback page (GitHub Pages) in a browser", function () {
  this.timeout(60000);
  let browser: Browser;

  before(async function () {
    try {
      browser = await (createRequire(join(root, "package.json"))("playwright") as typeof import("playwright")).chromium.launch();
    } catch {
      this.skip();
    }
  });
  after(async () => browser?.close());

  async function open(qs: string): Promise<{ page: Page; navigations: string[]; dialogs: string[]; consoleErrors: string[] }> {
    const page = await browser.newPage();
    const navigations: string[] = [];
    const dialogs: string[] = [];
    const consoleErrors: string[] = [];
    page.on("dialog", async (d) => {
      dialogs.push(d.message());
      await d.dismiss();
    });
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("request", (r) => r.url().startsWith("obsidian:") && navigations.push(r.url()));
    await page.route("https://heeralaljrahul.github.io/**", (r) => r.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`https://heeralaljrahul.github.io/obsidian-remote-sync/callback/${qs}`, { waitUntil: "commit" }).catch(() => {});
    await page.waitForTimeout(200);
    return { page, navigations, dialogs, consoleErrors };
  }

  it("forwards code and state (only those) to obsidian://gdrive-sync-auth and removes the code from the address bar", async () => {
    const { page, navigations } = await open("?state=abc&code=4%2F0Ab-c_d&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive&authuser=0");
    expect(navigations[0]).to.equal("obsidian://gdrive-sync-auth?code=4%2F0Ab-c_d&state=abc");
    expect(page.url()).to.equal("https://heeralaljrahul.github.io/obsidian-remote-sync/callback/");
    expect(await page.locator("#code").textContent()).to.equal("4/0Ab-c_d");
  });

  const payloads = [`"><img src=x onerror=alert(1)>`, `<script>alert(1)</script>`, `javascript:alert(1)`, `'};alert(1);//`, `&action=evil&code=x`];
  for (const p of payloads) {
    it(`hostile input is inert: ${p}`, async () => {
      const q = new URLSearchParams({ code: p, state: p, error: "" }).toString();
      const { page, navigations, dialogs } = await open(`?${q}`);
      expect(dialogs).to.deep.equal([]);
      expect(await page.locator("img").count()).to.equal(0);
      expect(await page.locator("script").count()).to.equal(1);
      expect(navigations[0]).to.match(/^obsidian:\/\/gdrive-sync-auth\?code=/);
      const fwd = new URL(navigations[0]);
      expect(fwd.searchParams.get("code")).to.equal(p);
      expect([...fwd.searchParams.keys()].sort()).to.deep.equal(["code", "state"]);
    });
  }

  it("an error from Google is shown as text and forwarded; a bare visit does nothing", async () => {
    const e = await open("?error=%3Cb%3Eaccess_denied%3C%2Fb%3E&state=s");
    expect(await e.page.locator("#msg").textContent()).to.contain("<b>access_denied</b>");
    expect(await e.page.locator("#msg *").count()).to.equal(0, "rendered as text, not HTML");
    expect(e.navigations[0]).to.contain("error=");
    const bare = await open("");
    expect(bare.navigations).to.deep.equal([]);
    expect(await bare.page.locator("#title").textContent()).to.equal("Nothing to do here");
  });

  it("CSP allows exactly the page's own script (hash matches) and blocks everything else", async () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const hash = createHash("sha256").update(script).digest("base64");
    expect(html).to.contain(`script-src 'sha256-${hash}'`);
    expect(html).to.match(/default-src 'none'/);
    const { page, consoleErrors } = await open("?code=x&state=y");
    expect(consoleErrors.filter((m) => /Content Security Policy/.test(m))).to.deep.equal([]);
    // an injected inline script would be refused
    const blocked = await page.evaluate(() => {
      const s = document.createElement("script");
      s.textContent = "window.__pwned = 1";
      document.body.appendChild(s);
      return (window as unknown as { __pwned?: number }).__pwned === undefined;
    });
    expect(blocked).to.equal(true);
  });
});
