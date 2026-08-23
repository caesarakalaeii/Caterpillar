/**
 * Does a declared toolchain name packages that exist? See DESIGN.md §8.1 and §14.
 *
 * §9.1.1 refuses a task naming a repo the workspace's credential cannot reach, names the
 * near miss, and does it BEFORE the task exists — because the alternative was a task that
 * got claimed and died in `git clone` a session later, on a 422 that named the App
 * installation rather than the repo.
 *
 * A `toolchain.packages` list with a typo'd nixpkgs attribute is the same failure with a
 * different exit code. `spec.ts` already checks the SHAPE of the block — that `mode` is one
 * of two words and that `packages` is a non-empty list of strings — and nothing checked
 * whether the names in it resolve. So `lua51` (the attribute is `lua5_1`) passed intake,
 * became a task, was claimed, and failed in `nix print-dev-env` inside the session, where
 * §8.1 correctly parks rather than falling through to an environment missing the exact tool
 * the task is about. A session spent to learn about a missing underscore.
 *
 * This asks at the door instead. Two properties make it safe to put on the intake path:
 *
 *   IT EVALUATES, IT DOES NOT BUILD. `builtins.getFlake … ? attr` reads the nixpkgs
 *   expression and answers from it; it substitutes and compiles nothing. Warm, that is
 *   about half a second for the pin the fleet ships.
 *
 *   IT FAILS OPEN. Every answer that is not "nix ran and said no" lets the item through —
 *   see `ToolchainDoctor.fault`. This is the same rule §9.1.1 applies to a 500 from the
 *   forge, for the same reason: a check that cannot run has learnt nothing, and turning
 *   that into a refusal would comment on every open item in the backlog and suppress it
 *   durably (§14.2).
 *
 * The split in this file is deliberate. Everything above `NixEval` is pure — the near-miss
 * ranking, the expression, the sentence — and is tested without nix. The IO is one small
 * class at the bottom, which is the only part that needs a runner with nix to exercise.
 */
import { execFile } from "node:child_process";
import type { ToolchainSpec } from "../domain/task.ts";
import type { ToolchainConfig } from "../config/types.ts";
import type { Logger } from "../obs/log.ts";

/** A declared package that does not resolve, and the closest thing that does. */
export interface UnresolvedPackage {
  readonly name: string;
  /** `lua5_1` for `lua51`, or absent when nothing is close enough to suggest. */
  readonly nearest: string | undefined;
}

/**
 * A nixpkgs attribute name, as nix itself spells one.
 *
 * Letters, digits, `_`, `-` and `+`. This is the whitelist that makes the generated
 * expression safe: the name is interpolated into nix source that this process then
 * evaluates, so a name carrying a quote or a space could close the string and append an
 * expression of its own. An `agent` block is written by a human with write access (intake
 * checks `authorTrusted` before it gets here) so this is not the only thing standing in
 * the way — but a check that only holds while another check holds is a check that breaks
 * when that one moves.
 *
 * NO DOT, deliberately. `pkgs ? ${a.b}` asks about a NESTED attribute, so a dotted name
 * does not mean what the answer is read as meaning. That makes such a name UNASKABLE by
 * this expression — which is not the same as invalid: `python3Packages.requests` is a
 * real package and `generatedFlake` in `toolchain.ts` builds it today from the
 * `with pkgs; [ … ]` list it interpolates into. `checkablePackages` sorts the two apart,
 * and a dotted name fails open rather than being refused.
 *
 * Refused rather than escaped. There is no legitimate nixpkgs attribute name — as opposed
 * to attribute PATH — that this rejects, so escaping would add a quoting scheme to be
 * subtly wrong about in exchange for nothing.
 */
const ATTRIBUTE = /^[A-Za-z0-9_+-]+$/;

/**
 * How many leading characters a candidate must share with a misspelt name.
 *
 * Two, which is a trade rather than a tuning: it keeps `nix eval`'s output to a few
 * hundred names instead of ~100k, and it gives up on a typo in the FIRST two characters
 * (`ghc` for `hgc`). Those are rarer than a wrong separator, which is what this exists to
 * catch, and the cost of missing one is a refusal without a suggestion rather than a wrong
 * refusal.
 */
