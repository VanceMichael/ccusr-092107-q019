// 领域标识与实体引用：kind/id@version，例如 recipe/RC-01@v2。
export function refToString(ref) {
  if (!ref || !ref.kind || !ref.id) return "";
  return Number.isInteger(ref.version)
    ? `${ref.kind}/${ref.id}@v${ref.version}`
    : `${ref.kind}/${ref.id}`;
}

export function parseRef(text) {
  const match = /^([a-z_]+)\/([^@]+)@v(\d+)$/.exec(text);
  if (!match) throw new Error(`无法解析实体引用：${text}`);
  return { kind: match[1], id: match[2], version: Number(match[3]) };
}
