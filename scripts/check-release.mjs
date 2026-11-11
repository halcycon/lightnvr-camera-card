import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
const dir = resolve(process.env.LIGHTNVR_BUILD_DIR ?? "dist");
const names = await readdir(dir);
if (names.length !== 1 || names[0] !== "lightnvr-camera-card.js")
  throw new Error("Expected exactly one release ES module");
const code = await readFile(resolve(dir, names[0]), "utf8");
if (!code.includes("lightnvr-camera-card"))
  throw new Error("Missing card registration");
if (/from\s*["']https?:|import\s*\(\s*["']https?:|sourceMappingURL/.test(code))
  throw new Error("Remote import or source map in release");
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  const notice = await readFile(file, "utf8");
  if (!code.includes(notice))
    throw new Error("Missing complete distribution notice: " + file);
}
await readFile("README.md");
const hacs = JSON.parse(await readFile("hacs.json", "utf8"));
if (hacs.filename !== "lightnvr-camera-card.js")
  throw new Error("HACS bundle filename mismatch");
console.log(
  "PASS release file shape and required metadata (installation not verified)",
);