const PREFIX_LENGTH = 2;

/**
 * The declared names this check can actually evaluate, and the ones it cannot.
 *
 * Pure, and separate from the expression, because "cannot ask" and "must not interpolate"
 * are two different judgements about a name and collapsing them produced a false refusal:
 * a dotted path was reported as "not a nixpkgs attribute name" on the reasoning that nix
 * would reject it too, which it does not.
 *
 * Everything that is not a bare attribute is skipped, without sorting the merely
 * unaskable (`python3Packages.requests`) from the outright hostile (`jq"; x`). The
 * outcome for both is the same — not evaluated, not refused — so a second pattern to
 * tell them apart would be a distinction this function does not act on.
 */
const checkablePackages = (
  packages: readonly string[],
): { readonly checkable: readonly string[]; readonly skipped: readonly string[] } => {
  const checkable: string[] = [];
  const skipped: string[] = [];
  for (const name of packages) {
    if (ATTRIBUTE.test(name)) checkable.push(name);
    else skipped.push(name);
  }
  return { checkable, skipped };
};

/**
 * Everything a human might type differently for the same attribute, collapsed.
 *
 * `lua5_1` / `lua51` / `Lua5.1` are one name typed three ways: `_`, `-` and `.` are
 * separators nixpkgs uses inconsistently between attributes (`nodejs_22`, `lua5_1`,
 * `gcc-unwrapped`) and nobody remembers which. Squashing them is what makes `lua51` find
 * `lua5_1` at all — an edit-distance pass alone ranks `lua5` and `lua51Packages` just as
 * close.
 *
 * The same idea as `squash` in `forge/reach.ts`, and deliberately a separate copy: that
 * one drops `.` and digits' separators for REPO slugs, and the two are free to diverge
 * because they are answering about different namespaces.
 */
const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Levenshtein distance, bounded — the same shape as `forge/reach.ts`.
 *
 * Bounded because the only question is "within N edits", and nixpkgs has ~100k attribute
 * names: an unbounded distance against every candidate is a matrix per candidate to answer
 * a question that a row can refuse.
 */
const withinDistance = (a: string, b: string, limit: number): number | undefined => {
  if (Math.abs(a.length - b.length) > limit) return undefined;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i, ...Array.from({ length: b.length }, () => 0)];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    if (Math.min(...current) > limit) return undefined;
    previous = current;
  }

  const total = previous[b.length] ?? Number.MAX_SAFE_INTEGER;
  return total <= limit ? total : undefined;
};

/**
 * How far off an attribute may be and still be offered as "did you mean".
 *
 * Tighter than `forge/reach.ts`'s budget for repo names, because package attributes are
 * short and a short name's neighbours are usually different packages rather than typos:
 * `go` is one edit from `gd`, `gh` and `zo`, all real and all unrelated. Two edits at
 * eight characters, one below that.
 */
const editBudget = (name: string): number => (name.length >= 8 ? 2 : 1);

/**
 * The nixpkgs attribute closest to what was asked for, when one is close enough.
 *
 * Ranked, and the order is the whole point:
 *
 *   1. the same name once squashed — `lua5_1` for `lua51`, `nodejs_22` for `nodejs22`.
 *      This is the case that motivated the check and it beats everything else.
 *   2. a name within `editBudget` edits — `luarocks` for `luaroks`.
 *
 * Note what is NOT here: a prefix match. `rankRepos` ranks one first, which is right for a
 * slug being typed into an autocomplete and wrong here — `lua51Packages` starts with the
 * whole of `lua51` and is a set of lua modules, not the interpreter the author meant.
 *
 * An exact match yields undefined: an exact match is not unresolvable, and suggesting the
 * name the caller already typed would read as nonsense.
 */
