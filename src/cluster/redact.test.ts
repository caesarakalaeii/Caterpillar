/**
 * Tests for the describe redactor (DESIGN.md §20, §9.2).
 *
 * This file is the reason the guarantee is real rather than intended. Kubernetes RBAC
 * cannot express "read a Secret's keys but not its values", so the supervisor's
 * ServiceAccount genuinely holds `get secrets` and `redactObject` is the ENTIRE boundary
 * between that token and a model's transcript. A boundary with no adversarial test is a
 * comment.
 *
 * So the assertions are deliberately not "the data field was replaced". They are made on
 * the SERIALIZED output — the exact string the tool hands back — and they look for the
 * value in every encoding it could plausibly survive in: the base64 the API server
 * returned, the decoded plaintext, and the copy Kubernetes inlines into
 * `last-applied-configuration` when someone once ran `kubectl apply` on the Secret. That
 * last one is the leak worth naming: the values are gone from `data` and still present,
 * verbatim, one annotation away.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESCRIBABLE_KINDS,
  MAX_OBJECT_BYTES,
  UnsupportedKindError,
  assertKindDescribable,
  redactObject,
  renderObject,
} from "./redact.ts";

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

/** Every way a value could survive redaction, so a test cannot pass on a near miss. */
const assertAbsent = (rendered: string, secret: string): void => {
  assert.ok(!rendered.includes(secret), `plaintext '${secret}' leaked into the output`);
  assert.ok(!rendered.includes(b64(secret)), `base64 of '${secret}' leaked into the output`);
};

test("a Secret's `data` values are replaced by key name and byte length", () => {
  const rendered = renderObject(
    redactObject("Secret", {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "loki-basic-auth", namespace: "monitoring" },
      type: "Opaque",
      data: { password: b64("hunter2-correct-horse"), username: b64("admin") },
    }),
  );

  assertAbsent(rendered, "hunter2-correct-horse");
  assertAbsent(rendered, "admin");
  // The shape a session actually needs: which keys exist, and whether one is empty.
  assert.match(rendered, /password: 21 bytes/);
  assert.match(rendered, /username: 5 bytes/);
});

test("a Secret's `stringData` is redacted the same way — it is not the API server's field", () => {
  // `stringData` is write-only in the API and normally absent from a GET, but a manifest
  // read back from anywhere else carries it, and a redactor that only knew `data` would
  // hand the plaintext straight over.
  const rendered = renderObject(
    redactObject("Secret", {
      kind: "Secret",
      metadata: { name: "s", namespace: "n" },
      stringData: { token: "ghp_averyrealtokenvalue" },
    }),
  );

  assertAbsent(rendered, "ghp_averyrealtokenvalue");
  assert.match(rendered, /token: 23 bytes/);
});

test("a Secret with both fields loses both", () => {
  const rendered = renderObject(
    redactObject("Secret", {
      kind: "Secret",
      metadata: { name: "s", namespace: "n" },
      data: { encoded: b64("encoded-secret-value") },
      stringData: { plain: "plain-secret-value" },
    }),
  );

  assertAbsent(rendered, "encoded-secret-value");
  assertAbsent(rendered, "plain-secret-value");
  assert.match(rendered, /encoded: 20 bytes/);
  assert.match(rendered, /plain: 18 bytes/);
});

test("an empty-string value is reported as 0 bytes rather than dropped", () => {
  // A key that exists and is empty is a real diagnosis — an operator's `--from-literal`
  // that resolved to nothing — and the session can only see it if the key survives.
  const rendered = renderObject(
    redactObject("Secret", {
      kind: "Secret",
      metadata: { name: "s", namespace: "n" },
      data: { blank: "" },
      stringData: { alsoBlank: "" },
    }),
  );

  assert.match(rendered, /blank: 0 bytes/);
  assert.match(rendered, /alsoBlank: 0 bytes/);
});

test("values inlined into last-applied-configuration do not survive", () => {
  const secret = "s3cret-from-an-earlier-apply";
  const rendered = renderObject(
    redactObject("Secret", {
      kind: "Secret",
      metadata: {
        name: "s",
        namespace: "n",
        annotations: {
          "kubectl.kubernetes.io/last-applied-configuration": JSON.stringify({
            apiVersion: "v1",
            kind: "Secret",
            data: { password: b64(secret) },
            stringData: { password: secret },
          }),
          "meta.helm.sh/release-name": "loki",
        },
      },
      data: { password: b64(secret) },
    }),
  );

  assertAbsent(rendered, secret);
  assert.ok(
    !rendered.includes("last-applied-configuration"),
    "the annotation itself must be dropped, not merely redacted inside",
  );
  // Other annotations are diagnostic and stay: which chart owns the object is often the
  // answer to "why does this look nothing like the manifest in the repo".
  assert.match(rendered, /meta\.helm\.sh\/release-name/);
});

