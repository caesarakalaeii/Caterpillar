/**
 * The environment every spawned process gets. See DESIGN.md §8.1.
 *
 * A runner is missing toolchains a repo needs — lua here, go there — and until now there
 * was no way to say so. `requires` could not express it (a capability is a fact about a
 * machine, not something a machine can install for itself, §8), and nothing in the
 * supervisor ever SET an environment: all four spawn sites took the inherited one, so the
 * only lever was the base image, which every runner then pays for.
 *
 * This module is that lever. It answers one question — "what environment should this
 * task's commands run in" — and every process the supervisor starts on a task's behalf
 * takes its answer:
 *
 *   agent bash        src/agent/runner.ts
 *   review council    src/review/council.ts
 *   plan maintainer   src/plan/maintain.ts
 *   acceptance gate   src/supervisor/verifier.ts
 *
 * ALL FOUR, from one function, is the point. They used to disagree: the agent got pi's
 * fallback `sh -c` with the supervisor's environment while the verifier got a LOGIN bash
 * that sourced `/etc/profile` and `~/.profile`. A toolchain reachable from a shell profile
 * was therefore visible to the gate and invisible to the agent that had to make it pass —
 * the agent would see `lua: not found`, fix nothing, and watch a gate it could not
 * reproduce. One resolver, one shell, one environment, or the gate is not a gate.
 *
 * Resolution happens ONCE per session, not once per command. A command wrapper would put
 * quoting between the model and its own shell, and would re-pay the resolve on every
 * `bash` call the agent makes.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Capability, TaskSpec, ToolchainSpec } from "../domain/task.ts";
import type { ToolchainConfig } from "../config/types.ts";
import type { Logger } from "../obs/log.ts";

export interface ResolvedEnv {
  /**
   * Passed verbatim to `NodeExecutionEnv({ shellEnv })` and `execFile({ env })`.
   *
   * The two consume it differently and the difference is load-bearing: `execFile`
   * REPLACES the environment, while pi's `getShellEnv` OVERLAYS — `{...process.env,
   * ...shellEnv}`. They agree only because this map is always built up from the
   * supervisor's own environment rather than assembled from nothing. A future mode that
   * returns a bare env would silently be additive for the agent and exact for the
   * acceptance gate, which is the divergence this module exists to prevent.
   */
  readonly env: NodeJS.ProcessEnv;
  /**
   * ABSOLUTE path to the shell, not a name to look up. pi resolves `shellPath` with a
   * filesystem check and rejects anything it cannot stat, and handing `execFile` a bare
   * name would let the two sides find different binaries through different PATHs — which
   * is the divergence this module exists to close.
   */
  readonly shell: string;
  /**
   * Where it came from, in words — "inherited", "flake.nix devShell". Named in the
   * prompt so the agent knows what it has, and in the journal so a red gate can be read
   * back to an environment months later.
   */
  readonly source: string;
}

/**
 * A toolchain that was declared and could not be produced.
 *
 * Thrown, never swallowed. A task whose environment failed to materialise must PARK with
 * this message rather than fall through to the inherited one: falling through hands the
 * agent a shell missing the exact tool the task is about, and it spends a session (and a
 * few dollars) discovering that by hand.
 *
 * Declared as a field and assigned in the constructor rather than as a parameter
 * property — a parameter property emits runtime code and fails to LOAD under node's
 * type-stripping (DESIGN.md §16).
 */
export class ToolchainError extends Error {
  readonly source: string;

  constructor(source: string, message: string) {
    super(message);
    this.name = "ToolchainError";
    this.source = source;
  }
}

export interface ToolchainResolverOptions {
  readonly logger: Logger;
  readonly config: ToolchainConfig;
  /** Per-task scratch — the generated flake, the GC-root profile, the cached env. */
  readonly tasksDir: string;
  /**
   * The environment to inherit from. Injectable so a test does not have to mutate
   * `process.env`, which leaks across node's in-process test runner.
   */
  readonly baseEnv?: NodeJS.ProcessEnv;
}