export const nearestPackage = (
  wanted: string,
  candidates: readonly string[],
): string | undefined => {
  const squashed = squash(wanted);
  const budget = editBudget(wanted);

  let best: { readonly name: string; readonly score: number } | undefined;
  for (const candidate of candidates) {
    if (candidate === wanted) return undefined;

    const edits = withinDistance(wanted.toLowerCase(), candidate.toLowerCase(), budget);
    const score =
      squash(candidate) === squashed ? 0 : edits === undefined ? undefined : 1 + edits;
    if (score === undefined) continue;
    // Strictly better only, so a tie keeps nixpkgs' own (alphabetical) ordering rather
    // than whichever was scanned last.
    if (best === undefined || score < best.score) best = { name: candidate, score };
  }

  return best?.name;
};

/**
 * The nix expression that answers, for one package list, which names do not resolve and
 * what else is nearby.
 *
 * One evaluation for both halves of the answer, because the second half is only wanted
 * when the first half is bad and a second `nix` invocation would double the cost of the
 * common case where everything resolves. `attrNames` is filtered by PREFIX inside nix:
 * the full list is ~100k names and several megabytes of JSON, while the candidates worth
 * ranking all share a first character or two with what was typed.
 *
 * `legacyPackages.${system}` rather than `packages`: nixpkgs exposes its ~100k attributes
 * there, and that is what `generatedFlake` in `toolchain.ts` builds a devShell from — so
 * this checks the same attribute set the resolver will later ask for, which is the only
 * way the check can be trusted.
 *
 * @throws if any name is not a bare nixpkgs attribute — see `ATTRIBUTE`.
 */
export const packageCheckExpression = (
  nixpkgs: string,
  packages: readonly string[],
): string => {
  for (const name of packages) {
    if (!ATTRIBUTE.test(name)) {
      throw new Error(`'${name}' is not a nixpkgs attribute name`);
    }
  }

  const wanted = packages.map((name) => `"${name}"`).join(" ");
  // The prefix each candidate must share to be worth ranking. One character would drag in
  // thousands of names, three would miss `go` — so it is the shorter of the name and 2.
  const prefixes = packages
    .map((name) => `"${name.slice(0, PREFIX_LENGTH).toLowerCase()}"`)
    .join(" ");

  return `let
  pkgs = (builtins.getFlake "${nixpkgs}").legacyPackages.\${builtins.currentSystem};
  wanted = [ ${wanted} ];
  prefixes = [ ${prefixes} ];
  missing = builtins.filter (name: !(pkgs ? \${name})) wanted;
  lower = builtins.replaceStrings
    [ "A" "B" "C" "D" "E" "F" "G" "H" "I" "J" "K" "L" "M"
      "N" "O" "P" "Q" "R" "S" "T" "U" "V" "W" "X" "Y" "Z" ]
    [ "a" "b" "c" "d" "e" "f" "g" "h" "i" "j" "k" "l" "m"
      "n" "o" "p" "q" "r" "s" "t" "u" "v" "w" "x" "y" "z" ];
  near = name: builtins.any
    (prefix: builtins.substring 0 (builtins.stringLength prefix) (lower name) == prefix)
    prefixes;
  candidates = if missing == [] then [] else builtins.filter near (builtins.attrNames pkgs);
in { inherit missing candidates; }`;
};

/**
 * What one evaluation came back with.
 *
 * `unavailable` is not an error case to be handled sloppily — it is half the contract.
 * There is no nix on this runner, or it timed out, or it could not fetch the pin; the
 * doctor turns every one of them into "no fault" and the item is created. Keeping it in
 * the return type rather than throwing is what makes that decision visible at the call
 * site instead of buried in a catch.
 */
export type NixAnswer =
  | {
      readonly kind: "answered";
      /** Declared names that do not resolve, in the order they were declared. */
      readonly missing: readonly string[];
      /** Attribute names near the missing ones, for the near-miss ranking. */
      readonly candidates: readonly string[];
    }
  | { readonly kind: "unavailable"; readonly detail: string };

