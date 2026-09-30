// 成分与功效暗示的证据适用范围校验。
// 领域事实：抽检合格只覆盖所检批次与项目，不能用来支撑功效暗示；
// 每条表述都必须附证据，且证据的适用范围要覆盖该表述的类型、
// 商品、渠道与时间。
export function evaluateClaim(claim, registry, context) {
  const { at, productId = null, channel = null } = context;
  const problems = [];
  const evidenceDetail = [];
  const refs = claim.evidence ?? [];

  if (refs.length === 0) {
    problems.push({ code: "evidence_missing", message: "表述未附任何证据" });
  }

  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}#${ref.version}`;
    const version = registry.get(ref.kind, ref.id, ref.version);
    if (!version) {
      problems.push({ code: "evidence_missing", evidence: key, message: "证据未登记" });
      evidenceDetail.push({ ...ref, scope: null });
      continue;
    }
    const scope = version.payload.scope ?? {};
    evidenceDetail.push({ ...ref, scope });
    if (Array.isArray(scope.supports) && !scope.supports.includes(claim.kind)) {
      problems.push({
        code: "kind_not_supported",
        evidence: key,
        message: "证据适用范围不覆盖此类表述（抽检合格不能证明功效）",
      });
    }
    if (scope.validFrom && Date.parse(scope.validFrom) > Date.parse(at)) {
      problems.push({ code: "evidence_not_yet_valid", evidence: key, message: "证据在该时间尚未生效" });
    }
    if (scope.validTo && Date.parse(scope.validTo) < Date.parse(at)) {
      problems.push({ code: "evidence_expired", evidence: key, message: "证据在该时间已失效" });
    }
    if (productId && Array.isArray(scope.products) && !scope.products.includes(productId)) {
      problems.push({ code: "product_out_of_scope", evidence: key, message: "证据不覆盖该商品" });
    }
    if (channel && Array.isArray(scope.channels) && !scope.channels.includes(channel)) {
      problems.push({ code: "channel_out_of_scope", evidence: key, message: "证据不覆盖该渠道" });
    }
  }

  return {
    claim_id: claim.id,
    kind: claim.kind,
    text: claim.text,
    ok: problems.length === 0,
    problems,
    evidence: evidenceDetail,
  };
}