export class ToolchainResolver {
  private readonly logger: Logger;
  private readonly config: ToolchainConfig;
  private readonly tasksDir: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  /** Memoised: the shell does not move while the process runs, and every task asks. */
  private shell: Promise<string> | undefined;
  /** 0 until the first idle poll — see `maybeCollectGarbage`. */
  private lastGcAt = 0;
  /** Memoised: nix does not appear or vanish while the process runs. */
  private nix: Promise<boolean> | undefined;

  constructor(options: ToolchainResolverOptions) {
    this.logger = options.logger;
    this.config = options.config;
    this.tasksDir = options.tasksDir;
    this.baseEnv = options.baseEnv ?? process.env;
  }

  /**
   * The environment for one task's commands.
   *
   * Resolution order, first match wins:
   *
   *   1. `spec.toolchain` — what a human wrote in the issue's `agent` block
   *   2. `<worktree>/flake.nix` — the repo's own devShell
   *   3. `<worktree>/shell.nix` — the same, pre-flakes
   *   4. nothing — the runner's environment, exactly as before §8.1
   *
   * The repo comes before nothing and after the human on purpose. Most repos that need a
   * toolchain already describe it for their human contributors, and reusing that
   * description means the agent works in the environment the tests were written in
   * rather than one somebody transcribed into a tracker issue.
   */
  async resolve(spec: TaskSpec, worktree: string): Promise<ResolvedEnv> {
    const shell = await this.taskShell();
    const plan = await this.plan(spec, worktree);

    if (plan === undefined) {
      return this.log(spec, { env: { ...this.baseEnv }, shell, source: "inherited" });
    }

    const env = await this.materialise(spec, worktree, plan);
    return this.log(spec, { env, shell, source: plan.source });
  }

  /**
   * The capabilities this runner should actually advertise (DESIGN.md §8.1).
   *
   * `nix` is DERIVED rather than declared, and it is the only capability that is. Every
   * other one asserts something no program can check — a GPU is wired in, a human is in
   * the room — so a person has to say it. "Can this machine build an environment" is
   * decided by whether nix runs, and asking is both exact and free.
   *
   * Deriving it is not tidiness. An explicit `toolchain: mode: nix` implies
   * `requires: [nix]` at intake, so a runner that HAS nix and does not say so leaves such
   * a task `ready` forever, claimable by nobody — the precise failure §8.1 exists to
   * remove, arriving through a stale ConfigMap instead of through the closed enum. And
   * that failure is silent: nothing logs, nothing errors, the task simply never moves.
   *
   * Config still wins where it can be right. A declaration is kept as-is (so an operator
   * who lists `nix` gets it), and a declaration that the machine cannot honour is a
   * warning rather than a removal — the operator may be installing nix next.
   */
  async capabilities(declared: readonly Capability[]): Promise<readonly Capability[]> {
    const available = await this.nixAvailable();

    if (declared.includes("nix")) {
      if (!available) {
        this.logger.warn("toolchain.capability-unbacked", {
          capability: "nix",
          detail: "advertised but nix is not runnable — tasks requiring it will park",
        });
      }
      return declared;
    }

    if (!available) return declared;

    this.logger.info("toolchain.capability-derived", {
      capability: "nix",
      detail: "nix is installed, so this runner advertises it without being told to",
    });
    return [...declared, "nix"];
  }

  private nixAvailable(): Promise<boolean> {
    // `--version` rather than anything that touches the store: this runs at boot, before
    // the supervisor serves /healthz, and an unreachable substituter must not delay it.
    // A nix that runs but has a broken store still parks its tasks, with nix's own error.
    this.nix ??= run("nix", ["--version"], {
      env: this.baseEnv,
      timeoutMs: PROBE_TIMEOUT_MS,
    }).then(({ code }) => code === 0);
    return this.nix;
  }