/**
 * The one piece of IO, behind an interface so the decision logic is testable without nix.
 *
 * A test for "an unresolvable package is refused" that had to evaluate real nixpkgs would
 * be a test of the network. The fleet's own runners are the integration test: they run
 * this on every intake pass.
 */
export interface NixEval {
  evaluate(expression: string, timeoutMs: number): Promise<NixAnswer>;
}

/**
 * The refusal, as the author of the tracker item will read it.
 *
 * Exported and pure so the wording is testable and so the two callers that might want it
 * (intake's comment, and a future `/brainstorm` door) cannot drift apart.
 *
 * The PIN is in the sentence. `lua5_1` resolves on `nixos-25.05` and `luajit_2_0` did not
 * survive to it; without the pin the reply is "that package does not exist", which an
 * author who can see it on search.nixos.org will read as a bug in this check.
 */
export const toolchainFault = (
  unresolved: readonly UnresolvedPackage[],
  nixpkgs: string,
): string => {
  const lines = unresolved.map((entry) =>
    entry.nearest === undefined
      ? `- \`${entry.name}\` — no such attribute.`
      : `- \`${entry.name}\` — did you mean \`${entry.nearest}\`?`,
  );

  return (
    `\`toolchain.packages\` names ${unresolved.length === 1 ? "an attribute" : "attributes"} ` +
    `that ${unresolved.length === 1 ? "does" : "do"} not exist in the pinned nixpkgs ` +
    `(\`${nixpkgs}\`):\n\n${lines.join("\n")}\n\n` +
    `Nothing was built — this is an evaluation of the pin above, so a name that exists on ` +
    `a different nixpkgs branch can still fail here. Fix the list and the next intake ` +
    `pass will pick this up.`
  );
};

/**
 * Ceiling on the one evaluation, and it is really a bound on INTAKE.
 *
 * Deliberately NOT `ToolchainConfig.timeoutSeconds`, which is 900 because it bounds a
 * devShell build that may compile from source. Intake is a different budget entirely: it
 * runs on the supervisor's own thread of control, once per interval, over every labelled
 * item in the backlog — so an item whose evaluation hangs stalls every item behind it. At
 * 900 seconds one cold nixpkgs fetch would hold up a whole pass for fifteen minutes.
 *
 * 30 seconds. A warm evaluation of `legacyPackages.<system>` is about half a second; a cold
 * one — nothing in the store — was measured at ~45s and therefore exceeds this, which is
 * the case that fails open and gets checked on a later pass once the store is warm. That
 * is the right trade: the worst case is an unchecked item, which is exactly the behaviour
 * that existed before this check.
 */
export const DEFAULT_DOCTOR_TIMEOUT_SECONDS = 30;

export interface ToolchainDoctorOptions {
  readonly config: ToolchainConfig;
  readonly nix: NixEval;
  /** Optional: without one the doctor is silent, which is what the pure tests want. */
  readonly logger?: Logger;
  /** Ceiling on the evaluation. Defaults to `DEFAULT_DOCTOR_TIMEOUT_SECONDS`. */
  readonly timeoutSeconds?: number;
}

/**
 * Validates a declared toolchain without provisioning anything.
 *
 * Named for `orca vm recipe doctor`, which checks a per-workspace environment recipe and
 * reports what it found rather than building it.
 */
export class ToolchainDoctor {
  private readonly config: ToolchainConfig;
  private readonly nix: NixEval;
  private readonly logger: Logger | undefined;
  private readonly timeoutMs: number;

  constructor(options: ToolchainDoctorOptions) {
    this.config = options.config;
    this.nix = options.nix;
    this.logger = options.logger;
    this.timeoutMs = (options.timeoutSeconds ?? DEFAULT_DOCTOR_TIMEOUT_SECONDS) * 1000;
  }

