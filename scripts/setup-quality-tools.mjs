// Install the pinned developer CLIs locally; no system/profile changes.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, chmod, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
const platforms = {
  "linux-x64": [
    "x86_64-unknown-linux-musl",
    "linux_amd64",
    "409044617b6f06517c1035e55ca38c8c856ff8b650e41bc2aa1ef82d5903a23e",
    "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
  ],
  "linux-arm64": [
    "aarch64-unknown-linux-musl",
    "linux_arm64",
    "23871b1702bfd550fb5f901778fd4290ecf2ee034a45a889fbe96d89b188086d",
    "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
  ],
  "darwin-x64": [
    "x86_64-apple-darwin",
    "darwin_amd64",
    "036ead9df9bc31dbae9934ae3b4236ed124d0bafcffd33439460ae084d5c9cb7",
    "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
  ],
  "darwin-arm64": [
    "aarch64-apple-darwin",
    "darwin_arm64",
    "6574cea774ed4cae12e24b6aa11857de33e80dab4667cf628fd5840df96a2a9d",
    "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
  ],
};
const platform = platforms[process.platform + "-" + process.arch];
if (!platform)
  throw Error("Use Linux/macOS, WSL, or the Nix development shell");
const [justTarget, actionlintTarget, justHash, actionlintHash] = platform;
const bin = resolve(".execution/quality-tools/bin");
await mkdir(bin, { recursive: true });
for (const [name, url, expected] of [
  [
    "just",
    `https://github.com/casey/just/releases/download/1.59.0/just-1.59.0-${justTarget}.tar.gz`,
    justHash,
  ],
  [
    "actionlint",
    `https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_${actionlintTarget}.tar.gz`,
    actionlintHash,
  ],
]) {
  const temp = await mkdtemp(resolve(".execution/quality-tools/download-"));
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw Error("Developer CLI download failed: " + name);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      throw Error("Developer CLI checksum mismatch: " + name);
    const archive = join(temp, "archive.tar.gz");
    await writeFile(archive, bytes);
    // Extract only the named binary, never arbitrary archive paths.
    execFileSync("tar", ["-xzf", archive, "-C", temp, name]);
    await chmod(join(temp, name), 0o755);
    await rename(join(temp, name), join(bin, name));
    console.log(
      "Installed checksum-verified " +
        name +
        " in .execution/quality-tools/bin",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
