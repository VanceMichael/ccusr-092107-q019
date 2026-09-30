import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildScenario } from "../src/scenario.js";
import { ApprovalService, ConcurrencyConflictError, ComplianceBlockedError } from "../src/service.js";
import { parseContext } from "../src/context.js";

test("剧本完整重放：台账可校验，两类非法尝试均留痕", () => {
  const { service, exceptions } = buildScenario();
  assert.equal(service.ledger.verify(), true);
  const codes = exceptions.map((e) => e.code);
  assert.ok(codes.includes("concurrency_conflict"));
  assert.ok(codes.includes("compliance_blocked"));

  // 并发冲突在台账中有 blocked 记录，旧意见没有污染修订版审批
  const blocked = service.ledger.events.filter((e) => e.type === "review.blocked");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].payload.base_revision, 1);
  assert.equal(blocked[0].payload.current_revision, 2);

  // 超范围投放被拦截：有 placement.blocked 留痕，没有对应投放
  const blockedPlacement = service.ledger.events.find((e) => e.type === "placement.blocked");
  assert.equal(blockedPlacement.payload.channel_id, "kuaishou");
  assert.equal(service.placements.has("PL-KS-ATTEMPT"), false);
});

test("跨渠道复用与代言超范围均产生异常事件", () => {
  const { service } = buildScenario();
  const pdd = service.placements.get("PL-PDD-01");
  const kinds = pdd.incidents.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["cross_channel_reuse", "endorsement_out_of_scope"]);
  // 代言扩权登记为 v2，时点查询可区分
  assert.equal(service.registry.versionAt("endorsement", "ED-JIANGJQ", "2026-04-08T00:00:00+08:00"), 1);
  assert.equal(service.registry.versionAt("endorsement", "ED-JIANGJQ", "2026-04-10T00:00:00+08:00"), 2);
});

test("旧图回流：未批准上架被记录、强制下架后才允许澄清", () => {
  const { service } = buildScenario();
  const pl = service.placements.get("PL-PDD-02");
  assert.equal(pl.launch_mode, "unauthorized");
  assert.ok(pl.incidents.some((i) => i.kind === "old_image_return"));

  assert.throws(
    () => service.issueClarification({ placement_id: "PL-TMALL-03", text: "未下架先澄清", at: "2026-09-01T00:00:00+08:00" }),
    /尚未下架，应先下架再发澄清/
  );
  const clr = service.clarifications.find((c) => c.placement_id === "PL-PDD-02");
  assert.match(clr.text, /0.1g/); // 澄清必须写出现行真实含量
  assert.equal(clr.after_takedown, "巡检发现旧图回流且无有效批准，强制下架");
});

test("商标无效：影响扫描标出仍在投放素材与渠道页面", () => {
  const { scans } = buildScenario();
  const tm = scans.trademark;
  assert.deepEqual(tm.live_placements.map((p) => p.placement_id), ["PL-TMALL-02"]);
  // 拼多多渠道页当时仍指向含无效商标的 v2 旧素材
  const pages = tm.channel_pages.map((p) => p.shown_packaging);
  assert.ok(pages.includes("packaging/PK-TANG@v2"));
  assert.match(tm.action_required, /下架澄清/);
});

test("法规换版：在途审批被标出，按新规重出意见后才可继续", () => {
  const { service, scans } = buildScenario();
  assert.deepEqual(scans.regulation.pending_submissions.map((s) => s.submission_id), ["SUB-2026-004"]);
  const approval = service.approvals.get("AP-2026-005");
  assert.deepEqual(approval.based_on_regulations, ["regulation/REG-CN-FOODAD@v2"]);
});