  /**
   * Collect the nix store, if it is time and if there is a nix store to collect.
   *
   * Called from the supervisor's idle branch, never mid-session — see the call site.
   * Best-effort in every direction: a runner with no nix has nothing to collect, and a
   * collection that fails is a disk-space problem for later, not a reason to stop working
   * tasks. It never throws.
   *
   * `--delete-older-than` rather than a size target, because the thing worth keeping is
   * "whatever a task used recently" and that is what an age bound expresses. Environments
   * belonging to live tasks are protected by the GC roots `print-dev-env --profile`
   * registers, so this cannot collect out from under a task that is merely between
   * sessions.
   */
  async maybeCollectGarbage(): Promise<void> {
    const now = Date.now();
    if (this.lastGcAt === 0) {
      // The first idle poll only starts the clock. Stamping at construction instead would
      // make a runner that is crash-looping every few minutes collect on every boot.
      this.lastGcAt = now;
      return;
    }
    if (now < this.lastGcAt + this.config.gcIntervalHours * 60 * 60 * 1000) return;
    this.lastGcAt = now;

    const args = ["--delete-older-than", `${this.config.gcKeepDays}d`];
    const { code, stderr } = await run("nix-collect-garbage", args, {
      env: this.baseEnv,
      timeoutMs: this.config.timeoutSeconds * 1000,
    });

    if (code === 0) {
      this.logger.info("toolchain.gc", { keepDays: this.config.gcKeepDays });
    } else if (stderr === NOT_INSTALLED("nix-collect-garbage")) {
      // A runner with no nix has no store to collect and is working as intended. At warn
      // this would be a daily complaint about a deliberate configuration.
      this.logger.debug("toolchain.gc-skipped", { reason: "nix is not installed" });
    } else {
      this.logger.warn("toolchain.gc-failed", { detail: tail(stderr) });
    }
  }

  private log(spec: TaskSpec, resolved: ResolvedEnv): ResolvedEnv {
    this.logger.info("toolchain.resolved", {
      task: spec.id,
      source: resolved.source,
      shell: resolved.shell,
    });
    return resolved;
  }

  /** What to build, or undefined for "inherit". Pure decision, no nix invoked yet. */
  private async plan(spec: TaskSpec, worktree: string): Promise<NixPlan | undefined> {
    const declared: ToolchainSpec | undefined = spec.toolchain;
    if (declared?.mode === "inherit") return undefined;

    if (declared?.mode === "nix" && declared.packages !== undefined) {
      return {
        kind: "packages",
        packages: declared.packages,
        source: `nix: ${declared.packages.join(", ")}`,
      };
    }

    for (const [file, kind] of [
      ["flake.nix", "flake"],
      ["shell.nix", "shell"],
    ] as const) {
      const contents = await readFile(join(worktree, file), "utf8").catch(() => undefined);
      if (contents !== undefined) return { kind, contents, source: `${file} devShell` };
    }

    // An explicit `mode: nix` with no packages and no repo expression is a mistake worth
    // reporting: the human asked for an environment and named nothing to put in it, and
    // silently inheriting would hide that until the acceptance gate went red.
    if (declared?.mode === "nix") {
      throw new ToolchainError(
        "declaration",
        "`toolchain.mode: nix` was declared but nothing says what to build — list " +
          "`packages`, or add a flake.nix/shell.nix to the repository.",
      );
    }

    return undefined;
  }

  /**
   * Ask nix for the environment, or read the answer it gave last time.
   *
   * Cached against a digest of everything that decides the answer, and persisted next to
   * the task rather than held in memory: Keel rolls the pod on every push to `main`, so an
   * in-memory cache would make sessions 2..N of a long task each pay a cold resolve.
   */
  private async materialise(
    spec: TaskSpec,
    worktree: string,
    plan: NixPlan,
  ): Promise<NodeJS.ProcessEnv> {
    const scratch = join(this.tasksDir, spec.id, ".caterpillar");
    await mkdir(scratch, { recursive: true });

    const lock =
      plan.kind === "flake"
        ? await readFile(join(worktree, "flake.lock"), "utf8").catch(() => "")
        : "";
    const digest = cacheDigest(this.config.nixpkgs, plan, lock);

    const cachePath = join(scratch, "env.json");
    const cached = await readCache(cachePath, digest);
    if (cached !== undefined && (await storePathsExist(cached))) {
      this.logger.debug("toolchain.cache-hit", { task: spec.id, source: plan.source });
      return this.merge(cached);
    }
    if (cached !== undefined) {
      // The entry is for the right input and names store paths that are gone: a garbage
      // collection took them, or the store is in the image rather than on the PVC and a
      // deploy replaced it. Re-resolving is cheap and substitutes them back. Trusting the
      // entry would not fail — it would hand the agent a PATH of directories that do not
      // exist, which looks exactly like the missing toolchain this all exists to fix.
      this.logger.info("toolchain.cache-stale", { task: spec.id, source: plan.source });
    }

    const flakeRef = await this.flakeRef(scratch, worktree, plan);
    const variables = await this.printDevEnv(flakeRef, join(scratch, "dev-profile"), plan);

    await writeFile(cachePath, JSON.stringify({ digest, variables }), "utf8");
    return this.merge(variables);
  }

