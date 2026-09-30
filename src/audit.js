// 追加式留痕日志：所有业务动作按顺序记录，只允许追加，不允许改写。
export function createAuditLog() {
  const events = [];

  function record(type, at, actor, details = {}) {
    const event = { seq: events.length + 1, type, at, actor, details };
    events.push(event);
    return event;
  }

  function list(filter = {}) {
    return events.filter((event) => {
      if (filter.type && event.type !== filter.type) return false;
      if (filter.publicationId && event.details?.publication_id !== filter.publicationId) return false;
      if (filter.since && Date.parse(event.at) < Date.parse(filter.since)) return false;
      return true;
    });
  }

  return { record, list };
}
