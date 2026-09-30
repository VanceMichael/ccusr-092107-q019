import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { loadSeed } from "../src/seed.js";

async function setup() {
  const raw = await readFile(new URL("../fixtures/seed.json", import.meta.url), "utf8");
  return loadSeed(raw);
}

// 注册一个只有成分含量表述的包装版本，供各场景复用
function registerPlainPackaging(service, { validFrom, formulaVersion = 1, frontCopy = "每瓶添加胶原蛋白肽10000mg" }) {
  return service.registerEntityVersion({
    kind: "packaging",
    id: "pack-yueyan",
    validFrom,
    actor: "pm",
    payload: {
      product_id: "prod-collagen-drink",
      formula: { id: "f-collagen", version: formulaVersion },
      front_copy: frontCopy,
      claims: [
        {
          id: "clm-content",
          kind: "ingredient_content",
          text: "每瓶添加胶原蛋白肽10000mg",
          evidence: [
            { kind: "inspection", id: "insp-2026q1", version: 1 },
            { kind: "legal_opinion", id: "lo-claims", version: 1 },
          ],
        },
      ],
    },
  });
}

function approvePage(service, subject, { at }) {
  service.decide({ subject, role: "regulatory_reviewer", decision: "approved", actor: "reg", at: `${at}T09:00:00Z` });
  service.decide({ subject, role: "legal_reviewer", decision: "approved", actor: "legal", at: `${at}T10:00:00Z` });
}

test("样例资料包含产品与审核角色", async () => {
  const { seed } = await setup();
  assert.equal(seed.products[0].id, "prod-collagen-drink");
  assert.ok(seed.roles.some((role) => role.id === "regulatory_reviewer"));
  assert.ok(seed.roles.some((role) => role.id === "legal_reviewer"));
  assert.ok(seed.roles.some((role) => role.id === "quality_reviewer"));
});

