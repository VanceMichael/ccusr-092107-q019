// 普通食品营销表述审签主服务。
// 全部业务动作以事件落入只增台账：送审、并发审批、投放、跨渠道复用、旧图回流、
// 下架澄清、投诉关联、商标/法规变更影响扫描均可追溯，并支持按投诉截图时间还原现场。
import { createHash } from "node:crypto";

import { Ledger } from "./ledger.js";
import { Registry } from "./registry.js";
import { evaluateClaims } from "./claims.js";
import { parseRef } from "./ids.js";

export class ConcurrencyConflictError extends Error {
  constructor(submissionId, expected, actual) {
    super(`并发审批冲突：素材 ${submissionId} 已被修订（基线 r${expected}，当前 r${actual}），旧版本审批意见须重新确认`);
    this.code = "concurrency_conflict";
    this.expected = expected;
    this.actual = actual;
  }
}

export class ComplianceBlockedError extends Error {
  constructor(message, findings) {
    super(message);
    this.code = "compliance_blocked";
    this.findings = findings;
  }
}

const REVIEW_SIDE_ROLES = ["legal_reviewer", "compliance_reviewer", "qa_reviewer"];
const REQUIRED_REVIEW_ROLES = ["legal_reviewer", "compliance_reviewer"];

export class ApprovalService {
  constructor({ clock = () => new Date().toISOString(), requiredReviewRoles = REQUIRED_REVIEW_ROLES } = {}) {
    this.clock = clock;
    this.ledger = new Ledger();
    this.registry = new Registry(this.ledger);
    this.requiredReviewRoles = requiredReviewRoles;
    this._rebuild();
  }

  static fromEvents(events, opts = {}) {
    const svc = new ApprovalService(opts);
    for (const e of events) svc.ledger._ingest(e);
    svc.registry._rebuild();
    svc._rebuild();
    return svc;
  }

  _rebuild() {
    this.submissions = new Map();
    this.approvals = new Map();
    this.placements = new Map();
    this.complaints = new Map();
    this.incidents = [];
    this.scans = [];
    this.clarifications = [];
    for (const e of this.ledger.events) this._apply(e);
  }

  _at(at) {
    return at ?? this.clock();
  }

  _append(type, payload, { at, actor } = {}) {
    return this.ledger.append(type, payload, { at: this._at(at), actor });
  }

  _apply(e) {
    const p = e.payload;
    switch (e.type) {
      case "submission.created":
        this.submissions.set(p.submission_id, {
          submission_id: p.submission_id,
          product_id: p.product_id,
          packaging_ref: p.packaging_ref,
          channel_page_refs: p.channel_page_refs,
          submitted_by: p.submitted_by,
          submitted_at: e.at,
          status: "pending",
          revision: 1,
          reviews: [],
          history: [{ revision: 1, packaging_ref: p.packaging_ref, at: e.at }],
          evaluation: p.evaluation,
        });
        break;
      case "submission.revised":
        {
          const s = this.submissions.get(p.submission_id);
          s.revision = p.revision;
          s.packaging_ref = p.packaging_ref ?? s.packaging_ref;
          s.status = "pending";
          s.evaluation = p.evaluation;
          s.history.push({ revision: p.revision, packaging_ref: s.packaging_ref, at: e.at });
        }
        break;
      case "review.recorded":
        {
          const s = this.submissions.get(p.submission_id);
          s.reviews.push({
            reviewer: p.reviewer, role: p.role, decision: p.decision,
            note: p.note, revision: p.revision, at: e.at,
          });
          if (p.revision === s.revision) {
            if (p.decision === "reject") s.status = "rejected";
            else if (p.decision === "changes") s.status = "changes_requested";
            else if (this._allRolesApproved(s)) s.status = "ready_for_approval";
          }
        }
        break;
      case "approval.issued":
        this.approvals.set(p.approval_no, { ...p, issued_at: e.at, active: true });
        this.submissions.get(p.submission_id).status = "approved";
        break;
      case "approval.revoked":
        this.approvals.get(p.approval_no).active = false;
        this.approvals.get(p.approval_no).revoked = { reason: p.reason, at: e.at };
        break;
      case "placement.launched":
        this.placements.set(p.placement_id, {
          ...p,
          launch_mode: "approved",
          launched_at: e.at,
          ended_at: null,
          end_reason: null,
          incidents: [],
        });
        break;
      case "placement.observed":
        // 巡检/投诉发现绕过审签的实际上架，只记事实：它不是批准记录。
        this.placements.set(p.placement_id, {
          ...p,
          launch_mode: "unauthorized",
          launched_at: p.observed_at,
          ended_at: null,
          end_reason: null,
          incidents: [],
        });
        break;
      case "placement.ended":
        {
          const pl = this.placements.get(p.placement_id);
          pl.ended_at = e.at;
          pl.end_reason = p.reason;
        }
        break;
      case "compliance.incident":
        this.incidents.push({ ...p, at: e.at });
        this.placements.get(p.placement_id)?.incidents.push({ ...p, at: e.at });
        break;
      case "clarification.issued":
        this.clarifications.push({ ...p, at: e.at });
        break;
      case "complaint.registered":
        this.complaints.set(p.complaint_id, { ...p, registered_at: e.at, link: null, handling: [] });
        break;
      case "complaint.linked":
        this.complaints.get(p.complaint_id).link = { ...p, at: e.at };
        break;
      case "complaint.handled":
        this.complaints.get(p.complaint_id).handling.push({ ...p, at: e.at });
        break;
      case "impact.scan":
        this.scans.push({ ...p, at: e.at });
        break;
      default:
        // entity.* 由 Registry 投影，主服务无需处理。
        break;
    }
  }

