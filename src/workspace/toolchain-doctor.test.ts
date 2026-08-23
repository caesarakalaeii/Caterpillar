import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TOOLCHAIN_CONFIG } from "./toolchain.ts";
import {
  nearestPackage,
  packageCheckExpression,
  ToolchainDoctor,
  toolchainFault,
  type NixEval,
} from "./toolchain-doctor.ts";

/* ------------------------------------------------------------- near misses */

test("nearestPackage offers lua5_1 for lua51", () => {
  const candidates = ["lua", "lua5", "lua51Packages", "lua5_1", "lua5_2", "luajit", "luarocks"];
  assert.equal(nearestPackage("lua51", candidates), "lua5_1");
});

test("nearestPackage prefers a squashed match over a longer prefix match", () => {
  // `lua51Packages` starts with the whole query and is still the wrong answer: a human
  // typing `lua51` wants an interpreter, and `-`/`_`/case are what they retype wrong.
  const candidates = ["lua51Packages", "lua5_1"];
  assert.equal(nearestPackage("lua51", candidates), "lua5_1");
});

test("nearestPackage offers nothing when nothing is close", () => {
  assert.equal(nearestPackage("zzzznotathing", ["jq", "go", "nodejs_22"]), undefined);
});

test("nearestPackage never suggests the name that was asked for", () => {
  assert.equal(nearestPackage("jq", ["jq", "jql"]), undefined);
});

/* ------------------------------------------------------- the nix expression */

test("packageCheckExpression pins the configured nixpkgs rather than the registry", () => {
  const expression = packageCheckExpression("github:NixOS/nixpkgs/nixos-25.05", ["jq"]);
  assert.match(expression, /github:NixOS\/nixpkgs\/nixos-25\.05/);
});

test("packageCheckExpression refuses a package name that is not a bare attribute", () => {
  // The name is interpolated into a nix expression, so anything that could close a string
  // or open an application is refused before it gets there rather than escaped.
  for (const hostile of ['jq" ++ (import <nix/fetchurl.nix>', "jq; x", "a b", "pkgs.jq"]) {
    assert.throws(() => packageCheckExpression("github:NixOS/nixpkgs/nixos-25.05", [hostile]));
  }
});

/* --------------------------------------------------------------- the doctor */

const config = { ...DEFAULT_TOOLCHAIN_CONFIG, timeoutSeconds: 5 };

/** A nix that answers from a fixed set of attribute names, without running nix. */
const fakeNix = (attributes: readonly string[]): NixEval => ({
  async evaluate(expression) {
    const wanted = [...expression.matchAll(/"([A-Za-z0-9._+-]+)"/g)].map((m) => m[1] ?? "");
    const missing = wanted.filter((name) => !attributes.includes(name));
    return {
      kind: "answered",
      missing,
      candidates: attributes,
    };
  },
});

test("a toolchain whose packages all resolve is not a fault", async () => {
  const doctor = new ToolchainDoctor({ config, nix: fakeNix(["jq", "go"]) });
  assert.equal(await doctor.fault({ mode: "nix", packages: ["jq", "go"] }), undefined);
});

test("a toolchain naming an unresolvable package is a fault that names it", async () => {
  const doctor = new ToolchainDoctor({ config, nix: fakeNix(["lua5_1", "luarocks"]) });
  const fault = await doctor.fault({ mode: "nix", packages: ["lua51"] });
  assert.ok(fault !== undefined, "expected a fault");
  assert.match(fault, /lua51/);
});

test("a fault names the near miss where one exists", async () => {
  const doctor = new ToolchainDoctor({ config, nix: fakeNix(["lua5_1", "luarocks"]) });
  const fault = await doctor.fault({ mode: "nix", packages: ["lua51"] });
  assert.match(fault ?? "", /lua5_1/);
});

test("mode inherit is a no-op, never a refusal", async () => {
  // Nothing to check, and nothing may be run to check it: `inherit` declares no packages.
  const nix: NixEval = {
    evaluate: () => assert.fail("inherit must not evaluate anything"),
  };
  const doctor = new ToolchainDoctor({ config, nix });
  assert.equal(await doctor.fault({ mode: "inherit" }), undefined);
});

test("mode nix without packages is a no-op — the repo's own expression decides", async () => {
  const nix: NixEval = {
    evaluate: () => assert.fail("a declaration with no packages must not evaluate anything"),
  };
  const doctor = new ToolchainDoctor({ config, nix });
  assert.equal(await doctor.fault({ mode: "nix" }), undefined);
});

test("an undeclared toolchain is a no-op", async () => {
  const nix: NixEval = { evaluate: () => assert.fail("nothing was declared") };
  const doctor = new ToolchainDoctor({ config, nix });
  assert.equal(await doctor.fault(undefined), undefined);
});

/* ------------------------------------------------- point 4: it fails open */

test("a runner without nix refuses nothing", async () => {
  const nix: NixEval = { evaluate: async () => ({ kind: "unavailable", detail: "no nix" }) };
  const doctor = new ToolchainDoctor({ config, nix });
  assert.equal(await doctor.fault({ mode: "nix", packages: ["lua51"] }), undefined);
});

test("an evaluation that times out refuses nothing", async () => {
  const nix: NixEval = { evaluate: async () => ({ kind: "unavailable", detail: "timed out" }) };
  const doctor = new ToolchainDoctor({ config, nix });
  assert.equal(await doctor.fault({ mode: "nix", packages: ["lua51"] }), undefined);
});

test("a nix that throws refuses nothing", async () => {
  const nix: NixEval = {
    evaluate: () => Promise.reject(new Error("ENOENT")),
  };
  const doctor = new ToolchainDoctor({ config, nix });
  assert.equal(await doctor.fault({ mode: "nix", packages: ["lua51"] }), undefined);
});

/* ----------------------------------------------------- the refusal sentence */

test("toolchainFault names every unresolvable package and how to fix it", () => {
  const fault = toolchainFault([
    { name: "lua51", nearest: "lua5_1" },
    { name: "nosuchpkg", nearest: undefined },
  ], "github:NixOS/nixpkgs/nixos-25.05");

  assert.match(fault, /lua51/);
  assert.match(fault, /lua5_1/);
  assert.match(fault, /nosuchpkg/);
  // The pin is part of the answer: the same name can resolve on another branch.
  assert.match(fault, /nixos-25\.05/);
});
