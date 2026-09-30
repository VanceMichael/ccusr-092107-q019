// 表述—证据适用范围评估。
// 对包装正面文案中的每一条成分暗示、功效暗示、风味/名称暗示逐条核对证据，
// 并显式写出每份证据"能证明什么、管到哪个范围"。
// 关键领域规则：抽检合格仅覆盖抽样批次的质量指标，不能支撑任何功效暗示。

export const CLAIM_KINDS = Object.freeze({
  INGREDIENT: "ingredient",       // 成分暗示，如"人参配方""含枸杞"
  FUNCTION: "function",           // 功效暗示，如"提神抗疲劳""增强免疫力"
  FLAVOR: "flavor",               // 风味描述，如"柠檬味"
  NAME_LIKENESS: "name_likeness", // 名称近似药品/医用暗示
  ORDINARY: "ordinary"            // 无暗示的普通描述
});

const STATUS = Object.freeze({ ALLOWED: "allowed", CONDITIONAL: "conditional", BLOCKED: "blocked" });

function resolve(registry, refString, at) {
  const { kind, id, version } = parse(refString);
  return registry.get(kind, id, version);
}

function parse(text) {
  const match = /^([a-z_]+)\/([^@]+)@v(\d+)$/.exec(text);
  if (!match) throw new Error(`无法解析实体引用：${text}`);
  return { kind: match[1], id: match[2], version: Number(match[3]) };
}

// 按 at 时点收集仍有效的检验资料；每份报告都带批次限定的适用范围。
function applicableReports(reportRefs, registry, at) {
  return reportRefs.map((refString) => {
    const ref = parse(refString);
    const report = registry.get(ref.kind, ref.id, ref.version);
    const retired = registry.isRetired(ref.kind, ref.id, ref.version, { at });
    return { ref: refString, report, retired };
  });
}

function findOpinion(opinionRefs, registry, claim, packagingRef) {
  for (const refString of opinionRefs) {
    const ref = parse(refString);
    const opinion = registry.get(ref.kind, ref.id, ref.version);
    const hit = (opinion.conclusions ?? []).find(
      (c) => c.claim_key === claim.key || c.claim_text === claim.text
    );
    if (!hit) continue;
    const scopeCoversPackaging =
      !hit.scope?.packaging || hit.scope.packaging.length === 0 || hit.scope.packaging.includes(packagingRef);
    return { ref: refString, opinion, conclusion: hit, scopeCoversPackaging };
  }
  return null;
}

function evaluateIngredient(claim, recipe, recipeRef, reports) {
  const supportedBy = [];
  const gaps = [];
  const ing = (recipe.ingredients ?? []).find((i) => i.name === claim.ingredient);
  if (!ing) {
    return {
      status: STATUS.BLOCKED,
      supported_by: [],
      not_applicable: [],
      gaps: [`配方 ${recipeRef} 中不含「${claim.ingredient}」，该成分暗示没有配方依据`],
    };
  }
  supportedBy.push({
    ref: recipeRef,
    scope: `仅证明「${recipe.name}」配方版本含该成分，适用于按此配方生产的批次；实际含量以投料与成品检验为准`,
  });
  if (claim.require_min_per_100g != null) {
    const amount = ing.per_100g ?? ing.amount_per_100g;
    if (amount == null || amount < claim.require_min_per_100g) {
      gaps.push(
        `配方标注「${claim.ingredient}」每100克含量 ${amount ?? "未标注"}${ing.unit ?? ""}，低于暗示所需的 ${claim.require_min_per_100g}${ing.unit ?? ""}`
      );
    }
  }
  // 成分检验报告只能补强对应批次，不能替代配方依据。
  for (const { ref, report, retired } of reports) {
    const tested = (report.tested_items ?? []).includes(claim.ingredient);
    if (!tested) continue;
    supportedBy.push({
      ref,
      scope: `仅适用于报告所列批次 ${(report.batches ?? []).join("、")} 的成分检验结果${retired ? "（资料已被新版替代）" : ""}，不及于其他批次`,
    });
  }
  return {
    status: gaps.length ? STATUS.CONDITIONAL : STATUS.ALLOWED,
    supported_by: supportedBy,
    not_applicable: [],
    gaps,
  };
}