  _allRolesApproved(s) {
    const decisions = new Set(
      s.reviews.filter((r) => r.revision === s.revision && r.decision === "approve").map((r) => r.role)
    );
    return this.requiredReviewRoles.every((role) => decisions.has(role));
  }

  // ---- 实体登记（版本化）-------------------------------------------------

  registerEntity(kind, id, data, { at, actor } = {}) {
    return this.registry.register(kind, id, data, { at: this._at(at), actor });
  }

  publishNewVersion(kind, id, data, { at, actor } = {}) {
    return this.registry.publishNewVersion(kind, id, data, { at: this._at(at), actor });
  }

  // ---- 送审与并发审批 -----------------------------------------------------

  _evaluate(packagingRef, at) {
    const { kind, id, version } = parseRef(packagingRef);
    if (kind !== "packaging") throw new Error("送审对象必须是 packaging 引用");
    const packaging = this.registry.get(kind, id, version);
    packaging._meta.ref = packagingRef;
    return evaluateClaims(packaging, { registry: this.registry, at });
  }

  submitForReview({ submission_id, product_id, packaging_ref, channel_page_refs = [], submitted_by, at }) {
    const evaluation = this._evaluate(packaging_ref, this._at(at)); // 送审即评估，不合法素材无法进入流程
    this._append("submission.created", {
      submission_id, product_id, packaging_ref, channel_page_refs,
      submitted_by, evaluation,
    }, { at, actor: submitted_by });
    this._rebuild();
    return this.submissions.get(submission_id);
  }

  reviseSubmission({ submission_id, packaging_ref, actor, at, note }) {
    const s = this.submissions.get(submission_id);
    if (!s) throw new Error(`送审单不存在：${submission_id}`);
    const evaluation = packaging_ref ? this._evaluate(packaging_ref, this._at(at)) : s.evaluation;
    this._append("submission.revised", {
      submission_id, revision: s.revision + 1, packaging_ref, evaluation, note,
    }, { at, actor });
    this._rebuild();
    return this.submissions.get(submission_id);
  }

  // 并发控制：审批意见带 base_revision；素材已被修订时旧意见不能覆盖新版本。
  recordReview({ submission_id, reviewer, role, decision, note = "", base_revision, at }) {
    if (!REVIEW_SIDE_ROLES.includes(role)) {
      throw new Error(`角色 ${role} 不属于审核侧，产品侧不能审批自己的素材`);
    }
    if (!["approve", "reject", "changes"].includes(decision)) throw new Error("审批决定必须是 approve/reject/changes");
    const s = this.submissions.get(submission_id);
    if (!s) throw new Error(`送审单不存在：${submission_id}`);
    if (base_revision !== s.revision) {
      this._append("review.blocked", {
        submission_id, reviewer, role, reason: "stale_revision",
        base_revision, current_revision: s.revision,
      }, { at, actor: reviewer });
      throw new ConcurrencyConflictError(submission_id, base_revision, s.revision);
    }
    this._append("review.recorded", {
      submission_id, reviewer, role, decision, note, revision: s.revision,
    }, { at, actor: reviewer });
    this._rebuild();
    return s;
  }

