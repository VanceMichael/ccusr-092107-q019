// 版本化实体登记：对台账事件做投影，记录每个实体各版本的生效与失效时间。
// 调查投诉时可按截图时间取回"当时生效"的版本，而不是只看当前版本。
export const ENTITY_KINDS = Object.freeze([
  "category",      // 商品类别（普通食品/保健食品…）
  "recipe",        // 配方（成分及含量逐版记录）
  "trademark",     // 商标状态（注册/无效/到期）
  "packaging",     // 包装正面文案与表述逐字稿
  "channel_page",  // 渠道页面快照（投放配置与受众）
  "endorsement",   // 明星代言授权范围
  "test_report",   // 检验资料（抽检合格仅证明质量指标）
  "legal_opinion", // 法律意见（表述能否使用及前提）
  "regulation",    // 法规版本与禁止性规定
]);

export class Registry {
  constructor(ledger) {
    this.ledger = ledger;
    this._rebuild();
  }

  _rebuild() {
    this.index = new Map(); // kind -> id -> { current, versions: Map }
    for (const e of this.ledger.events) this._apply(e);
  }

  _bucket(kind, id) {
    let byKind = this.index.get(kind);
    if (!byKind) this.index.set(kind, (byKind = new Map()));
    let entity = byKind.get(id);
    if (!entity) byKind.set(id, (entity = { current: 0, versions: new Map() }));
    return entity;
  }

  _apply(event) {
    const p = event.payload;
    if (event.type === "entity.registered") {
      const { kind, id, version, data } = p;
      const entity = this._bucket(kind, id);
      if (entity.versions.has(version)) {
        throw new Error(`${kind}/${id}@v${version} 重复登记`);
      }
      if (version !== entity.current + 1) {
        throw new Error(`${kind}/${id} 版本必须连续递增，收到 v${version}，当前 v${entity.current}`);
      }
      entity.versions.set(version, { data, registered_at: event.at, retired_at: null });
      entity.current = version;
    } else if (event.type === "entity.superseded") {
      const { kind, id, version, by } = p;
      const entity = this._bucket(kind, id);
      const v = entity.versions.get(version);
      if (!v) throw new Error(`失效版本不存在：${kind}/${id}@v${version}`);
      if (v.retired_at) throw new Error(`${kind}/${id}@v${version} 已失效`);
      v.retired_at = event.at;
      // current 只由随后的 registered 事件推进，by 仅记录接续版本。
    }
  }

  register(kind, id, data, { at, actor } = {}) {
    if (!ENTITY_KINDS.includes(kind)) throw new Error(`未知实体类别：${kind}`);
    const entity = this._bucket(kind, id);
    if (entity.current > 0) {
      throw new Error(`${kind}/${id} 已登记到 v${entity.current}；新版本必须显式发布并使旧版失效，不能覆盖注册`);
    }
    return this._appendRegister(kind, id, data, { at, actor });
  }

  _appendRegister(kind, id, data, { at, actor }) {
    const entity = this._bucket(kind, id);
    const version = entity.current + 1;
    this.ledger.append(
      "entity.registered",
      { kind, id, version, data },
      { at, actor }
    );
    this._rebuild();
    return { kind, id, version };
  }

  // 发布新版本；旧版本自 at 起失效。byVersion 省略时由新版本接续。
  publishNewVersion(kind, id, data, { at, actor, retiredAt } = {}) {
    if (!ENTITY_KINDS.includes(kind)) throw new Error(`未知实体类别：${kind}`);
    const entity = this._bucket(kind, id);
    const byVersion = entity.current + 1;
    if (entity.current > 0) {
      this.ledger.append(
        "entity.superseded",
        { kind, id, version: entity.current, by: byVersion },
        { at: retiredAt ?? at, actor }
      );
    }
    return this._appendRegister(kind, id, data, { at, actor });
  }

  // 外部状态变化（商标被无效、法规换版）：登记新版本并让旧版本失效。
  markStatusChange(kind, id, data, { at, actor }) {
    return this.publishNewVersion(kind, id, data, { at, actor });
  }

  get(kind, id, version) {
    const entity = this.index.get(kind)?.get(id);
    const v = version ?? entity?.current;
    const rec = entity?.versions.get(v);
    if (!rec) throw new Error(`实体不存在：${kind}/${id}@v${version ?? "?"}`);
    return { ...rec.data, _meta: { kind, id, version, registered_at: rec.registered_at, retired_at: rec.retired_at } };
  }

  exists(kind, id) {
    return this.index.get(kind)?.has(id) ?? false;
  }

  currentVersion(kind, id) {
    return this.index.get(kind)?.get(id)?.current ?? null;
  }

  isRetired(kind, id, version, { at = null } = {}) {
    const entity = this.index.get(kind)?.get(id);
    const rec = entity?.versions.get(version);
    if (!rec) throw new Error(`实体不存在：${kind}/${id}@v${version}`);
    if (at === null) return rec.retired_at !== null;
    return rec.retired_at !== null && rec.retired_at <= at;
  }

  // 时点查询：at 时刻正在生效的版本（投诉截图取证的核心）。
  versionAt(kind, id, at) {
    const entity = this.index.get(kind)?.get(id);
    if (!entity) return null;
    let hit = null;
    for (const [version, rec] of entity.versions) {
      if (rec.registered_at <= at && (rec.retired_at === null || rec.retired_at > at)) {
        hit = version;
      }
    }
    return hit;
  }

  allRefs(kind) {
    const out = [];
    for (const [k, byKind] of this.index) {
      if (kind && k !== kind) continue;
      for (const [id, entity] of byKind) {
        for (const version of entity.versions.keys()) {
          out.push({ kind: k, id, version });
        }
      }
    }
    return out;
  }
}
