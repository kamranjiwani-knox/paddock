import type { SandboxResult } from "../types"

export class Sandbox {
  constructor(private repoRoot: string) {}

  /**
   * Validate the codebase still compiles and builds after patches.
   * Runs type-check and build in sequence.
   */
  async validate(): Promise<SandboxResult> {
    const errors: string[] = []

    // Type check
    const tsc = Bun.spawnSync(["bun", "tsc", "--noEmit"], {
      cwd: this.repoRoot,
      stderr: "pipe",
      stdout: "pipe",
    })
    if (tsc.exitCode !== 0) {
      errors.push(`TypeCheck failed:\n${tsc.stderr.toString().slice(0, 2000)}`)
    }

    // Build check
    const build = Bun.spawnSync(
      ["bun", "build", "src/index.ts", "--outdir", "/tmp/paddock-build", "--target", "bun"],
      {
        cwd: this.repoRoot,
        stderr: "pipe",
        stdout: "pipe",
      }
    )
    if (build.exitCode !== 0) {
      errors.push(`Build failed:\n${build.stderr.toString().slice(0, 2000)}`)
    }

    return { ok: errors.length === 0, errors }
  }
}
