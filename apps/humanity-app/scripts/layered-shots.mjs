// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const outDir = process.argv[2] ?? "layered-shots";
const baseUrl = process.argv[3] ?? "http://127.0.0.1:5183";

const VIEWPORT = { width: 390, height: 844 };
const STATUS_BAR = 47;
const HOME_BAR = 34;
const FACE = { top: STATUS_BAR + 12, left: 16, height: 226 };
const FACE_BOTTOM = FACE.top + FACE.height;

const HOSTS = {
  layered: { top: FACE_BOTTOM, bottom: HOME_BAR, face: true },
  tab: { top: STATUS_BAR, bottom: HOME_BAR, face: false },
  browser: { top: 0, bottom: 0, face: false },
};

const SCREENS = [
  { name: "member", hash: "#/?demo=member" },
  { name: "candidate", hash: "#/?demo=candidate" },
  { name: "not-enrolled", hash: "#/?demo=not-enrolled" },
  { name: "suspended", hash: "#/?demo=suspended" },
  { name: "caution-sheet", hash: "#/?demo=caution-today" },
  { name: "promotion", hash: "#/?demo=promotion" },
  { name: "scratch", hash: "#/scratch?demo=win" },
  { name: "claim-username", hash: "#/claim-username" },
  { name: "empty", hash: "#/" },
  { name: "debug-page", hash: "#/debug" },
];

const only = process.env.SHOTS?.split(",");

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [hostName, host] of Object.entries(HOSTS)) {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    for (const screen of SCREENS) {
      if (only != null && !only.includes(screen.name)) continue;
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setSafeAreaInsetsOverride", {
        insets: { top: host.top, bottom: host.bottom },
      });
      await page.goto(`${baseUrl}/${screen.hash}`);
      await page.evaluate(
        ({ face, drawFace }) => {
          const style = document.createElement("style");
          style.textContent =
            "html{background:#3b1d6e}" +
            "#stand-in-face{position:fixed;z-index:-1;border-radius:22px;" +
            "background:linear-gradient(135deg,#f7d774,#b9832b);display:grid;place-items:center;" +
            "font:700 20px system-ui;color:#3a2a08}";
          document.head.append(style);
          if (!drawFace) return;
          const el = document.createElement("div");
          el.id = "stand-in-face";
          el.textContent = "NATIVE FACE";
          el.style.cssText = `top:${face.top}px;left:${face.left}px;right:${face.left}px;height:${face.height}px`;
          document.body.prepend(el);
        },
        { face: FACE, drawFace: host.face },
      );
      await page.waitForTimeout(2500);
      await page.screenshot({ path: join(outDir, `${hostName}-${screen.name}.png`) });
      await page.close();
    }
    await context.close();
  }
} finally {
  await browser.close();
}
