import test from "node:test";
import assert from "node:assert/strict";

import { createAuditLog } from "../src/audit.js";
import { createRegistry } from "../src/registry.js";

function makeRegistry() {
  const audit = createAuditLog();
  return { audit, registry: createRegistry(audit) };
}

test("版本必须连续登记", () => {
  const { registry } = makeRegistry();
  registry.registerVersion({ kind: "formula", id: "f1", version: 1, payload: {}, validFrom: "2026-01-01T00:00:00Z", actor: "a" });
  assert.throws(
    () =>
      registry.registerVersion({ kind: "formula", id: "f1", version: 3, payload: {}, validFrom: "2026-02-01T00:00:00Z", actor: "a" }),
    /版本必须连续/,
  );
});

test("新版本生效时间必须晚于上一版本", () => {
  const { registry } = makeRegistry();
  registry.registerVersion({ kind: "formula", id: "f1", version: 1, payload: {}, validFrom: "2026-01-01T00:00:00Z", actor: "a" });
  assert.throws(
    () =>
      registry.registerVersion({ kind: "formula", id: "f1", version: 2, payload: {}, validFrom: "2026-01-01T00:00:00Z", actor: "a" }),
    /生效时间必须晚于上一版本/,
  );
});

test("current 按时间返回当时版本，旧版本保留有效期并留痕", () => {
  const { audit, registry } = makeRegistry();
  registry.registerVersion({ kind: "trademark", id: "tm1", version: 1, payload: { status: "已注册" }, validFrom: "2026-01-01T00:00:00Z", actor: "a" });
  registry.registerVersion({ kind: "trademark", id: "tm1", version: 2, payload: { status: "无效宣告审理中" }, validFrom: "2026-06-01T00:00:00Z", actor: "a", changeReason: "trademark_status_change" });

  assert.equal(registry.current("trademark", "tm1", "2026-03-01T00:00:00Z").version, 1);
  assert.equal(registry.current("trademark", "tm1", "2026-07-01T00:00:00Z").version, 2);
  assert.equal(registry.current("trademark", "tm1").version, 2);

  const v1 = registry.get("trademark", "tm1", 1);
  assert.equal(v1.validTo, "2026-06-01T00:00:00Z");
  assert.equal(v1.status, "superseded");

  const registered = audit.list({ type: "entity_version_registered" });
  assert.equal(registered.length, 2);
  assert.equal(registered[1].details.changeReason, "trademark_status_change");
});

test("未知资料类别报错", () => {
  const { registry } = makeRegistry();
  assert.throws(
    () => registry.registerVersion({ kind: "secret", id: "x", version: 1, payload: {}, validFrom: "2026-01-01T00:00:00Z", actor: "a" }),
    /未知资料类别/,
  );
});
