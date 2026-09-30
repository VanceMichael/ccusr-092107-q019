import test from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger.js";
import { Registry, ENTITY_KINDS } from "../src/registry.js";

test("台账只增且哈希链可校验", () => {
  const l = new Ledger();
  l.append("entity.registered", { kind: "recipe", id: "R1", version: 1, data: {} }, { at: "2026-01-01T00:00:00+08:00" });
  l.append("entity.registered", { kind: "recipe", id: "R2", version: 1, data: {} }, { at: "2026-01-02T00:00:00+08:00" });
  assert.equal(l.verify(), true);

  const tampered = new Ledger();
  tampered.append("entity.registered", { kind: "recipe", id: "R1", version: 1, data: {} }, { at: "2026-01-01T00:00:00+08:00" });
  tampered.events[0].payload.data = { forged: true };
  assert.equal(tampered.verify(), false);

  assert.throws(() => new Ledger([{ ...l.events[0], seq: 5 }]), /序号断裂/);
});

test("实体按版本连续登记并自动失效旧版", () => {
  const reg = new Registry(new Ledger());
  reg.register("recipe", "RC", { ingredients: ["A"] }, { at: "2026-01-01T00:00:00+08:00" });
  reg.publishNewVersion("recipe", "RC", { ingredients: ["A", "B"] }, { at: "2026-02-01T00:00:00+08:00" });

  assert.equal(reg.currentVersion("recipe", "RC"), 2);
  assert.equal(reg.versionAt("recipe", "RC", "2026-01-15T00:00:00+08:00"), 1);
  assert.equal(reg.versionAt("recipe", "RC", "2026-03-01T00:00:00+08:00"), 2);
  assert.deepEqual(reg.get("recipe", "RC", 1).ingredients, ["A"]); // 旧版内容原样保留
  assert.deepEqual(reg.get("recipe", "RC", 2).ingredients, ["A", "B"]);
  assert.equal(reg.get("recipe", "RC", 1)._meta.retired_at, "2026-02-01T00:00:00+08:00");

  assert.throws(
    () => reg.register("recipe", "RC", {}, { at: "2026-03-01T00:00:00+08:00" }),
    /新版本必须显式发布并使旧版失效，不能覆盖注册/
  );
  assert.throws(
    () => reg.publishNewVersion("unknown_kind", "X", {}, { at: "2026-03-01T00:00:00+08:00" }),
    /未知实体类别/
  );
});

test("八类受版本化管理的资料全部可登记", () => {
  const expected = ["category", "recipe", "trademark", "packaging", "channel_page", "endorsement", "test_report", "legal_opinion"];
  for (const k of expected) assert.ok(ENTITY_KINDS.includes(k));
  assert.ok(ENTITY_KINDS.includes("regulation"));
});
