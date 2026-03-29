export class BranchManager {
  private repoRoot: string
  private originalBranch: string | null = null

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot
  }

  async saveOriginalBranch(): Promise<void> {
    this.originalBranch = await this.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"])
  }

  async createBranch(name: string): Promise<void> {
    await this.exec("git", ["checkout", "-b", name])
    console.log(`[git] created branch: ${name}`)
  }

  async commit(message: string): Promise<void> {
    // Stage all changes
    await this.exec("git", ["add", "-A"])

    // Check if there's anything to commit
    const status = await this.exec("git", ["status", "--porcelain"])
    if (!status.trim()) {
      console.log("[git] nothing to commit")
      return
    }

    await this.exec("git", ["commit", "-m", message])
    console.log(`[git] committed: ${message.slice(0, 60)}`)
  }

  async push(): Promise<void> {
    await this.exec("git", ["push", "-u", "origin", "HEAD"])
    console.log("[git] pushed to origin")
  }

  async getCurrentBranch(): Promise<string> {
    return this.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"])
  }

  async discardChanges(): Promise<void> {
    await this.exec("git", ["checkout", "--", "."])
    console.log("[git] discarded changes")
  }

  async restoreOriginalBranch(): Promise<void> {
    if (this.originalBranch) {
      await this.exec("git", ["checkout", this.originalBranch])
      console.log(`[git] restored branch: ${this.originalBranch}`)
    }
  }

  async deleteBranch(name: string): Promise<void> {
    await this.exec("git", ["branch", "-D", name])
    console.log(`[git] deleted branch: ${name}`)
  }

  async getDiffSummary(): Promise<string> {
    return this.exec("git", ["diff", "--stat"])
  }

  private async exec(cmd: string, args: string[]): Promise<string> {
    const proc = Bun.spawnSync([cmd, ...args], {
      cwd: this.repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    })

    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString().trim()
      throw new Error(`git command failed: ${cmd} ${args.join(" ")}\n${stderr}`)
    }

    return proc.stdout.toString().trim()
  }
}