test("完整时间线：审签、投放、变化影响、下架澄清、投诉关联与还原", async () => {
  const { service, audit } = await setup();

  // 2026-01 包装v1含功效暗示，法务驳回（抽检报告不能支撑功效）
  service.registerEntityVersion({
    kind: "packaging",
    id: "pack-yueyan",
    validFrom: "2026-01-25T00:00:00Z",
    actor: "pm",
    payload: {
      product_id: "prod-collagen-drink",
      formula: { id: "f-collagen", version: 1 },
      front_copy: "每瓶添加胶原蛋白肽10000mg，喝出少女肌",
      claims: [
        {
          id: "clm-content",
          kind: "ingredient_content",
          text: "每瓶添加胶原蛋白肽10000mg",
          evidence: [
            { kind: "inspection", id: "insp-2026q1", version: 1 },
            { kind: "legal_opinion", id: "lo-claims", version: 1 },
          ],
        },
        {
          id: "clm-beauty",
          kind: "efficacy_implication",
          text: "喝出少女肌",
          evidence: [{ kind: "inspection", id: "insp-2026q1", version: 1 }],
        },
      ],
    },
  });
  const packV1 = { kind: "packaging", id: "pack-yueyan", version: 1 };
  service.submit({ subject: packV1, intendedChannels: [], actor: "pm", at: "2026-01-26T09:00:00Z" });
  service.decide({ subject: packV1, role: "quality_reviewer", decision: "approved", actor: "qa", at: "2026-01-26T10:00:00Z" });
  service.decide({ subject: packV1, role: "regulatory_reviewer", decision: "approved", actor: "reg", at: "2026-01-26T11:00:00Z" });
  const legalReject = service.decide({
    subject: packV1,
    role: "legal_reviewer",
    decision: "rejected",
    actor: "legal",
    at: "2026-01-27T09:00:00Z",
    rationale: "功效暗示无证据支持",
  });
  assert.equal(service.approvalStatus(packV1).approved, false);
  const beauty = legalReject.claimResults.find((item) => item.claim_id === "clm-beauty");
  assert.equal(beauty.ok, false);
  assert.ok(beauty.problems.some((p) => p.code === "kind_not_supported"));

  // 2026-02 包装v2去掉功效暗示，三角色审签通过
  registerPlainPackaging(service, { validFrom: "2026-02-01T00:00:00Z" });
  const packV2 = { kind: "packaging", id: "pack-yueyan", version: 2 };
  service.submit({ subject: packV2, intendedChannels: [], actor: "pm", at: "2026-02-01T09:00:00Z" });
  service.decide({ subject: packV2, role: "quality_reviewer", decision: "approved", actor: "qa", at: "2026-02-02T09:00:00Z" });
  service.decide({ subject: packV2, role: "regulatory_reviewer", decision: "approved", actor: "reg", at: "2026-02-02T10:00:00Z" });
  service.decide({ subject: packV2, role: "legal_reviewer", decision: "approved", actor: "legal", at: "2026-02-02T11:00:00Z" });
  assert.equal(service.approvalStatus(packV2).approved, true);

  // 2026-02 天猫页面v1（包装v2）审签并投放
  service.registerEntityVersion({
    kind: "channel_page",
    id: "page-tmall",
    validFrom: "2026-02-10T00:00:00Z",
    actor: "pm",
    payload: { product_id: "prod-collagen-drink", packaging: { id: "pack-yueyan", version: 2 }, page_copy: "天猫详情页v1" },
  });
  const pageTmallV1 = { kind: "channel_page", id: "page-tmall", version: 1 };
  service.submit({ subject: pageTmallV1, intendedChannels: ["tmall"], actor: "pm", at: "2026-02-10T09:00:00Z" });
  approvePage(service, pageTmallV1, { at: "2026-02-11" });
  const pub1 = service.publish({
    subject: pageTmallV1,
    channel: "tmall",
    audience: { regions: ["全国"], segments: ["平台全部用户"] },
    actor: "pm",
    at: "2026-02-15T09:00:00Z",
  });
  assert.deepEqual(pub1.flags, []);

  // 2026-03 抖音页面v1（包装v2 + 代言）审签并投放，代言范围覆盖
  service.registerEntityVersion({
    kind: "channel_page",
    id: "page-douyin",
    validFrom: "2026-03-01T00:00:00Z",
    actor: "pm",
    payload: {
      product_id: "prod-collagen-drink",
      packaging: { id: "pack-yueyan", version: 2 },
      endorsement: { id: "end-star", version: 1 },
      page_copy: "抖音详情页v1",
    },
  });
  const pageDouyinV1 = { kind: "channel_page", id: "page-douyin", version: 1 };
  service.submit({ subject: pageDouyinV1, intendedChannels: ["douyin"], actor: "pm", at: "2026-03-01T09:00:00Z" });
  approvePage(service, pageDouyinV1, { at: "2026-03-02" });
  const pub2 = service.publish({
    subject: pageDouyinV1,
    channel: "douyin",
    audience: { regions: ["全国"], segments: ["短视频推荐流用户"] },
    actor: "pm",
    at: "2026-03-05T09:00:00Z",
  });
  assert.deepEqual(pub2.flags, []);
  assert.ok(pub2.claimResults.some((item) => item.kind === "endorsement_presence" && item.ok));

  // 2026-06 配方换甜味剂，包装v3上市（钉住配方v2）
  service.registerEntityVersion({
    kind: "formula",
    id: "f-collagen",
    validFrom: "2026-06-01T00:00:00Z",
    actor: "qa",
    payload: { ingredients: ["水", "胶原蛋白肽", "甜菊糖苷", "柠檬酸", "食用香精"], note: "甜味剂更换" },
  });
  registerPlainPackaging(service, { validFrom: "2026-06-05T00:00:00Z", formulaVersion: 2, frontCopy: "每瓶添加胶原蛋白肽10000mg（新装）" });

  // 2026-07 天猫页面v2复用旧包装图（包装v2）→ 旧图回流留痕
  service.registerEntityVersion({
    kind: "channel_page",
    id: "page-tmall",
    validFrom: "2026-06-20T00:00:00Z",
    actor: "pm",
    payload: { product_id: "prod-collagen-drink", packaging: { id: "pack-yueyan", version: 2 }, page_copy: "天猫详情页v2（复用旧包装图）" },
  });
  const pageTmallV2 = { kind: "channel_page", id: "page-tmall", version: 2 };
  service.submit({ subject: pageTmallV2, intendedChannels: ["tmall"], actor: "pm", at: "2026-06-20T09:00:00Z" });
  approvePage(service, pageTmallV2, { at: "2026-06-21" });
  const pub3 = service.publish({
    subject: pageTmallV2,
    channel: "tmall",
    audience: { regions: ["全国"], segments: ["平台全部用户"] },
    actor: "pm",
    at: "2026-07-01T09:00:00Z",
  });
  assert.ok(pub3.flags.includes("old_image_resurfaced"));
  const resurfaced = audit.list({ type: "old_image_resurfaced" });
  assert.equal(resurfaced.length, 1);
  assert.equal(resurfaced[0].details.pinned_packaging_version, 2);
  assert.equal(resurfaced[0].details.current_packaging_version, 3);

  // 2026-08-01 商标状态变化 → 标出仍在投放的受影响素材
  const tmChange = service.registerEntityVersion({
    kind: "trademark",
    id: "tm-yueyan",
    validFrom: "2026-08-01T00:00:00Z",
    actor: "legal",
    changeReason: "trademark_status_change",
    payload: { mark: "悦颜（虚构商标）", status: "无效宣告审理中", classes: ["32"], owner: "示例公司" },
  });
  assert.equal(tmChange.affected.length, 3);
  for (const pub of [pub1, pub2, pub3]) assert.ok(pub.flags.includes("affected_by_change"));

  // 2026-08-15 法规口径变化 → 再次标出受影响素材
  const loChange = service.registerEntityVersion({
    kind: "legal_opinion",
    id: "lo-claims",
    validFrom: "2026-08-15T00:00:00Z",
    actor: "legal",
    changeReason: "regulation_change",
    payload: {
      scope: { supports: ["ingredient_content", "endorsement_presence"], validFrom: "2026-08-15T00:00:00Z" },
      clears: ["与检验报告一致且加注“本品不能代替药物”的含量表述"],
      rejects: ["任何功效暗示"],
      basis: ["广告法", "食品安全法", "2026年监管口径更新"],
    },
  });
  assert.equal(loChange.affected.length, 3);

  // 2026-08-20 下架复用旧图的页面并发布澄清
  service.takedown(pub3.id, { at: "2026-08-20T09:00:00Z", actor: "pm", reason: "商标状态变化，主动下架复用旧包装图的页面" });
  assert.equal(pub3.status, "taken_down");
  service.clarify({
    publicationId: pub3.id,
    text: "旧包装图页面已下架，产品为普通食品，不宣称功效",
    channels: ["tmall"],
    at: "2026-08-21T09:00:00Z",
    actor: "pm",
  });

  // 2026-08-25 投诉：消费者8月10日截图天猫包装图 → 关联到当时在线的pub3
  const complaint1 = service.fileComplaint({
    channel: "tmall",
    observedAt: "2026-08-10T10:00:00Z",
    receivedAt: "2026-08-25T09:00:00Z",
    description: "消费者截图天猫包装图，质疑宣传美容功效",
  });
  assert.equal(complaint1.publicationId, pub3.id);
  const ctx1 = service.complaintContext(complaint1.id);
  assert.equal(ctx1.front_copy.version, 2);
  assert.equal(ctx1.front_copy.text, "每瓶添加胶原蛋白肽10000mg");
  assert.equal(ctx1.front_copy.latest_version, 3);
  assert.ok(ctx1.ingredients.as_shown.list.includes("赤藓糖醇"));
  assert.ok(ctx1.ingredients.current_at_observation.list.includes("甜菊糖苷"));
  assert.equal(ctx1.endorsement_scope, null);
  assert.ok(ctx1.claims.every((item) => item.ok));

  // 2026-09-12 针对投诉发布澄清，投诉状态联动
  service.clarify({
    complaintId: complaint1.id,
    text: "已向投诉人说明其所见页面版本与当时配料",
    channels: ["tmall"],
    at: "2026-09-12T09:00:00Z",
    actor: "pm",
  });
  assert.equal(complaint1.status, "clarified");

  // 2026-09-15 第二条投诉：抖音页面在观察时点检验报告已过期
  const complaint2 = service.fileComplaint({
    channel: "douyin",
    observedAt: "2026-09-10T10:00:00Z",
    receivedAt: "2026-09-15T09:00:00Z",
    description: "消费者质疑抖音页面含量宣称",
  });
  assert.equal(complaint2.publicationId, pub2.id);
  const ctx2 = service.complaintContext(complaint2.id);
  assert.ok(ctx2.endorsement_scope.products.includes("prod-collagen-drink"));
  const expiredClaim = ctx2.claims.find((item) => item.claim_id === "clm-content");
  assert.ok(expiredClaim.problems.some((p) => p.code === "evidence_expired"));

  // 事后还原pub3：发布时间、受众、当时依据、后续处置
  const reconstruction = service.reconstruct(pub3.id);
  assert.equal(reconstruction.published_at, "2026-07-01T09:00:00Z");
  assert.deepEqual(reconstruction.audience.segments, ["平台全部用户"]);
  assert.equal(reconstruction.basis["trademark:tm-yueyan"].version, 1);
  assert.equal(reconstruction.basis["trademark:tm-yueyan"].payload.status, "已注册");
  assert.equal(reconstruction.basis["formula:f-collagen"].version, 1);
  assert.equal(reconstruction.basis["packaging:pack-yueyan"].version, 2);
  assert.equal(reconstruction.subsequent.takedown.reason, "商标状态变化，主动下架复用旧包装图的页面");
  assert.ok(reconstruction.subsequent.clarifications.length >= 1);
  assert.ok(reconstruction.subsequent.complaints.some((item) => item.id === complaint1.id));
  const eventTypes = reconstruction.subsequent.events.map((event) => event.type);
  assert.ok(eventTypes.includes("affected_material_flagged"));
  assert.ok(eventTypes.includes("publication_taken_down"));
  assert.ok(eventTypes.includes("complaint_filed"));
});