  issueApproval({ approval_no, submission_id, actor, at, base_revision, scope }) {
    const s = this.submissions.get(submission_id);
    if (!s) throw new Error(`送审单不存在：${submission_id}`);
    if (base_revision !== s.revision) throw new ConcurrencyConflictError(submission_id, base_revision, s.revision);
    if (!this._allRolesApproved(s)) {
      const have = [...new Set(s.reviews.filter((r) => r.revision === s.revision && r.decision === "approve").map((r) => r.role))];
      throw new Error(`批准条件不足，缺少角色批准：${this.requiredReviewRoles.filter((r) => !have.includes(r)).join("、")}`);
    }
    const atv = this._at(at);
    const evaluation = this._evaluate(s.packaging_ref, atv);
    if (evaluation.decision !== "pass") {
      throw new ComplianceBlockedError("批准时点复核未通过，存在受阻或附条件表述", evaluation.results.filter((r) => r.status !== "allowed"));
    }
    const packaging = this.registry.get(...this._splitRef(s.packaging_ref));
    const regRefs = new Set();
    for (const refString of packaging.legal_opinion_refs ?? []) {
      const opinion = this.registry.get(...this._splitRef(refString));
      for (const c of opinion.conclusions ?? []) regRefs.add(c.basis_regulation);
    }
    this._append("approval.issued", {
      approval_no, submission_id, packaging_ref: s.packaging_ref,
      scope: scope ?? { channel_ids: [], audiences: [], regions: [], valid_from: atv, valid_to: null },
      claim_summary: evaluation.results.map((r) => ({ claim_key: r.claim_key, status: r.status })),
      based_on_regulations: [...regRefs],
    }, { at, actor });
    this._rebuild();
    return this.approvals.get(approval_no);
  }

  revokeApproval({ approval_no, reason, actor, at }) {
    const a = this.approvals.get(approval_no);
    if (!a || !a.active) throw new Error(`批准不存在或已撤销：${approval_no}`);
    this._append("approval.revoked", { approval_no, reason }, { at, actor });
    this._rebuild();
  }

  _splitRef(refString) {
    const r = parseRef(refString);
    return [r.kind, r.id, r.version];
  }

  // ---- 投放：批准覆盖、代言范围、旧图回流、跨渠道复用 ----------------------

  launchPlacement({ placement_id, channel_id, channel_page_ref, packaging_ref, audience, approval_no, source = { type: "new" }, actor, at, region }) {
    const atv = this._at(at);
    const findings = [];
    const approval = this.approvals.get(approval_no);
    const block = (message) => {
      this._append("placement.blocked", {
        placement_id, channel_id, channel_page_ref: channel_page_ref ?? null,
        packaging_ref, audience, approval_no, reason: message, attempted_source: source,
      }, { at, actor });
      throw new ComplianceBlockedError(message, findings);
    };
    if (!approval || !approval.active) block(`投放缺少有效批准：${approval_no}`);
    if (approval.packaging_ref !== packaging_ref) {
      block(`批准 ${approval_no} 覆盖 ${approval.packaging_ref}，与投放版本 ${packaging_ref} 不一致（疑似旧图回流）`);
    }
    if (approval.scope.channel_ids.length && !approval.scope.channel_ids.includes(channel_id)) {
      block(`批准范围不含渠道 ${channel_id}，禁止跨渠道超范围投放`);
    }
    if (approval.scope.audiences.length && !approval.scope.audiences.includes(audience)) {
      block(`受众「${audience}」不在批准范围 ${approval.scope.audiences.join("/")}`);
    }
    if (approval.scope.valid_to && atv > approval.scope.valid_to) {
      block(`批准有效期截止 ${approval.scope.valid_to}`);
    }

    const { kind, id, version } = parseRef(packaging_ref);
    const current = this.registry.currentVersion(kind, id);
    const packaging = this.registry.get(kind, id, version);
    const endorsementRefs = packaging.endorsement_refs ?? [];

    // 先落投放事件，再落异常事件，保证"谁在何时投了什么"一定有痕。
    this._append("placement.launched", {
      placement_id, channel_id, channel_page_ref: channel_page_ref ?? null,
      packaging_ref, audience, region: region ?? null,
      approval_no, source, endorsement_refs: endorsementRefs,
    }, { at, actor });
    this._rebuild();

    if (version < current) {
      this._recordIncident({
        kind: "old_image_return",
        placement_id, channel_id,
        detail: `旧图回流：投放 ${packaging_ref}，登记最新版本为 v${current}；须核实是否为库存旧包装还是误把已淘汰素材重新上架`,
        observed_packaging_ref: packaging_ref, current_version: current,
      }, atv);
    }
    if (source.type === "reuse") {
      this._recordIncident({
        kind: "cross_channel_reuse",
        placement_id, channel_id,
        detail: `跨渠道复用：素材由投放 ${source.from_placement_id} 复用到渠道 ${channel_id}，复用范围以 ${approval_no} 记载为准`,
        from_placement_id: source.from_placement_id,
      }, atv);
    }
    for (const refString of endorsementRefs) {
      const r = parseRef(refString);
      const lic = this.registry.get(r.kind, r.id, r.version);
      const miss = [];
      if (lic.status !== "active") miss.push(`代言授权状态为 ${lic.status}`);
      if (lic.period && (atv < lic.period.from || (lic.period.to && atv > lic.period.to))) miss.push("不在代言授权期限内");
      if (lic.channels?.length && !lic.channels.includes(channel_id)) miss.push(`授权渠道不含 ${channel_id}`);
      if (lic.audiences?.length && !lic.audiences.includes(audience)) miss.push(`授权受众不含 ${audience}`);
      if (lic.product_ids?.length && !lic.product_ids.includes(packaging.product_id)) {
        miss.push(`代言覆盖商品 ${lic.product_ids.join("、")}，不含本品 ${packaging.product_id}`);
      }
      if (miss.length) {
        this._recordIncident({
          kind: "endorsement_out_of_scope",
          placement_id, channel_id,
          detail: `${refString} 代言使用超范围：${miss.join("；")}`, endorsement_ref: refString,
        }, atv);
      }
    }
    this._rebuild();
    return this.placements.get(placement_id);
  }

