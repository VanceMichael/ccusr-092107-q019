import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { evaluateClaim } from "../src/claims.js";
import { loadSeed } from "../src/seed.js";

async function setup() {
  const raw = await readFile(new URL("../fixtures/seed.json", import.meta.url), "utf8");
  return loadSeed(raw);
}

const CONTENT_CLAIM = {
  id: "clm-content",
  kind: "ingredient_content",
  text: "每瓶添加胶原蛋白肽10000mg",
  evidence: [
    { kind: "inspection", id: "insp-2026q1", version: 1 },
    { kind: "legal_opinion", id: "lo-claims", version: 1 },
  ],
};

test("成分含量表述在证据适用范围内通过", async () => {
  const { registry } = await setup();
  const result = evaluateClaim(CONTENT_CLAIM, registry, {
    at: "2026-03-01T00:00:00Z",
    productId: "prod-collagen-drink",
    channel: "tmall",
  });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.length, 2);
  assert.ok(result.evidence[0].scope.items.includes("胶原蛋白肽含量"));
});

test("抽检报告不能支撑功效暗示", async () => {
  const { registry } = await setup();
  const claim = {
    id: "clm-beauty",
    kind: "efficacy_implication",
    text: "喝出少女肌",
    evidence: [{ kind: "inspection", id: "insp-2026q1", version: 1 }],
  };
  const result = evaluateClaim(claim, registry, { at: "2026-03-01T00:00:00Z" });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.code === "kind_not_supported"));
});

test("未附证据的表述不通过", async () => {
  const { registry } = await setup();
  const result = evaluateClaim({ id: "c0", kind: "ingredient_content", text: "无证据表述" }, registry, {
    at: "2026-03-01T00:00:00Z",
  });
  assert.ok(result.problems.some((p) => p.code === "evidence_missing"));
});

test("证据过期后不再覆盖表述", async () => {
  const { registry } = await setup();
  const result = evaluateClaim(CONTENT_CLAIM, registry, {
    at: "2026-10-01T00:00:00Z",
    productId: "prod-collagen-drink",
    channel: "tmall",
  });
  assert.ok(result.problems.some((p) => p.code === "evidence_expired" && p.evidence.startsWith("inspection:")));
});

test("代言范围按商品与渠道限制", async () => {
  const { registry } = await setup();
  const claim = {
    id: "clm-star",
    kind: "endorsement_presence",
    text: "页面出现代言形象",
    evidence: [{ kind: "endorsement", id: "end-star", version: 1 }],
  };
  const wrongProduct = evaluateClaim(claim, registry, {
    at: "2026-03-01T00:00:00Z",
    productId: "prod-other",
    channel: "tmall",
  });
  assert.ok(wrongProduct.problems.some((p) => p.code === "product_out_of_scope"));

  const wrongChannel = evaluateClaim(claim, registry, {
    at: "2026-03-01T00:00:00Z",
    productId: "prod-collagen-drink",
    channel: "kuaishou",
  });
  assert.ok(wrongChannel.problems.some((p) => p.code === "channel_out_of_scope"));

  const inScope = evaluateClaim(claim, registry, {
    at: "2026-03-01T00:00:00Z",
    productId: "prod-collagen-drink",
    channel: "douyin",
  });
  assert.equal(inScope.ok, true);
});