test("未完成审签的素材不得投放", async () => {
  const { service } = await setup();
  registerPlainPackaging(service, { validFrom: "2026-03-20T00:00:00Z" });
  service.registerEntityVersion({
    kind: "channel_page",
    id: "page-x",
    validFrom: "2026-04-01T00:00:00Z",
    actor: "pm",
    payload: { product_id: "prod-collagen-drink", packaging: { id: "pack-yueyan", version: 1 } },
  });
  const subject = { kind: "channel_page", id: "page-x", version: 1 };
  service.submit({ subject, intendedChannels: ["tmall"], actor: "pm", at: "2026-04-01T09:00:00Z" });
  service.decide({ subject, role: "regulatory_reviewer", decision: "approved", actor: "reg", at: "2026-04-02T09:00:00Z" });
  assert.throws(
    () => service.publish({ subject, channel: "tmall", audience: {}, actor: "pm", at: "2026-04-03T09:00:00Z" }),
    /未完成审签/,
  );
});

test("并发审批结论不一致时双方留痕", async () => {
  const { service, audit } = await setup();
  registerPlainPackaging(service, { validFrom: "2026-04-20T00:00:00Z" });
  service.registerEntityVersion({
    kind: "channel_page",
    id: "page-y",
    validFrom: "2026-05-01T00:00:00Z",
    actor: "pm",
    payload: { product_id: "prod-collagen-drink", packaging: { id: "pack-yueyan", version: 1 } },
  });
  const subject = { kind: "channel_page", id: "page-y", version: 1 };
  service.submit({ subject, intendedChannels: ["tmall"], actor: "pm", at: "2026-05-01T09:00:00Z" });
  const decA = service.decide({
    subject,
    role: "regulatory_reviewer",
    decision: "approved",
    actor: "reg",
    at: "2026-05-10T10:00:00Z",
    basisAt: "2026-05-10T09:00:00Z",
  });
  const decB = service.decide({
    subject,
    role: "legal_reviewer",
    decision: "rejected",
    actor: "legal",
    at: "2026-05-10T10:30:00Z",
    basisAt: "2026-05-10T09:30:00Z",
  });
  assert.equal(decA.conflict, true);
  assert.equal(decB.conflict, true);
  const conflicts = audit.list({ type: "concurrent_approval_conflict" });
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].details.decisions, [decA.id, decB.id]);
  assert.equal(conflicts[0].details.overlapping_windows, true);
  assert.equal(service.approvalStatus(subject).has_conflict, true);
});