  _recordIncident(payload, at) {
    this._append("compliance.incident", { incident_id: `INC-${(this.incidents.length + 1).toString().padStart(3, "0")}`, ...payload }, { at });
  }

  // 巡检/投诉证据显示素材实际上架了（绕过审签、渠道自行上旧图等）。
  // 不做任何批准判断，只把"消费者确实看到了什么"记入台账，并立即附异常。
  observeUnauthorizedPlacement({ placement_id, channel_id, channel_page_ref, packaging_ref, audience, observed_at, source = { type: "observed" }, evidence = [], actor, at, region }) {
    const atv = this._at(at ?? observed_at);
    this._append("placement.observed", {
      placement_id, channel_id, channel_page_ref: channel_page_ref ?? null,
      packaging_ref, audience, region: region ?? null,
      observed_at, source, evidence,
    }, { at: atv, actor });
    this._rebuild();
    const r = parseRef(packaging_ref);
    const current = this.registry.currentVersion(r.kind, r.id);
    if (r.version < current) {
      this._recordIncident({
        kind: "old_image_return",
        placement_id, channel_id,
        detail: `旧图回流（未批准上架）：现场素材为 ${packaging_ref}，登记最新版本 v${current}`,
        observed_packaging_ref: packaging_ref, current_version: current,
      }, atv);
    }
    this._recordIncident({
      kind: "unauthorized_placement",
      placement_id, channel_id,
      detail: "该投放没有对应有效批准，属绕过审签的实际上架，须以下架与澄清处置",
      observed_packaging_ref: packaging_ref,
    }, atv);
    this._rebuild();
    return this.placements.get(placement_id);
  }

  endPlacement({ placement_id, reason, actor, at }) {
    const pl = this.placements.get(placement_id);
    if (!pl) throw new Error(`投放不存在：${placement_id}`);
    if (pl.ended_at) throw new Error(`投放 ${placement_id} 已结束`);
    this._append("placement.ended", { placement_id, reason }, { at, actor });
    this._rebuild();
  }

  // 下架后澄清：澄清只能针对已经下架的投放，防止"只澄清不下架"。
  issueClarification({ placement_id, channel_id, text, actor, at }) {
    const pl = this.placements.get(placement_id);
    if (!pl) throw new Error(`投放不存在：${placement_id}`);
    if (!pl.ended_at) throw new Error(`投放 ${placement_id} 尚未下架，应先下架再发澄清`);
    const id = `CLR-${(this.clarifications.length + 1).toString().padStart(3, "0")}`;
    this._append("clarification.issued", {
      clarification_id: id, placement_id, channel_id: channel_id ?? pl.channel_id,
      text, after_takedown: pl.end_reason,
    }, { at, actor });
    this._rebuild();
    return this.clarifications.at(-1);
  }