test("binary-ish base64 is measured, not decoded into the output", () => {
  const binary = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80]).toString("base64");
  const rendered = renderObject(
    redactObject("Secret", {
      kind: "Secret",
      metadata: { name: "tls", namespace: "n" },
      type: "kubernetes.io/tls",
      data: { "tls.key": binary },
    }),
  );

  assert.ok(!rendered.includes(binary), "the encoded blob leaked into the output");
  assert.match(rendered, /tls\.key: 6 bytes/);
  // `type` is the useful part of a TLS Secret and carries nothing private.
  assert.match(rendered, /kubernetes\.io\/tls/);
});

test("a non-string Secret value is refused rather than measured wrongly", () => {
  // The API server only ever sends strings here, so a number means the object came from
  // somewhere else. Reporting a length for it would be inventing one; the safe reading is
  // that the value is unknown and must not be rendered.
  const rendered = renderObject(
    redactObject("Secret", {
      kind: "Secret",
      metadata: { name: "s", namespace: "n" },
      data: { odd: 12345 },
    }),
  );

  assert.ok(!rendered.includes("12345"), "a non-string value leaked into the output");
  assert.match(rendered, /odd: <redacted>/);
});

test("a ConfigMap is returned in full — that is where misconfigurations live", () => {
  const rendered = renderObject(
    redactObject("ConfigMap", {
      kind: "ConfigMap",
      metadata: { name: "caterpillar-config", namespace: "caterpillar" },
      data: { "config.json": '{"pollSeconds": 30}' },
    }),
  );

  assert.match(rendered, /pollSeconds/);
});

test("managedFields is dropped from every kind", () => {
  for (const kind of ["Pod", "ConfigMap", "Secret", "Deployment"]) {
    const rendered = renderObject(
      redactObject(kind, {
        kind,
        metadata: {
          name: "x",
          namespace: "n",
          managedFields: [{ manager: "kubectl-client-side-apply", operation: "Update" }],
        },
        spec: { replicas: 1 },
        status: { phase: "Running" },
      }),
    );

    assert.ok(!rendered.includes("managedFields"), `${kind} kept managedFields`);
    assert.ok(!rendered.includes("kubectl-client-side-apply"), `${kind} kept a field manager`);
    // spec and status are the whole point of a describe and must survive.
    assert.match(rendered, /replicas/);
    assert.match(rendered, /phase: Running/);
  }
});

test("redaction does not mutate the object it was given", () => {
  const original = {
    kind: "Secret",
    metadata: {
      name: "s",
      namespace: "n",
      managedFields: [{ manager: "m" }],
      annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{}" },
    },
    data: { password: b64("keepme") },
  };

  redactObject("Secret", original);

  assert.deepEqual(original.data, { password: b64("keepme") });
  assert.equal(original.metadata.managedFields.length, 1);
  assert.ok(
    "kubectl.kubernetes.io/last-applied-configuration" in original.metadata.annotations,
    "the caller's annotations were mutated",
  );
});

test("an object over the size cap is truncated and says so", () => {
  const rendered = renderObject(
    redactObject("ConfigMap", {
      kind: "ConfigMap",
      metadata: { name: "big", namespace: "n" },
      data: { blob: "x".repeat(MAX_OBJECT_BYTES * 2) },
    }),
  );

  assert.ok(Buffer.byteLength(rendered, "utf8") < MAX_OBJECT_BYTES * 1.2);
  assert.match(rendered, /truncated/i);
  assert.match(rendered, new RegExp(String(MAX_OBJECT_BYTES)));
});

test("an object under the cap carries no truncation note", () => {
  const rendered = renderObject(
    redactObject("Pod", { kind: "Pod", metadata: { name: "p", namespace: "n" } }),
  );

  assert.ok(!/truncated/i.test(rendered));
});

test("only the eleven listed kinds are describable, and the refusal lists them", () => {
  for (const kind of DESCRIBABLE_KINDS) assertKindDescribable(kind);

  for (const kind of ["Node", "Namespace", "ClusterRole", "ServiceAccount", "secret", ""]) {
    let caught: unknown;
    try {
      assertKindDescribable(kind);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof UnsupportedKindError, `${kind} was accepted`);
    // The message has to be the whole interface: a model told only "no" retries.
    for (const allowed of DESCRIBABLE_KINDS) {
      assert.ok(
        (caught as Error).message.includes(allowed),
        `the refusal for '${kind}' does not mention ${allowed}`,
      );
    }
  }
});

test("Node is not describable, because a node's fields are not this feature's business", () => {
  // Named separately from the loop above because it is the one an alert most invites: a
  // memory-pressure alert points at a node, and widening the list to reach it should be a
  // code review rather than a config change. The list is a literal for that reason.
  assert.ok(!DESCRIBABLE_KINDS.includes("Node"));
});