test("评审期间依据变化会标记过期依据", async () => {
  const { service, audit } = await setup();
  registerPlainPackaging(service, { validFrom: "2026-07-15T00:00:00Z" });
  service.registerEntityVersion({
    kind: "channel_page",
    id: "page-z",
    validFrom: "2026-07-20T00:00:00Z",
    actor: "pm",
    payload: { product_id: "prod-collagen-drink", packaging: { id: "pack-yueyan", version: 1 } },
  });
  const subject = { kind: "channel_page", id: "page-z", version: 1 };
  service.submit({ subject, intendedChannels: ["tmall"], actor: "pm", at: "2026-07-20T09:00:00Z" });
  service.registerEntityVersion({
    kind: "trademark",
    id: "tm-yueyan",
    validFrom: "2026-08-01T00:00:00Z",
    actor: "legal",
    changeReason: "trademark_status_change",
    payload: { mark: "悦颜（虚构商标）", status: "无效宣告审理中", classes: ["32"], owner: "示例公司" },
  });
  const decision = service.decide({
    subject,
    role: "legal_reviewer",
    decision: "approved",
    actor: "legal",
    at: "2026-08-10T10:00:00Z",
    basisAt: "2026-07-30T10:00:00Z",
  });
  assert.ok(decision.staleBasis.includes("trademark:tm-yueyan"));
  assert.equal(audit.list({ type: "approval_basis_stale" }).length, 1);
});