  // ---- 商标 / 法规变化影响扫描 -------------------------------------------

  // 找出在 at 时点仍在投放、且素材引用链触及变更实体的所有对象。
  scanImpactOfChange({ change_ref, reason, actor, at }) {
    const atv = this._at(at);
    const { kind, id } = parseRef(change_ref);
    if (!["trademark", "regulation"].includes(kind)) throw new Error("影响扫描仅支持商标或法规状态变化");
    const affectedPlacements = [];
    const affectedMaterials = new Set();
    const pendingSubmissions = [];

    const packagingTouches = (packagingRef) => {
      const r = parseRef(packagingRef);
      const packaging = this.registry.get(r.kind, r.id, r.version);
      if (kind === "trademark") {
        const t = packaging.trademark_ref ? parseRef(packaging.trademark_ref) : null;
        return t && t.id === id;
      }
      // 法规：沿 包装→法律意见→依据法规 链回溯。
      for (const opRef of packaging.legal_opinion_refs ?? []) {
        const o = this.registry.get(...this._splitRef(opRef));
        for (const c of o.conclusions ?? []) {
          if (c.basis_regulation.startsWith(`regulation/${id}@`)) return true;
        }
      }
      return false;
    };

    for (const pl of this.placements.values()) {
      if (pl.launched_at <= atv && (!pl.ended_at || pl.ended_at > atv) && packagingTouches(pl.packaging_ref)) {
        affectedPlacements.push({
          placement_id: pl.placement_id, channel_id: pl.channel_id, packaging_ref: pl.packaging_ref,
          audience: pl.audience, approval_no: pl.approval_no, launched_at: pl.launched_at,
        });
        affectedMaterials.add(pl.packaging_ref);
      }
    }
    for (const s of this.submissions.values()) {
      if (["pending", "changes_requested", "ready_for_approval"].includes(s.status) && packagingTouches(s.packaging_ref)) {
        pendingSubmissions.push({ submission_id: s.submission_id, packaging_ref: s.packaging_ref, status: s.status });
        affectedMaterials.add(s.packaging_ref);
      }
    }
    // 渠道页面快照当前指向的素材若触及变化，同样要列出（页面可能在投放结束后仍展示旧图）。
    const affectedChannelPages = [];
    for (const ref of this.registry.allRefs("channel_page")) {
      const page = this.registry.get(ref.kind, ref.id, ref.version);
      if (this.registry.isRetired(ref.kind, ref.id, ref.version, { at: atv })) continue;
      if (page.shown_packaging && packagingTouches(page.shown_packaging)) {
        affectedChannelPages.push({ channel_page_ref: `channel_page/${ref.id}@v${ref.version}`, shown_packaging: page.shown_packaging });
        affectedMaterials.add(page.shown_packaging);
      }
    }
    const scanId = `SCAN-${(this.scans.length + 1).toString().padStart(3, "0")}`;
    this._append("impact.scan", {
      scan_id: scanId, change_ref, reason,
      live_placements: affectedPlacements,
      pending_submissions: pendingSubmissions,
      channel_pages: affectedChannelPages,
      affected_materials: [...affectedMaterials],
      action_required: kind === "trademark"
        ? "商标状态已变化，仍在投放的素材须立即停止使用并下架澄清；在途审批冻结"
        : "法规已换版，旧法律意见失效，仍在投放素材须按新规重评后方可继续，在途审批退回重做",
    }, { at, actor });
    this._rebuild();
    return this.scans.at(-1);
  }

  // ---- 投诉登记、关联与时点还原 -------------------------------------------

  registerComplaint({ complaint_id, channel_id, captured_at, captured_packaging_ref = null, description, evidence = [], actor, at }) {
    this._append("complaint.registered", {
      complaint_id, channel_id, captured_at, captured_packaging_ref, description, evidence,
    }, { at, actor });
    this._rebuild();
    return this.complaints.get(complaint_id);
  }

