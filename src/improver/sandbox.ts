import type { SandboxResult } from "../types"
import { existsSync } from "fs"
import { join } from "path"

export class Sandbox {
  constructor(private repoRoot: string) {}

  /**
   * Validate the codebase still compiles after patches.
   * Adapts to what's available in the target repo.
   */
  async validate(): Promise<SandboxResult> {
    const errors: string[] = []

    // 1. Try TypeScript check — only if tsc is available
    const hasTsc = existsSync(join(this.repoRoot, "node_modules/.bin/tsc")) ||
                   existsSync(join(this.repoRoot, "node_modules/typescript"))

    if (hasTsc) {
      const tsc = Bun.spawnSync(["bunx", "tsc", "--noEmit"], {
        cwd: this.repoRoot,
        stderr: "pipe",
        stdout: "pipe",
        timeout: 60_000,
      })
      if (tsc.exitCode !== 0) {
        const stderr = tsc.stderr.toString().slice(0, 2000)
        // Ignore external dependency errors (playwright, electron, etc.)
        const lines = stderr.split("\n").filter(l =>
          l.includes("error TS") &&
          !l.includes("node_modules") &&
          !l.includes("Cannot find module")
        )
        if (lines.length > 0) {
          errors.push(`TypeCheck failed:\n${lines.join("\n")}`)
        }
      }
    } else {
      console.log("[sandbox] tsc not found, skipping type check")
    }

    // 2. Syntax check — try to parse modified .ts files with Bun
    //    This catches syntax errors even without full tsc
    const syntaxCheck = Bun.spawnSync(
      ["bun", "run", "--bun", "-e", `
        const { Glob } = require("bun");
        const glob = new Glob("src/**/*.ts");
        let failed = false;
        for (const file of glob.scanSync("${this.repoRoot}")) {
          try {
            new Bun.Transpiler().transformSync(require("fs").readFileSync("${this.repoRoot}/" + file, "utf-8"));
          } catch(e) {
            console.error(file + ": " + e.message);
            failed = true;
          }
        }
        if (failed) process.exit(1);
      `],
      {
        cwd: this.repoRoot,
        stderr: "pipe",
        stdout: "pipe",
        timeout: 30_000,
      }
    )
    if (syntaxCheck.exitCode !== 0) {
      const stderr = syntaxCheck.stderr.toString().slice(0, 2000)
      if (stderr.trim()) {
        errors.push(`Syntax check failed:\n${stderr}`)
      }
    }

    // 3. Check that modified .md files are valid (SOUL.md, skills)
    //    Just verify they're not empty or corrupted
    const soulMd = join(this.repoRoot, ".agent", "SOUL.md")
    if (existsSync(soulMd)) {
      const content = await Bun.file(soulMd).text()
      if (content.trim().length < 10) {
        errors.push("SOUL.md is empty or too short (< 10 chars)")
      }
    }

    return { ok: errors.length === 0, errors }
  }
}