test("跨渠道复用与代言范围外投放均留痕", async () => {
  const { service, audit } = await setup();
  registerPlainPackaging(service, { validFrom: "2026-04-01T00:00:00Z" });
  service.registerEntityVersion({
    kind: "channel_page",
    id: "page-w",
    validFrom: "2026-04-10T00:00:00Z",
    actor: "pm",
    payload: {
      product_id: "prod-collagen-drink",
      packaging: { id: "pack-yueyan", version: 1 },
      endorsement: { id: "end-star", version: 1 },
    },
  });
  const subject = { kind: "channel_page", id: "page-w", version: 1 };
  service.submit({ subject, intendedChannels: ["douyin"], actor: "pm", at: "2026-04-10T09:00:00Z" });
  approvePage(service, subject, { at: "2026-04-11" });
  const pub = service.publish({
    subject,
    channel: "kuaishou",
    audience: { regions: ["全国"], segments: ["全部用户"] },
    actor: "pm",
    at: "2026-04-15T09:00:00Z",
  });
  assert.ok(pub.flags.includes("cross_channel_reuse"));
  assert.ok(pub.flags.includes("claim_evidence_invalid"));
  const endorsementClaim = pub.claimResults.find((item) => item.kind === "endorsement_presence");
  assert.ok(endorsementClaim.problems.some((p) => p.code === "channel_out_of_scope"));
  assert.equal(audit.list({ type: "cross_channel_reuse" }).length, 1);
  assert.equal(audit.list({ type: "claim_evidence_invalid" }).length, 1);
});

test("未配置的角色无权审签", async () => {
  const { service } = await setup();
  registerPlainPackaging(service, { validFrom: "2026-03-01T00:00:00Z" });
  const subject = { kind: "packaging", id: "pack-yueyan", version: 1 };
  assert.throws(
    () =>
      service.decide({ subject, role: "product_manager", decision: "approved", actor: "pm", at: "2026-03-02T09:00:00Z" }),
    /无权审签/,
  );
});

test("投诉无法关联投放时报错", async () => {
  const { service } = await setup();
  assert.throws(
    () =>
      service.fileComplaint({
        channel: "tmall",
        observedAt: "2026-01-01T00:00:00Z",
        receivedAt: "2026-01-02T00:00:00Z",
        description: "无对应投放",
      }),
    /无投放记录/,
  );
});