  /**
   * Why this toolchain cannot be produced, or undefined for "no objection".
   *
   * Undefined covers three different situations that intake must treat identically:
   * nothing was declared, everything resolves, and THE CHECK COULD NOT RUN. Only the
   * middle one is a positive result; the other two are the absence of evidence, and a
   * refusal needs evidence.
   */
  async fault(declared: ToolchainSpec | undefined): Promise<string | undefined> {
    // No packages, nothing to resolve. `mode: inherit` never has any, and `mode: nix`
    // without them means "use the repo's own nix expression" — which is not checkable
    // here, because the repo is not checked out at intake.
    const packages = declared?.packages;
    if (packages === undefined || packages.length === 0) return undefined;

    // A name this expression cannot ask about is not evidence of anything. A dotted path
    // is the case that matters: `generatedFlake` builds it, so refusing it here would
    // reject a toolchain that works. The rest of the list is still checked.
    const { checkable, skipped } = checkablePackages(packages);
    if (skipped.length > 0) {
      this.logger?.debug("toolchain.doctor-unaskable", { packages: skipped.join(",") });
    }
    if (checkable.length === 0) return undefined;

    let expression: string;
    try {
      // Unreachable via `checkable`, which is filtered on the same whitelist the
      // expression enforces. Kept because the expression owns that guard, and a caller
      // reaching it another way must not get a half-built expression.
      expression = packageCheckExpression(this.config.nixpkgs, checkable);
    } catch (error) {
      this.logger?.debug("toolchain.doctor-skipped", {
        detail: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }

    const answer = await this.nix
      .evaluate(expression, this.timeoutMs)
      .catch((error: unknown) => {
        // A throw here is an unavailable nix, not a bad attribute. Treated as such rather
        // than propagated, because propagating would abort the whole intake pass over one
        // item's environment.
        const detail = error instanceof Error ? error.message : String(error);
        return { kind: "unavailable", detail } as const;
      });

    if (answer.kind === "unavailable") {
      // Deliberately not `warn`: on a runner with no nix this is the normal case and every
      // intake pass would log it for every declared toolchain.
      this.logger?.debug("toolchain.doctor-skipped", {
        detail: answer.detail,
        packages: packages.join(","),
      });
      return undefined;
    }

    if (answer.missing.length === 0) return undefined;

    const unresolved: UnresolvedPackage[] = answer.missing.map((name) => ({
      name,
      nearest: nearestPackage(name, answer.candidates),
    }));

    this.logger?.warn("toolchain.doctor-fault", {
      packages: unresolved.map((entry) => entry.name).join(","),
      nixpkgs: this.config.nixpkgs,
    });
    return toolchainFault(unresolved, this.config.nixpkgs);
  }
}

/**
 * `nix eval` in a subprocess, bounded by the caller's timeout.
 *
 * `--impure` is required by `builtins.currentSystem`, which is what keeps the expression
 * from hardcoding an architecture the runner is not. It does not make the evaluation less
 * pinned: the nixpkgs reference in the expression is the configured pin either way.
 *
 * Every failure mode is `unavailable`, INCLUDING a non-zero exit. That looks careless and
 * is the opposite: a missing attribute is reported in `missing` by an evaluation that
 * SUCCEEDS, so a non-zero exit means nix could not answer the question — an unfetchable
 * pin, a store with no space, an experimental-features setting that is off. None of those
 * are evidence about a package name.
 */
export class NixCommandEval implements NixEval {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  evaluate(expression: string, timeoutMs: number): Promise<NixAnswer> {
    return new Promise((resolve) => {
      execFile(
        "nix",
        ["eval", "--json", "--impure", "--expr", expression],
        { env: this.env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error !== null) {
            resolve({ kind: "unavailable", detail: (stderr || error.message).trim().slice(-500) });
            return;
          }
          try {
            const parsed = JSON.parse(stdout) as {
              readonly missing?: readonly string[];
              readonly candidates?: readonly string[];
            };
            resolve({
              kind: "answered",
              missing: parsed.missing ?? [],
              candidates: parsed.candidates ?? [],
            });
          } catch (parseError) {
            // Output this cannot read is not a verdict on a package name.
            resolve({
              kind: "unavailable",
              detail: `nix eval produced unreadable output: ${
                parseError instanceof Error ? parseError.message : String(parseError)
              }`,
            });
          }
        },
      );
    });
  }
}
