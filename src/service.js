// 普通食品营销审签服务。
// 覆盖：送审、审签（依据快照、并发冲突与依据过期留痕）、投放
// （旧图回流、跨渠道复用、证据越界识别）、法规或商标变化的影响标记、
// 下架澄清、投诉关联与事后还原。
import { evaluateClaim } from "./claims.js";

const IMPACT_REASONS = ["regulation_change", "trademark_status_change"];

export function createReviewService({ registry, audit, policy, products = [] }) {
  const submissions = [];
  const decisions = [];
  const publications = [];
  const complaints = [];
  const clarifications = [];
  let submissionSeq = 0;
  let decisionSeq = 0;
  let publicationSeq = 0;
  let complaintSeq = 0;
  let clarificationSeq = 0;

  const basisKey = (kind, id) => `${kind}:${id}`;
  const sameSubject = (a, b) => a.kind === b.kind && a.id === b.id && a.version === b.version;
  const findProduct = (productId) => products.find((item) => item.id === productId) ?? null;

  function mustFindPublication(id) {
    const publication = publications.find((item) => item.id === id);
    if (!publication) throw new Error(`未知投放: ${id}`);
    return publication;
  }

  // 汇总某素材版本在指定时间点的全部依据版本（“当时依据”快照）。
  function collectBasis(subject, at) {
    const basis = {};
    const put = (kind, id, version) => {
      basis[basisKey(kind, id)] = { kind, id, version };
    };
    const subjectVersion = registry.get(subject.kind, subject.id, subject.version);
    if (!subjectVersion) {
      throw new Error(`未登记的素材版本: ${subject.kind}/${subject.id}#${subject.version}`);
    }
    put(subject.kind, subject.id, subject.version);
    const payload = subjectVersion.payload;
    let packPayload = null;
    let productId = payload.product_id ?? null;
    if (subject.kind === "channel_page") {
      put("packaging", payload.packaging.id, payload.packaging.version);
      packPayload = registry.get("packaging", payload.packaging.id, payload.packaging.version)?.payload ?? null;
      if (payload.endorsement) put("endorsement", payload.endorsement.id, payload.endorsement.version);
    }
    if (subject.kind === "packaging") packPayload = payload;
    if (packPayload) {
      if (packPayload.formula) put("formula", packPayload.formula.id, packPayload.formula.version);
      productId ??= packPayload.product_id ?? null;
      for (const claim of packPayload.claims ?? []) {
        for (const ref of claim.evidence ?? []) put(ref.kind, ref.id, ref.version);
      }
    }
    const product = productId ? findProduct(productId) : null;
    if (product) {
      const category = registry.current("category", product.category, at);
      if (category) put("category", category.id, category.version);
      const trademark = registry.current("trademark", product.trademark, at);
      if (trademark) put("trademark", trademark.id, trademark.version);
    }
    return basis;
  }

  // 汇总素材版本上的全部成分/功效暗示（渠道页带上包装表述与代言出现）。
  function claimsOf(subjectVersion) {
    const payload = subjectVersion.payload;
    if (subjectVersion.kind === "packaging") {
      return { claims: payload.claims ?? [], productId: payload.product_id ?? null };
    }
    if (subjectVersion.kind === "channel_page") {
      const pack = registry.get("packaging", payload.packaging.id, payload.packaging.version);
      const claims = [...(pack?.payload?.claims ?? []), ...(payload.extra_claims ?? [])];
      if (payload.endorsement) {
        claims.push({
          id: `endorsement:${payload.endorsement.id}`,
          kind: "endorsement_presence",
          text: "页面出现代言形象",
          evidence: [{ kind: "endorsement", id: payload.endorsement.id, version: payload.endorsement.version }],
        });
      }
      return { claims, productId: payload.product_id ?? pack?.payload?.product_id ?? null };
    }
    return { claims: [], productId: payload.product_id ?? null };
  }

  function evaluateSubjectClaims(subjectVersion, at, channel = null) {
    const { claims, productId } = claimsOf(subjectVersion);
    return claims.map((claim) => evaluateClaim(claim, registry, { at, productId, channel }));
  }

  // 登记资料新版本；法规或商标状态变化时自动标出仍在投放的受影响素材。
  function registerEntityVersion({ kind, id, payload, validFrom, actor, changeReason = null, version = null }) {
    const next = version ?? (registry.current(kind, id)?.version ?? 0) + 1;
    const record = registry.registerVersion({ kind, id, version: next, payload, validFrom, actor, changeReason });
    const affected = changeReason && IMPACT_REASONS.includes(changeReason) ? impactScan(kind, id, validFrom) : [];
    return { record, affected };
  }

  function submit({ subject, intendedChannels, actor, at }) {
    const submission = {
      id: `sub-${String(++submissionSeq).padStart(4, "0")}`,
      subject,
      intendedChannels: intendedChannels ?? [],
      actor,
      at,
    };
    submissions.push(submission);
    audit.record("material_submitted", at, actor, {
      submission_id: submission.id,
      subject,
      intended_channels: submission.intendedChannels,
    });
    return submission;
  }

  function decide({ subject, role, decision, actor, at, basisAt = null, rationale = "" }) {
    const allowed = policy.required_roles?.[subject.kind] ?? [];
    if (!allowed.includes(role)) {
      throw new Error(`角色 ${role} 无权审签 ${subject.kind}`);
    }
    const subjectVersion = registry.get(subject.kind, subject.id, subject.version);
    if (!subjectVersion) {
      throw new Error(`未登记的素材版本: ${subject.kind}/${subject.id}#${subject.version}`);
    }
    const basisTime = basisAt ?? at;
    const basis = collectBasis(subject, basisTime);
    const claimResults = evaluateSubjectClaims(subjectVersion, basisTime);

    // 评审期间依据是否已变化（如商标状态、法规意见更新）
    const staleBasis = [];
    if (basisAt && Date.parse(basisAt) < Date.parse(at)) {
      const nowBasis = collectBasis(subject, at);
      for (const [key, entry] of Object.entries(basis)) {
        if (nowBasis[key]?.version !== entry.version) staleBasis.push(key);
      }
    }

    const record = {
      id: `dec-${String(++decisionSeq).padStart(4, "0")}`,
      subject,
      role,
      decision,
      actor,
      at,
      basisAt: basisTime,
      basis,
      claimResults,
      staleBasis,
      conflict: false,
      rationale,
    };
    decisions.push(record);
    audit.record("approval_decided", at, actor, {
      decision_id: record.id,
      subject,
      role,
      decision,
      basis,
      stale_basis: staleBasis,
    });
    if (staleBasis.length > 0) {
      audit.record("approval_basis_stale", at, actor, { decision_id: record.id, stale_basis: staleBasis });
    }

    // 并发审批：评审窗口重叠且结论或依据不一致时留痕
    for (const other of decisions) {
      if (other.id === record.id || !sameSubject(other.subject, subject)) continue;
      const overlapping =
        Date.parse(other.basisAt) <= Date.parse(at) && Date.parse(basisTime) <= Date.parse(other.at);
      const basisDiffers = JSON.stringify(other.basis) !== JSON.stringify(basis);
      if (overlapping && (other.decision !== decision || basisDiffers)) {
        other.conflict = true;
        record.conflict = true;
        audit.record("concurrent_approval_conflict", at, actor, {
          subject,
          decisions: [other.id, record.id],
          outcomes: [other.decision, decision],
          basis_differs: basisDiffers,
          overlapping_windows: true,
        });
      }
    }
    return record;
  }

  function approvalStatus(subject) {
    const required = policy.required_roles?.[subject.kind] ?? [];
    const latestByRole = new Map();
    for (const item of decisions) {
      if (sameSubject(item.subject, subject)) latestByRole.set(item.role, item);
    }
    const latest = [...latestByRole.values()];
    const rejected = latest.filter((item) => item.decision === "rejected");
    const missing = required.filter((role) => !latestByRole.has(role));
    return {
      approved: missing.length === 0 && rejected.length === 0 && latest.length > 0,
      missing_roles: missing,
      rejected_by: rejected.map((item) => item.role),
      decisions: latest,
      has_conflict: latest.some((item) => item.conflict),
    };
  }

  function publish({ subject, channel, audience, actor, at }) {
    const status = approvalStatus(subject);
    if (!status.approved) {
      throw new Error(`素材未完成审签，不得投放: ${subject.kind}/${subject.id}#${subject.version}`);
    }
    const id = `pub-${String(++publicationSeq).padStart(4, "0")}`;
    const flags = [];
    const subjectVersion = registry.get(subject.kind, subject.id, subject.version);

    // 旧图回流：渠道页面钉住的包装版本已不是当前版本
    if (subject.kind === "channel_page") {
      const packRef = subjectVersion.payload.packaging;
      const currentPack = registry.current("packaging", packRef.id, at);
      if (currentPack && currentPack.version !== packRef.version) {
        flags.push("old_image_resurfaced");
        audit.record("old_image_resurfaced", at, actor, {
          publication_id: id,
          subject,
          channel,
          pinned_packaging_version: packRef.version,
          current_packaging_version: currentPack.version,
        });
      }
    }

    // 跨渠道复用：投放渠道超出送审时的意向渠道
    const submission = submissions.filter((item) => sameSubject(item.subject, subject)).at(-1);
    if (submission && submission.intendedChannels.length > 0 && !submission.intendedChannels.includes(channel)) {
      flags.push("cross_channel_reuse");
      audit.record("cross_channel_reuse", at, actor, {
        publication_id: id,
        subject,
        channel,
        intended_channels: submission.intendedChannels,
      });
    }

    // 投放时点的表述证据仍须在适用范围内（含代言范围）
    const claimResults = evaluateSubjectClaims(subjectVersion, at, channel);
    const invalidClaims = claimResults.filter((item) => !item.ok);
    if (invalidClaims.length > 0) {
      flags.push("claim_evidence_invalid");
      audit.record("claim_evidence_invalid", at, actor, {
        publication_id: id,
        subject,
        channel,
        claims: invalidClaims.map((item) => ({ claim_id: item.claim_id, problems: item.problems })),
      });
    }

    // 当时依据：取各角色最近一次审签决定的依据快照合并
    const basis = {};
    for (const item of status.decisions) Object.assign(basis, item.basis);

    const publication = {
      id,
      subject,
      channel,
      audience,
      actor,
      publishedAt: at,
      status: "live",
      flags,
      basis,
      claimResults,
      impactFlags: [],
      takedown: null,
    };
    publications.push(publication);
    audit.record("publication_started", at, actor, {
      publication_id: id,
      subject,
      channel,
      audience,
      flags,
    });
    return publication;
  }

  // 法规或商标状态变化：标出仍在投放且依据停留在旧版本的素材。
  function impactScan(kind, id, at) {
    const currentVersion = registry.current(kind, id)?.version;
    const affected = [];
    for (const publication of publications) {
      if (publication.status !== "live") continue;
      const entry = publication.basis[basisKey(kind, id)];
      if (!entry || entry.version === currentVersion) continue;
      if (!publication.flags.includes("affected_by_change")) publication.flags.push("affected_by_change");
      publication.impactFlags.push({ kind, id, basis_version: entry.version, current_version: currentVersion, at });
      audit.record("affected_material_flagged", at, "system", {
        publication_id: publication.id,
        kind,
        id,
        basis_version: entry.version,
        current_version: currentVersion,
      });
      affected.push(publication);
    }
    return affected;
  }

  function takedown(publicationId, { at, actor, reason }) {
    const publication = mustFindPublication(publicationId);
    if (publication.status !== "live") throw new Error(`投放已不在线: ${publicationId}`);
    publication.status = "taken_down";
    publication.takedown = { at, actor, reason };
    audit.record("publication_taken_down", at, actor, { publication_id: publicationId, reason });
    return publication;
  }

  function clarify({ publicationId = null, complaintId = null, text, channels = [], at, actor }) {
    // 针对投诉的澄清同时关联到对应投放，保证事后还原完整
    if (complaintId && !publicationId) {
      publicationId = complaints.find((item) => item.id === complaintId)?.publicationId ?? null;
    }
    const clarification = {
      id: `clr-${String(++clarificationSeq).padStart(4, "0")}`,
      publicationId,
      complaintId,
      text,
      channels,
      at,
      actor,
    };
    clarifications.push(clarification);
    if (complaintId) {
      const complaint = complaints.find((item) => item.id === complaintId);
      if (complaint) complaint.status = "clarified";
    }
    audit.record("clarification_issued", at, actor, {
      clarification_id: clarification.id,
      publication_id: publicationId,
      complaint_id: complaintId,
      channels,
    });
    return clarification;
  }

  // 投诉关联：按渠道与看到素材的时间，定位消费者实际看到的投放版本。
  function fileComplaint({ channel, observedAt, receivedAt, description, reporter = "consumer" }) {
    const seen = Date.parse(observedAt);
    const candidates = publications
      .filter((item) => item.channel === channel)
      .filter((item) => Date.parse(item.publishedAt) <= seen)
      .filter((item) => !item.takedown || Date.parse(item.takedown.at) > seen)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    if (candidates.length === 0) {
      throw new Error(`渠道 ${channel} 在 ${observedAt} 无投放记录，无法关联投诉`);
    }
    const complaint = {
      id: `cmp-${String(++complaintSeq).padStart(4, "0")}`,
      channel,
      observedAt,
      receivedAt,
      description,
      reporter,
      publicationId: candidates[0].id,
      status: "open",
    };
    complaints.push(complaint);
    audit.record("complaint_filed", receivedAt, reporter, {
      complaint_id: complaint.id,
      publication_id: complaint.publicationId,
      channel,
      observed_at: observedAt,
    });
    return complaint;
  }

  function resolveBasis(basis) {
    const resolved = {};
    for (const [key, entry] of Object.entries(basis)) {
      const record = registry.get(entry.kind, entry.id, entry.version);
      resolved[key] = record
        ? { kind: entry.kind, id: entry.id, version: entry.version, validFrom: record.validFrom, payload: record.payload }
        : entry;
    }
    return resolved;
  }

  // 投诉调查视图：消费者看到的是哪一版正面文案、真实配料、代言覆盖哪些商品，
  // 以及每条表述的证据适用范围——抽检合格报告不能单独终结调查。
  function complaintContext(complaintId) {
    const complaint = complaints.find((item) => item.id === complaintId);
    if (!complaint) throw new Error(`未知投诉: ${complaintId}`);
    const publication = mustFindPublication(complaint.publicationId);
    const subjectVersion = registry.get(
      publication.subject.kind,
      publication.subject.id,
      publication.subject.version,
    );
    const packRef =
      publication.subject.kind === "packaging"
        ? { id: subjectVersion.id, version: subjectVersion.version }
        : subjectVersion.payload.packaging;
    const pack = registry.get("packaging", packRef.id, packRef.version);
    const formula = registry.get("formula", pack.payload.formula.id, pack.payload.formula.version);
    const currentFormula = registry.current("formula", pack.payload.formula.id, complaint.observedAt);
    const endorsementRef = publication.subject.kind === "channel_page" ? subjectVersion.payload.endorsement : null;
    const endorsement = endorsementRef
      ? registry.get("endorsement", endorsementRef.id, endorsementRef.version)
      : null;
    return {
      complaint_id: complaint.id,
      channel: complaint.channel,
      observed_at: complaint.observedAt,
      publication_id: publication.id,
      front_copy: {
        packaging_id: packRef.id,
        version: packRef.version,
        text: pack.payload.front_copy,
        latest_version: registry.current("packaging", packRef.id)?.version ?? null,
      },
      ingredients: {
        as_shown: { formula_id: formula.id, version: formula.version, list: formula.payload.ingredients },
        current_at_observation: currentFormula
          ? { version: currentFormula.version, list: currentFormula.payload.ingredients }
          : null,
      },
      endorsement_scope: endorsement
        ? { version: endorsement.version, celebrity: endorsement.payload.celebrity, ...endorsement.payload.scope }
        : null,
      claims: evaluateSubjectClaims(subjectVersion, complaint.observedAt, complaint.channel),
      note: "抽检合格仅覆盖所检批次与项目，营销表述是否合法须对照每条证据的适用范围",
    };
  }

  // 事后还原：发布时间、受众、当时依据、后续处置。
  function reconstruct(publicationId) {
    const publication = mustFindPublication(publicationId);
    const started = audit.list({ publicationId, type: "publication_started" })[0];
    const subsequentEvents = audit
      .list({ publicationId })
      .filter((event) => event.seq > (started?.seq ?? 0));
    return {
      publication_id: publication.id,
      channel: publication.channel,
      status: publication.status,
      flags: publication.flags,
      published_at: publication.publishedAt,
      audience: publication.audience,
      basis: resolveBasis(publication.basis),
      claims: publication.claimResults,
      subsequent: {
        takedown: publication.takedown,
        clarifications: clarifications.filter((item) => item.publicationId === publicationId),
        complaints: complaints.filter((item) => item.publicationId === publicationId),
        events: subsequentEvents,
      },
    };
  }

  return {
    registerEntityVersion,
    submit,
    decide,
    approvalStatus,
    publish,
    impactScan,
    takedown,
    clarify,
    fileComplaint,
    complaintContext,
    reconstruct,
    listPublications: () => publications,
    auditTrail: (filter) => audit.list(filter),
  };
}