  // 关联投诉与当时投放，并按截图时间还原：发布时间、受众、当时依据、后续处置。
  linkComplaint({ complaint_id, actor, at } = {}) {
    const c = this.complaints.get(complaint_id);
    if (!c) throw new Error(`投诉不存在：${complaint_id}`);
    const captureAt = c.captured_at;

    const candidates = [...this.placements.values()].filter(
      (pl) => pl.channel_id === c.channel_id && pl.launched_at <= captureAt && (!pl.ended_at || pl.ended_at > captureAt)
    );
    let placement = null;
    let packagingRefAtCapture = c.captured_packaging_ref;

    if (c.captured_packaging_ref) {
      const r = parseRef(c.captured_packaging_ref);
      const liveVersion = this.registry.versionAt(r.kind, r.id, captureAt);
      if (liveVersion !== r.version) {
        // 截图里是旧版正面文案：这正是旧图回流/历史投放取证场景。
      }
      placement = candidates.find((pl) => pl.packaging_ref === c.captured_packaging_ref) ?? candidates[0] ?? null;
    } else {
      placement = candidates[0] ?? null;
      if (placement) {
        const r = parseRef(placement.packaging_ref);
        const v = this.registry.versionAt(r.kind, r.id, captureAt) ?? r.version;
        packagingRefAtCapture = `${r.kind}/${r.id}@v${v}`;
      }
    }

    const reconstruction = placement
      ? this.reconstruct({ placement_id: placement.placement_id, at: captureAt })
      : { note: "截图时间该渠道没有在投放的匹配商品，可能为历史截图或私域转发素材" };

    this._append("complaint.linked", {
      complaint_id,
      linked_placement_id: placement?.placement_id ?? null,
      packaging_ref_at_capture: packagingRefAtCapture,
      matched_candidates: candidates.map((pl) => pl.placement_id),
      reconstruction_summary: placement ? {
        launched_at: placement.launched_at,
        audience: placement.audience,
        approval_no: placement.approval_no,
        packaging_ref: packagingRefAtCapture,
      } : null,
    }, { at, actor });
    this._rebuild();
    return { complaint: this.complaints.get(complaint_id), reconstruction };
  }

  handleComplaint({ complaint_id, decision, note, actor, at }) {
    this._append("complaint.handled", { complaint_id, decision, note }, { at, actor });
    this._rebuild();
  }

