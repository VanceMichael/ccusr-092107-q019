import test from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger.js";
import { Registry } from "../src/registry.js";
import { evaluateClaims } from "../src/claims.js";

function setup() {
  const reg = new Registry(new Ledger());
  const at = "2026-03-10T00:00:00+08:00";
  const add = (kind, id, data, when = at) => reg.register(kind, id, data, { at: when });
  add("category", "CAT", { name: "普通饮料", ordinary_food: true });
  add("recipe", "RC", {
    name: "配方", ingredients: [{ name: "枸杞", per_100g: 2, unit: "g" }], flavorings: ["柠檬香精"],
  });
  add("trademark", "TM", { name: "杞安", status: "registered", status_label: "已注册" });
  add("regulation", "REG", { title: "规范", status: "in_force" });
  add("test_report", "TR", {
    kind_label: "质量抽检", conclusion: "合格", batches: ["B1"],
    tested_items: ["菌落总数"], scope_note: "仅质量指标",
  });
  add("legal_opinion", "LO", {
    conclusions: [
      {
        claim_key: "F1", decision: "prohibited",
        basis_regulation: "regulation/REG@v1", reason: "普通食品不得宣称功效",
      },
      {
        claim_key: "F2", decision: "permitted_with_conditions",
        basis_regulation: "regulation/REG@v1", required_markings: ["本品为普通食品，不能代替药物"],
      },
    ],
  });
  return { reg, at };
}

test("成分暗示须由配方支撑，含量不足给附条件结论", () => {
  const { reg, at } = setup();
  const packaging = {
    _meta: { ref: "packaging/P@v1" },
    recipe_ref: "recipe/RC@v1", category_ref: "category/CAT@v1",
    trademark_ref: "trademark/TM@v1",
    test_report_refs: ["test_report/TR@v1"], legal_opinion_refs: [],
    front_copy: "真材实料", markings: [],
    claims: [{ key: "I1", kind: "ingredient", text: "枸杞配方", ingredient: "枸杞", require_min_per_100g: 2 }],
  };
  const ok = evaluateClaims(packaging, { registry: reg, at });
  assert.equal(ok.decision, "pass");
  assert.match(ok.results[0].supported_by[0].scope, /仅证明/);

  packaging.claims[0].require_min_per_100g = 5;
  const low = evaluateClaims(packaging, { registry: reg, at });
  assert.equal(low.decision, "conditions_required");
  assert.match(low.results[0].gaps[0], /低于暗示所需/);
});

test("配方中不存在的成分暗示直接阻断", () => {
  const { reg, at } = setup();
  const packaging = {
    _meta: { ref: "packaging/P@v1" },
    recipe_ref: "recipe/RC@v1", category_ref: "category/CAT@v1",
    test_report_refs: [], legal_opinion_refs: [], markings: [],
    claims: [{ key: "I2", kind: "ingredient", text: "人参配方", ingredient: "人参" }],
  };
  const r = evaluateClaims(packaging, { registry: reg, at });
  assert.equal(r.decision, "reject");
  assert.match(r.results[0].gaps[0], /不含「人参」/);
});

test("抽检合格报告不能支撑功效暗示，且须显式列为不适用证据", () => {
  const { reg, at } = setup();
  const packaging = {
    _meta: { ref: "packaging/P@v1" },
    recipe_ref: "recipe/RC@v1", category_ref: "category/CAT@v1",
    test_report_refs: ["test_report/TR@v1"], legal_opinion_refs: ["legal_opinion/LO@v1"], markings: [],
    claims: [{ key: "F1", kind: "function", text: "增强免疫力" }],
  };
  const r = evaluateClaims(packaging, { registry: reg, at });
  assert.equal(r.decision, "reject");
  assert.equal(r.results[0].not_applicable[0].ref, "test_report/TR@v1");
  assert.match(r.results[0].not_applicable[0].reason, /不能证明任何功效/);
  assert.match(r.results[0].gaps[0], /明确禁止/);
});

test("附条件功效表述：未满足标注为附条件，满足后放行", () => {
  const { reg, at } = setup();
  const base = {
    _meta: { ref: "packaging/P@v1" },
    recipe_ref: "recipe/RC@v1", category_ref: "category/CAT@v1",
    test_report_refs: ["test_report/TR@v1"], legal_opinion_refs: ["legal_opinion/LO@v1"],
    claims: [{ key: "F2", kind: "function", text: "某附条件表述" }],
  };
  assert.equal(evaluateClaims({ ...base, markings: [] }, { registry: reg, at }).decision, "conditions_required");
  const ok = evaluateClaims(
    { ...base, markings: ["本品为普通食品，不能代替药物"] }, { registry: reg, at }
  );
  assert.equal(ok.decision, "pass");
  assert.equal(ok.results[0].not_applicable.length, 1); // 即便放行，抽检报告仍标为不适用
});

test("法律意见依据的法规换版后旧意见失效", () => {
  const { reg, at } = setup();
  reg.publishNewVersion("regulation", "REG", { title: "规范", status: "in_force", rules: ["新要求"] }, { at: "2026-08-01T00:00:00+08:00" });
  const packaging = {
    _meta: { ref: "packaging/P@v1" },
    recipe_ref: "recipe/RC@v1", category_ref: "category/CAT@v1",
    test_report_refs: ["test_report/TR@v1"], legal_opinion_refs: ["legal_opinion/LO@v1"],
    markings: ["本品为普通食品，不能代替药物"],
    claims: [{ key: "F2", kind: "function", text: "某附条件表述" }],
  };
  const r = evaluateClaims(packaging, { registry: reg, at: "2026-08-02T00:00:00+08:00" });
  assert.equal(r.decision, "reject");
  assert.match(r.results[0].gaps[0], /已非现行版本/);
});

test("包装钉住的配方版本停用后，评估以停用依据阻断", () => {
  const { reg, at } = setup();
  reg.publishNewVersion("recipe", "RC", {
    name: "配方", ingredients: [{ name: "枸杞", per_100g: 0.1, unit: "g" }],
  }, { at: "2026-06-01T00:00:00+08:00" });
  const packaging = {
    _meta: { ref: "packaging/P@v1" },
    recipe_ref: "recipe/RC@v1", category_ref: "category/CAT@v1",
    test_report_refs: [], legal_opinion_refs: [], markings: [],
    claims: [{ key: "I1", kind: "ingredient", text: "枸杞2g", ingredient: "枸杞", require_min_per_100g: 2 }],
  };
  const r = evaluateClaims(packaging, { registry: reg, at: "2026-06-10T00:00:00+08:00" });
  assert.equal(r.decision, "reject");
  assert.equal(r.basis_notes[0].current_version, 2);
});