function evaluateFunction(claim, ctx) {
  const { category, reports, opinionHit, registry, at } = ctx;
  const supportedBy = [];
  const notApplicable = [];
  const gaps = [];

  // 质量类抽检报告对功效宣称一律不适用，必须在结论中写明。
  for (const { ref, report, retired } of reports) {
    notApplicable.push({
      ref,
      reason: `属于${report.kind_label ?? "质量抽检"}，结论「${report.conclusion}」仅覆盖抽样批次 ${(report.batches ?? []).join("、")} 的质量指标，不能证明任何功效`,
      retired,
    });
  }

  if (!opinionHit) {
    gaps.push(
      category.ordinary_food
        ? "普通食品不得作疾病预防/治疗或保健功效暗示，且没有任何法律意见允许该表述"
        : "缺少允许该功效暗示的法律意见"
    );
    return { status: STATUS.BLOCKED, supported_by: supportedBy, not_applicable: notApplicable, gaps };
  }

  const { ref: opinionRef, conclusion, scopeCoversPackaging } = opinionHit;
  if (conclusion.decision === "prohibited") {
    gaps.push(`法律意见 ${opinionRef} 明确禁止该表述：${conclusion.reason ?? ""}`);
    return { status: STATUS.BLOCKED, supported_by: supportedBy, not_applicable: notApplicable, gaps };
  }

  // 法律意见依据的法规版本必须仍是现行版本。
  const basis = parse(conclusion.basis_regulation);
  const regCurrent = registry.currentVersion(basis.kind, basis.id);
  const regInForce = registry.versionAt(basis.kind, basis.id, at);
  if (regInForce !== basis.version) {
    gaps.push(
      `法律意见依据的 ${conclusion.basis_regulation} 在 ${at} 已非现行版本（现行 v${regCurrent}），旧意见不能单独支撑投放，需按新法规重新出具`
    );
  } else {
    supportedBy.push({
      ref: opinionRef,
      scope: `仅在 ${conclusion.basis_regulation} 有效期间、且满足前置条件时适用于该表述；不及于其他表述或其他商品类别`,
    });
  }

  if (!scopeCoversPackaging) {
    gaps.push(`法律意见的适用范围未覆盖当前包装版本`);
  }
  const required = conclusion.required_markings ?? [];
  const shown = ctx.packaging.markings ?? claim.markings_shown ?? [];
  const missingMarkings = required.filter((m) => !shown.includes(m));
  // 标注尚未满足属于"附条件"（补齐即可）；只有法规失效/范围不覆盖才阻断。
  if (conclusion.decision === "permitted_with_conditions" || conclusion.preconditions?.length || required.length) {
    const outstanding = [...(conclusion.preconditions ?? []), ...missingMarkings];
    return {
      status: gaps.length ? STATUS.BLOCKED : outstanding.length ? STATUS.CONDITIONAL : STATUS.ALLOWED,
      supported_by: supportedBy,
      not_applicable: notApplicable,
      gaps,
      preconditions: outstanding,
    };
  }
  return {
    status: gaps.length ? STATUS.BLOCKED : STATUS.ALLOWED,
    supported_by: supportedBy,
    not_applicable: notApplicable,
    gaps,
  };
}

function evaluateFlavor(claim, recipe, recipeRef) {
  const pool = [...(recipe.ingredients ?? []).map((i) => i.name), ...(recipe.flavorings ?? [])];
  if (!pool.includes(claim.flavor_of)) {
    return {
      status: STATUS.BLOCKED,
      supported_by: [],
      not_applicable: [],
      gaps: [`配方 ${recipeRef} 中找不到「${claim.flavor_of}」相关原料或香精，风味描述无依据，且不得借风味暗示保健作用`],
    };
  }
  return {
    status: STATUS.ALLOWED,
    supported_by: [
      { ref: recipeRef, scope: `仅证明该配方版本使用了「${claim.flavor_of}」相关原料/香精，风味表述不得延伸为功效暗示` },
    ],
    not_applicable: [],
    gaps: [],
  };
}

