// 版本化领域资料登记处。
// 商品类别、配方、商标状态、包装、渠道页面、代言范围、检验资料、法律意见
// 都按版本登记：新版本生效时旧版本自动截止，但历史版本保留可查，
// 以便事后还原任一投放“当时依据”的是哪一版资料。
export const ENTITY_KINDS = [
  "category",
  "formula",
  "trademark",
  "packaging",
  "channel_page",
  "endorsement",
  "inspection",
  "legal_opinion",
];

export function createRegistry(audit) {
  const store = new Map();

  function versionsOf(kind, id) {
    if (!ENTITY_KINDS.includes(kind)) throw new Error(`未知资料类别: ${kind}`);
    if (!store.has(kind)) store.set(kind, new Map());
    const byId = store.get(kind);
    if (!byId.has(id)) byId.set(id, []);
    return byId.get(id);
  }

  function registerVersion({ kind, id, version, payload, validFrom, actor, changeReason = null }) {
    const versions = versionsOf(kind, id);
    const expected = versions.length + 1;
    if (version !== expected) {
      throw new Error(`版本必须连续: ${kind}/${id} 期望 v${expected}，收到 v${version}`);
    }
    const prev = versions[versions.length - 1];
    if (prev) {
      if (Date.parse(validFrom) <= Date.parse(prev.validFrom)) {
        throw new Error(`新版本生效时间必须晚于上一版本: ${kind}/${id}#v${version}`);
      }
      prev.validTo = validFrom;
      prev.status = "superseded";
    }
    const record = { kind, id, version, payload, validFrom, validTo: null, status: "active", changeReason };
    versions.push(record);
    audit.record("entity_version_registered", validFrom, actor, { kind, id, version, changeReason });
    return record;
  }

  function get(kind, id, version) {
    return versionsOf(kind, id).find((item) => item.version === version) ?? null;
  }

  function current(kind, id, at = null) {
    const versions = versionsOf(kind, id);
    if (versions.length === 0) return null;
    if (!at) return versions[versions.length - 1];
    const t = Date.parse(at);
    return (
      versions.find((item) => Date.parse(item.validFrom) <= t && (!item.validTo || Date.parse(item.validTo) > t)) ??
      null
    );
  }

  return { registerVersion, get, current };
}