test("投诉关联按截图时间还原：看到哪版文案、真实配料、当时依据、后续处置", () => {
  const { service } = buildScenario();
  const capturedAt = "2026-06-12T20:30:00+08:00";
  // 关联动作本身也落入台账；关联之后再按截图时间做一次完整还原
  const rec = service.reconstruct({ placement_id: "PL-PDD-02", at: capturedAt });
  assert.equal(rec.packaging_seen.ref, "packaging/PK-TANG@v2");
  assert.match(rec_packagingCopy(rec), /0.3g/);

  // 包装宣称依据的是旧配方，而截图当晚现行生产配方已降到 0.1g——两者必须分开呈现
  assert.equal(rec.recipe_on_packaging.ref, "recipe/RC-TANG@v1");
  assert.equal(rec.recipe_actual_at.ref, "recipe/RC-TANG@v2");
  assert.equal(rec.recipe_actual_at.matches_packaging, false);
  const actualGinseng = rec.recipe_actual_at.ingredients.find((i) => i.name.includes("人参"));
  assert.equal(actualGinseng.per_100g, 0.1);

  // 截图时该素材的复核结论应为 reject（旧配方已停用），且不是拿抽检报告搪塞
  assert.equal(rec.claim_evaluation_at.decision, "reject");
  assert.equal(rec.launch_mode, "unauthorized");

  // 包装所附抽检报告的适用范围必须写清：仅覆盖 Q1 两批次质量指标
  const tr = rec.test_reports_attached[0];
  assert.equal(tr.ref, "test_report/TR-Q1-2026@v1");
  assert.deepEqual(tr.batches, ["B20260301", "B20260305"]);
  assert.match(tr.scope_note, /不证明/);

  // 代言覆盖：素材钉住的授权 v1 当时不含拼多多（历史超范围异常已留痕），
  // 截图时点生效的授权 v2 已覆盖拼多多与本品——两者分开呈现
  assert.equal(rec.endorsement_status_at.length, 1);
  const ed = rec.endorsement_status_at[0];
  assert.equal(ed.ref, "endorsement/ED-JIANGJQ@v1");
  assert.ok(ed.pinned_problems_at.some((m) => m.includes("pdd")));
  assert.equal(ed.effective_version_at, "endorsement/ED-JIANGJQ@v2");
  assert.equal(ed.within_scope_at, true);
  assert.ok(!ed.effective_problems_at.some((m) => m.includes("pdd")));
  assert.deepEqual(ed.covers_pinned.product_ids, ["PRD-TANG-001"]);

  // 后续处置链完整：下架、澄清、投诉关联、投诉处理
  const types = rec.subsequent_actions.map((a) => a.type);
  for (const t of ["placement.ended", "clarification.issued", "complaint.linked", "complaint.handled"]) {
    assert.ok(types.includes(t), `处置链缺少 ${t}`);
  }
  assert.equal(rec.ledger_verified, true);

  // 投诉单本身记录了关联结论与处置
  const c = service.complaints.get("CMP-2026-0912-09");
  assert.equal(c.link.linked_placement_id, "PL-PDD-02");
  assert.equal(c.handling[0].decision, "部分属实并已处置");
});

function rec_packagingCopy(rec) {
  return rec.packaging_seen.front_copy;
}

test("时点还原：商标变更前的批准投放能取回当时有效商标状态", () => {
  const { service } = buildScenario();
  // 4 月时 v2 包装引用的商标仍为有效注册状态
  assert.equal(service.registry.versionAt("trademark", "TM-TANGSHEN", "2026-04-01T00:00:00+08:00"), 1);
  assert.equal(service.registry.get("trademark", "TM-TANGSHEN", 1).status, "registered");
  assert.equal(service.registry.versionAt("trademark", "TM-TANGSHEN", "2026-08-01T00:00:00+08:00"), 2);
});

test("取证包导出后可用事件重建出一致状态", () => {
  const { service } = buildScenario();
  const bundle = service.exportBundle();
  assert.equal(bundle.verified, true);
  assert.equal(bundle.domain, "food-claim-approval");
  const rebuilt = ApprovalService.fromEvents(bundle.events);
  assert.equal(rebuilt.ledger.verify(), true);
  assert.equal(rebuilt.placements.size, service.placements.size);
  assert.equal(rebuilt.submissions.size, service.submissions.size);
  assert.equal(rebuilt.complaints.size, service.complaints.size);
  const rec = rebuilt.reconstruct({ placement_id: "PL-PDD-02", at: "2026-06-12T20:30:00+08:00" });
  assert.equal(rec.recipe_actual_at.ref, "recipe/RC-TANG@v2");
});

test("产品侧角色不能审批自己的素材", () => {
  const { service } = buildScenario();
  assert.throws(
    () => service.recordReview({
      submission_id: "SUB-2026-001", reviewer: "u-linzhiyao", role: "product_manager",
      decision: "approve", base_revision: 1, at: "2026-03-07T12:00:00+08:00",
    }),
    /不属于审核侧/
  );
});

test("批准在签发时点复核：功效暗示素材无法取得批准", () => {
  const { service } = buildScenario();
  assert.equal(service.submissions.get("SUB-2026-001").status, "approved"); // 最终修订版获批
  // 首版 v1 曾被拒，台账保留被拒评估（含禁止的功效暗示）
  const created = service.ledger.events.find((e) => e.type === "submission.created");
  const c2 = created.payload.evaluation.results.find((r) => r.claim_key === "C2");
  assert.equal(c2.status, "blocked");
  assert.ok(c2.not_applicable.some((n) => n.ref === "test_report/TR-Q1-2026@v1"));
});

test("角色样例与基础领域资料可读取且不含真实个人信息字段", () => {
  return Promise.all([
    readFile(new URL("../fixtures/roles.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/context.json", import.meta.url), "utf8"),
  ]).then(([rolesRaw, ctxRaw]) => {
    const roles = JSON.parse(rolesRaw);
    assert.ok(roles.sides.product.members.length >= 4);
    assert.ok(roles.sides.review.members.some((m) => m.role === "legal_reviewer"));
    assert.ok(roles.sides.review.members.some((m) => m.role === "compliance_reviewer"));
    const ctx = parseContext(ctxRaw);
    assert.equal(ctx.domain, "food-claim-approval");
  });
});

test("异常类型可被调用方区分处理", () => {
  assert.equal(new ConcurrencyConflictError("S", 1, 2).code, "concurrency_conflict");
  assert.equal(new ComplianceBlockedError("x", []).code, "compliance_blocked");
});