function evaluateNameLikeness(claim, ctx) {
  const { trademark, trademarkRef, opinionHit, registry, at, packaging } = ctx;
  const gaps = [];
  const supportedBy = [];
  if (trademark.status === "invalid" || trademark.status === "expired") {
    gaps.push(`包装使用的商标 ${trademarkRef} 当前状态为「${trademark.status_label ?? trademark.status}」，不得继续投放`);
    return { status: STATUS.BLOCKED, supported_by: [], not_applicable: [], gaps };
  }
  if (!opinionHit || opinionHit.conclusion.decision === "prohibited") {
    gaps.push("名称与药品近似但缺少允许使用的法律意见，存在误导为药品的风险");
    return { status: STATUS.BLOCKED, supported_by: [], not_applicable: [], gaps };
  }
  const basis = parse(opinionHit.conclusion.basis_regulation);
  if (registry.versionAt(basis.kind, basis.id, at) !== basis.version) {
    gaps.push(
      `名称近似结论依据的 ${opinionHit.conclusion.basis_regulation} 在 ${at} 已换版，须按现行法规重新出具意见`
    );
    return { status: STATUS.BLOCKED, supported_by: [], not_applicable: [], gaps };
  }
  const required = opinionHit.conclusion.required_markings ?? [];
  const shown = packaging.markings ?? claim.markings_shown ?? [];
  const missing = required.filter((m) => !shown.includes(m));
  supportedBy.push({
    ref: opinionHit.ref,
    scope: `仅适用于当前包装版本与普通食品类别；要求 ${(opinionHit.conclusion.preconditions ?? required).join("、") || "不得标注适应症或疗效"}`,
  });
  if (missing.length) {
    return {
      status: STATUS.CONDITIONAL,
      supported_by: supportedBy,
      not_applicable: [],
      gaps: [`法律意见要求的标注未在包装正面出现：${missing.join("、")}`],
      preconditions: opinionHit.conclusion.preconditions ?? required,
    };
  }
  return {
    status: STATUS.ALLOWED,
    supported_by: supportedBy,
    not_applicable: [],
    gaps: [],
  };
}

// 评估一份包装在 at 时点的全部表述。claims 为包装逐字稿中的表述清单。
export function evaluateClaims(packaging, { registry, at }) {
  const packagingRef = packaging._meta.ref;
  const recipeRef = packaging.recipe_ref;
  const recipe = resolve(registry, recipeRef, at);
  const category = resolve(registry, packaging.category_ref, at);
  const reports = applicableReports(packaging.test_report_refs ?? [], registry, at);
  const trademark = packaging.trademark_ref ? resolve(registry, packaging.trademark_ref, at) : null;

  // 包装钉住的依据版本若在 at 时点已停用，说明正面文案与真实生产状态脱节，
  // 必须作为阻断项写出（投诉取证时回答"消费者看到时真实配料是什么"）。
  const stale_basis = [];
  const recipeRefp = parse(recipeRef);
  if (registry.isRetired(recipeRefp.kind, recipeRefp.id, recipeRefp.version, { at })) {
    stale_basis.push({
      ref: recipeRef,
      current_version: registry.currentVersion(recipeRefp.kind, recipeRefp.id),
      reason: `该包装依据的配方版本在 ${at} 已被新版替代，正面文案不能再按旧配方宣称，应以现行生产配方重新核对`,
    });
  }

  const results = (packaging.claims ?? []).map((claim) => {
    const opinionHit = findOpinion(packaging.legal_opinion_refs ?? [], registry, claim, packagingRef);
    let r;
    switch (claim.kind) {
      case CLAIM_KINDS.INGREDIENT:
        r = evaluateIngredient(claim, recipe, recipeRef, reports);
        break;
      case CLAIM_KINDS.FUNCTION:
        r = evaluateFunction(claim, { category, reports, opinionHit, registry, at, packaging });
        break;
      case CLAIM_KINDS.FLAVOR:
        r = evaluateFlavor(claim, recipe, recipeRef);
        break;
      case CLAIM_KINDS.NAME_LIKENESS:
        r = evaluateNameLikeness(claim, { trademark, trademarkRef: packaging.trademark_ref, opinionHit, packaging, registry, at });
        break;
      default:
        r = { status: STATUS.ALLOWED, supported_by: [], not_applicable: [], gaps: [] };
    }
    return { claim_key: claim.key, text: claim.text, kind: claim.kind, ...r };
  });

  const blocked = results.filter((r) => r.status === STATUS.BLOCKED);
  const conditional = results.filter((r) => r.status === STATUS.CONDITIONAL);
  const decision = blocked.length || stale_basis.length
    ? "reject"
    : conditional.length
      ? "conditions_required"
      : "pass";
  return { at, packaging_ref: packagingRef, decision, basis_notes: stale_basis, results };
}