  /** What to hand `nix print-dev-env`. Generates a flake for an explicit package list. */
  private async flakeRef(
    scratch: string,
    worktree: string,
    plan: NixPlan,
  ): Promise<readonly string[]> {
    if (plan.kind === "flake") return [worktree];
    // `-f` is the pre-flakes entrypoint; `--impure` because a shell.nix is free to read
    // <nixpkgs> and the environment, which is the whole reason it is not a flake.
    if (plan.kind === "shell") return ["--impure", "-f", join(worktree, "shell.nix")];

    await writeFile(
      join(scratch, "flake.nix"),
      generatedFlake(this.config.nixpkgs, plan.packages),
      "utf8",
    );
    return [scratch];
  }

  /**
   * `nix print-dev-env --json`, parsed rather than sourced.
   *
   * Sourcing would mean running repo-authored shell in the supervisor's own process.
   * Parsing keeps the blast radius at "a bad devShell produces a bad PATH for one task".
   *
   * `--profile` is not an optimisation: it registers a GC ROOT, without which a
   * collection between two sessions of the same task can delete the environment the
   * second session is about to use.
   */
  private async printDevEnv(
    flakeRef: readonly string[],
    profile: string,
    plan: NixPlan,
  ): Promise<Record<string, string>> {
    const args = ["print-dev-env", "--json", "--profile", profile, ...flakeRef];
    const { code, stdout, stderr } = await run("nix", args, {
      env: this.baseEnv,
      timeoutMs: this.config.timeoutSeconds * 1000,
    });

    if (code !== 0) {
      throw new ToolchainError(
        plan.source,
        `\`nix ${args.join(" ")}\` exited ${code}:\n${tail(stderr || stdout)}`,
      );
    }

    let parsed: PrintDevEnv;
    try {
      parsed = JSON.parse(stdout) as PrintDevEnv;
    } catch (error) {
      throw new ToolchainError(
        plan.source,
        `nix print-dev-env produced output this does not understand: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const exported: Record<string, string> = {};
    for (const [name, variable] of Object.entries(parsed.variables ?? {})) {
      // `var` and `array` entries are the derivation's internal bookkeeping —
      // `buildInputs`, `stdenv`, `out`. Only `exported` is what a shell inside the
      // devShell would actually see.
      if (variable.type === "exported" && typeof variable.value === "string") {
        exported[name] = variable.value;
      }
    }
    return exported;
  }

  /**
   * The devShell's variables on top of the supervisor's, then the supervisor's own
   * control variables back on top of THAT.
   *
   * The last step is the security-relevant one. A devShell is repo-authored: left
   * unguarded it could point `CRED_HELPER` somewhere else, redirect `CONFIG_PATH`, or
   * move `HOME` out from under the credential socket. Re-asserting is deliberately not a
   * denylist — a denylist is a list of the things somebody already thought of, and this
   * has to hold for variables added to the supervisor later.
   */
  private merge(exported: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.baseEnv, ...exported };
    for (const name of RESERVED) {
      if (name in this.baseEnv) env[name] = this.baseEnv[name];
      else delete env[name];
    }
    return env;
  }

  private taskShell(): Promise<string> {
    this.shell ??= findBash(this.baseEnv).then((found) => {
      if (found === undefined) {
        // Falling back to `sh` is what pi does, and it is the wrong answer here: the
        // acceptance gate has always been bash, so a repo whose acceptance command uses a
        // heredoc or a process substitution would pass for the agent and fail at the gate
        // for reasons neither could see.
        throw new ToolchainError(
          "shell",
          "no bash on PATH. The agent's shell and the acceptance gate's must be the " +
            "same interpreter; install bash on this runner.",
        );
      }
      this.logger.debug("toolchain.shell", { shell: found });
      return found;
    });
    return this.shell;
  }
}

/**
 * NOT a login shell.
 *
 * `bash -lc` sources `/etc/profile`, which on alpine ASSIGNS `PATH` outright rather than
 * appending to it. Any environment handed in would be silently overwritten between
 * `execFile` and the command — the resolver would work, the logs would say so, and the
 * command would still not find its toolchain.
 */
export const TASK_SHELL_ARGS: readonly string[] = ["-c"];

/**
 * What `materialise` was asked to build, and what to call it in a log line.
 *
 * `flake` and `shell` carry identical fields and are still separate members: a single
 * `kind: "flake" | "shell"` cannot be narrowed away, and the point of the discriminant is
 * that the compiler proves `flakeRef` handled every case.
 */
export type NixPlan =
  | { readonly kind: "flake"; readonly contents: string; readonly source: string }
  | { readonly kind: "shell"; readonly contents: string; readonly source: string }
  | { readonly kind: "packages"; readonly packages: readonly string[]; readonly source: string };

/** The subset of `nix print-dev-env --json` this reads. */
interface PrintDevEnv {
  readonly variables?: Record<string, { readonly type?: string; readonly value?: unknown }>;
}

/**
 * Defaults for `toolchain` in the runner config.
 *
 * Here rather than inline in `config/load.ts` so the numbers sit next to the code that
 * has to live with them — the timeout next to the nix invocation it bounds, the nixpkgs
 * pin next to the flake it is substituted into.
 */
export const DEFAULT_TOOLCHAIN_CONFIG: ToolchainConfig = {
  // A release branch, not `nixos-unstable`: an unattended agent that picks up a silent
  // toolchain bump produces a red acceptance run with no diff to explain it.
  nixpkgs: "github:NixOS/nixpkgs/nixos-25.05",
  // Matches the acceptance-command timeout in `supervisor/verifier.ts`. Generous because
  // a devShell that overrides anything can miss the binary cache and build from source.
  timeoutSeconds: 900,
  gcIntervalHours: 24,
  gcKeepDays: 14,
};

/**
 * The cache key: everything that decides what nix would answer.
 *
 * Exported because it is the contract between a written entry and a read one, and a test
 * that recomputed the key by hand would keep passing after the real key changed.
 *
 * `flake.lock` is in it, not just `flake.nix`. A `nix flake update` changes not one
 * character of the expression and every version it resolves to — a cache keyed on the
 * expression alone would serve the previous toolchain forever.
 */
export const cacheDigest = (
  nixpkgs: string,
  plan: NixPlan,
  lock: string,
): string =>
  createHash("sha256")
    .update(CACHE_VERSION)
    .update(nixpkgs)
    .update(plan.kind)
    .update(plan.kind === "packages" ? plan.packages.join(" ") : plan.contents)
    .update(lock)
    .digest("hex");

/**
 * Bumped when the shape of a cache entry changes.
 *
 * The cache lives on the PVC and outlives any deploy, so a format change without this
 * would have a new supervisor reading an old entry as if it were current — which fails as
 * a wrong environment rather than as a parse error.
 */
const CACHE_VERSION = "v1";

/**
 * Ceiling on the boot-time `nix --version` probe.
 *
 * Short on purpose: this runs before the supervisor serves `/healthz`, so a slow answer
 * delays the readiness probe. Treating a timeout as "no nix" is the safe direction — the
 * runner advertises less than it can do rather than more.
 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Variables the supervisor owns, restored after a devShell has had its say.
 *
 * Everything here either points at a credential path or decides where this process reads
 * its own identity from. A repo-authored devShell moving one of them is the difference
 * between a task with a lua interpreter and a task holding the wrong end of the
 * credential helper.
 */
const RESERVED: readonly string[] = [
  "HOME",
  "RUNNER_ID",
  "CONFIG_PATH",
  "CRED_SOCKET",
  "CRED_HELPER",
  "GITHUB_API_BASE",
  "LLM_PROXY_TOKEN",
  "ANTHROPIC_API_KEY",
];

/**
 * The one message `run` produces itself rather than relaying.
 *
 * A named constant because two callers have to agree on it: `printDevEnv` reports it as a
 * park reason, and `maybeCollectGarbage` recognises it to stay quiet on a runner that
 * deliberately has no nix.
 */
const NOT_INSTALLED = (command: string): string =>
  `${command} is not installed on this runner`;

/** Enough stderr to diagnose a nix failure, not enough to bury a Discord message. */
const tail = (output: string): string => output.trim().slice(-2000);

/**
 * A flake for an explicit package list.
 *
 * Deliberately minimal and deliberately PINNED: `nixpkgs` unqualified would resolve
 * through the registry to whatever the runner last saw, so two runners could give the
 * same task two different lua versions and only one of them would pass the gate.
 */
const generatedFlake = (nixpkgs: string, packages: readonly string[]): string =>
  `{
  description = "caterpillar task toolchain — generated, do not edit";
  inputs.nixpkgs.url = "${nixpkgs}";
  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.\${system});
    in {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [ ${packages.join(" ")} ];
        };
      });
    };
}
`;

/** `execFile` with a timeout, resolving rather than throwing so the caller can explain. */
const run = (
  command: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        // ENOENT means nix is not installed. Saying so beats "exited 1", because the fix
        // is a runner change and not a repo change.
        const detail =
          error !== null && "code" in error && error.code === "ENOENT"
            ? NOT_INSTALLED(command)
            : stderr;
        resolve({ code, stdout, stderr: detail });
      },
    );
  });

/**
 * Are the store paths this entry names still on disk?
 *
 * A cache entry and the store it points into have different lifetimes, and nothing keeps
 * them in step: `nix-collect-garbage` can take a path, and an ephemeral `/nix` inside the
 * image is replaced on every deploy while `env.json` sits on the durable PVC. Only the
 * PATH entries are checked — they are what a missing tool actually shows up as, and
 * stat-ing every variable in a devShell would cost more than the resolve it is avoiding.
 */
const storePathsExist = async (variables: Record<string, string>): Promise<boolean> => {
  const entries = (variables["PATH"] ?? "")
    .split(":")
    .filter((entry) => entry.startsWith("/nix/store/"));
  if (entries.length === 0) return true;

  for (const entry of entries) {
    try {
      await access(entry);
    } catch {
      return false;
    }
  }
  return true;
};

/** A cache entry, or undefined if it is missing, unreadable, or for a different input. */
const readCache = async (
  path: string,
  digest: string,
): Promise<Record<string, string> | undefined> => {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      readonly digest?: unknown;
      readonly variables?: unknown;
    };
    if (parsed.digest !== digest) return undefined;
    return parsed.variables as Record<string, string>;
  } catch {
    // A half-written entry is a cache miss, never a crash — the environment is
    // reproducible, so the only cost of re-resolving is time.
    return undefined;
  }
};

/**
 * Bash, as an absolute path, found through the environment the task will actually run in.
 *
 * Asked rather than assumed: `/bin/bash` does not exist on NixOS — bash lives under
 * `/run/current-system/sw/bin` — and NixOS is one of the two hosts this runs on. An
 * absolute path is what comes back because pi stats `shellPath` and refuses a bare name
 * (see `ResolvedEnv.shell`).
 *
 * Asked through `/bin/sh`, which is the one FHS path every target keeps, with `command -v`
 * rather than `which` — `which` is a separate package that alpine does not install.
 */
const findBash = (env: NodeJS.ProcessEnv): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile("/bin/sh", ["-c", "command -v bash"], { env }, (error, stdout) => {
      const path = stdout.split("\n")[0]?.trim();
      resolve(error !== null || path === undefined || path.length === 0 ? undefined : path);
    });
  });
