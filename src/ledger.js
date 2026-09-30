// 只增审计台账：事件按序追加，前后哈希串联，任何篡改都会在 verify() 暴露。
import { createHash } from "node:crypto";

const GENESIS = "GENESIS";

function digest(event) {
  const h = createHash("sha256");
  h.update(
    JSON.stringify({
      seq: event.seq,
      type: event.type,
      at: event.at,
      actor: event.actor ?? null,
      payload: event.payload,
      prev_hash: event.prev_hash,
    })
  );
  return h.digest("hex");
}

export class Ledger {
  constructor(events = []) {
    this.events = [];
    for (const e of events) this._ingest(e);
  }

  _ingest(event) {
    if (event.seq !== this.events.length) {
      throw new Error(`事件序号断裂：期望 ${this.events.length}，实际 ${event.seq}`);
    }
    if (event.prev_hash !== (this.events.at(-1)?.hash ?? GENESIS)) {
      throw new Error(`事件 ${event.seq} 前序哈希不匹配，台账链条已断裂`);
    }
    if (digest(event) !== event.hash) {
      throw new Error(`事件 ${event.seq} 内容哈希不匹配，台账可能被篡改`);
    }
    this.events.push(event);
  }

  // at 为业务发生时间（由服务时钟给出），便于按投诉截图时间还原历史。
  append(type, payload, { at, actor } = {}) {
    if (!at) throw new Error("追加事件必须带业务发生时间 at");
    const event = {
      seq: this.events.length,
      type,
      at,
      actor: actor ?? null,
      payload,
      prev_hash: this.events.at(-1)?.hash ?? GENESIS,
    };
    event.hash = digest(event);
    this.events.push(event);
    return event;
  }

  // 重新计算整条哈希链，供调查取证时核验台账完整性。
  verify() {
    let prev = GENESIS;
    for (const event of this.events) {
      if (event.prev_hash !== prev) return false;
      if (digest(event) !== event.hash) return false;
      prev = event.hash;
    }
    return true;
  }
}