  // 完整还原某个投放在指定时点的现场与后续处置链。
  reconstruct({ placement_id, at }) {
    const pl = this.placements.get(placement_id);
    if (!pl) throw new Error(`投放不存在：${placement_id}`);
    const r = parseRef(pl.packaging_ref);
    const packaging = this.registry.get(r.kind, r.id, r.version);
    const recipe = this.registry.get(...this._splitRef(packaging.recipe_ref));
    // 包装钉住的配方（消费者看到的宣称依据）与截图时点现行生产配方（真实配料）分开列示。
    const pinnedRecipeRef = parseRef(packaging.recipe_ref);
    const actualRecipeVersion = this.registry.versionAt(pinnedRecipeRef.kind, pinnedRecipeRef.id, at);
    const actualRecipe = actualRecipeVersion
      ? { ref: `${pinnedRecipeRef.kind}/${pinnedRecipeRef.id}@v${actualRecipeVersion}`,
          data: this.registry.get(pinnedRecipeRef.kind, pinnedRecipeRef.id, actualRecipeVersion) }
      : null;
    const approval = this.approvals.get(pl.approval_no);
    const regsInForce = (approval?.based_on_regulations ?? []).map((refString) => {
      const x = parseRef(refString);
      return { ref: refString, in_force_at: this.registry.versionAt(x.kind, x.id, at) === x.version };
    });
    const evaluationAt = (() => {
      const pk = this.registry.get(r.kind, r.id, r.version);
      pk._meta.ref = pl.packaging_ref;
      return evaluateClaims(pk, { registry: this.registry, at });
    })();

    // 沿 投诉.linked 找出与本投放关联的投诉，其登记与处置也属于后续处置链。
    const linkedComplaintIds = this.ledger.events
      .filter((e) => e.type === "complaint.linked" && e.payload.linked_placement_id === placement_id)
      .map((e) => e.payload.complaint_id);

    const later = this.ledger.events
      .filter((e) => e.at >= pl.launched_at)
      .filter((e) => {
        const p = e.payload;
        return (p.placement_id && p.placement_id === placement_id) ||
          p.linked_placement_id === placement_id ||
          (p.complaint_id && linkedComplaintIds.includes(p.complaint_id)) ||
          (p.live_placements ?? []).some((x) => x.placement_id === placement_id) ||
          (e.type === "clarification.issued" && p.placement_id === placement_id);
      })
      .map((e) => ({ at: e.at, type: e.type, payload: e.payload, actor: e.actor }));

    return {
      as_of: at,
      placement: {
        placement_id, channel_id: pl.channel_id, audience: pl.audience, region: pl.region,
        launched_at: pl.launched_at, ended_at: pl.ended_at, end_reason: pl.end_reason, source: pl.source,
      },
      packaging_seen: {
        ref: pl.packaging_ref,
        front_copy: packaging.front_copy,
        claims: packaging.claims,
      },
      recipe_on_packaging: {
        ref: packaging.recipe_ref,
        ingredients: recipe.ingredients,
      },
      recipe_actual_at: actualRecipe && {
        ref: actualRecipe.ref,
        ingredients: actualRecipe.data.ingredients,
        matches_packaging: actualRecipe.ref === packaging.recipe_ref,
      },
      endorsement_refs: pl.endorsement_refs ?? packaging.endorsement_refs ?? [],
      endorsement_status_at: (pl.endorsement_refs ?? packaging.endorsement_refs ?? []).map((refString) => {
        const x = parseRef(refString);
        const licPinned = this.registry.get(x.kind, x.id, x.version);
        const check = (licVersion) => {
          const problems = [];
          if (licVersion.status !== "active") problems.push(`授权状态为 ${licVersion.status}`);
          if (licVersion.period && (at < licVersion.period.from || (licVersion.period.to && at > licVersion.period.to))) problems.push("不在授权期限内");
          if (licVersion.channels?.length && !licVersion.channels.includes(pl.channel_id)) problems.push(`授权渠道不含 ${pl.channel_id}`);
          if (licVersion.audiences?.length && !licVersion.audiences.includes(pl.audience)) problems.push(`授权受众不含 ${pl.audience}`);
          if (licVersion.product_ids?.length && !licVersion.product_ids.includes(packaging.product_id)) problems.push("授权商品不含本品");
          return problems;
        };
        const effectiveVersion = this.registry.versionAt(x.kind, x.id, at);
        const effective = effectiveVersion ? this.registry.get(x.kind, x.id, effectiveVersion) : null;
        return {
          ref: refString, celebrity: licPinned.celebrity,
          covers_pinned: {
            channels: licPinned.channels ?? [], audiences: licPinned.audiences ?? [],
            product_ids: licPinned.product_ids ?? [], period: licPinned.period ?? null,
          },
          pinned_problems_at: check(licPinned),
          effective_version_at: effectiveVersion ? `${x.kind}/${x.id}@v${effectiveVersion}` : null,
          effective_problems_at: effective ? check(effective) : ["截图时点没有生效的代言授权"],
          within_scope_at: effective ? check(effective).length === 0 : false,
        };
      }),
      launch_mode: pl.launch_mode ?? "approved",
      approval_basis: approval ? {
        approval_no: approval.approval_no,
        issued_at: approval.issued_at,
        scope: approval.scope,
        based_on_regulations: regsInForce,
        claim_summary: approval.claim_summary,
      } : null,
      claim_evaluation_at: evaluationAt,
      // 包装所附每份检验资料的批次与适用范围：调查时明确"合格"管的是哪几批、管不到什么。
      test_reports_attached: (packaging.test_report_refs ?? []).map((refString) => {
        const x = parseRef(refString);
        const rep = this.registry.get(x.kind, x.id, x.version);
        return {
          ref: refString,
          conclusion: rep.conclusion,
          batches: rep.batches ?? [],
          tested_items: rep.tested_items ?? [],
          scope_note: rep.scope_note ?? "仅质量指标，不支撑成分含量宣称或功效暗示",
          superseded_at_capture: this.registry.isRetired(x.kind, x.id, x.version, { at }),
        };
      }),
      incidents: pl.incidents,
      subsequent_actions: later,
      ledger_tail_hash: this.ledger.events.at(-1)?.hash ?? null,
      ledger_verified: this.ledger.verify(),
    };
  }

  // 导出取证包：台账事件 + 校验信息。
  exportBundle() {
    return {
      domain: "food-claim-approval",
      exported_at: this.clock(),
      verified: this.ledger.verify(),
      events: this.ledger.events,
    };
  }
}

export function fingerprintBundle(bundle) {
  return createHash("sha256").update(JSON.stringify(bundle.events)).digest("hex");
}
