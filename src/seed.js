// 从样例资料构建一套可运行的审签服务。
import { createAuditLog } from "./audit.js";
import { createRegistry } from "./registry.js";
import { createReviewService } from "./service.js";

export function loadSeed(raw) {
  const seed = JSON.parse(raw);
  if (
    !seed.policy ||
    !Array.isArray(seed.roles) ||
    seed.roles.length === 0 ||
    !Array.isArray(seed.products) ||
    seed.products.length === 0 ||
    !Array.isArray(seed.entities) ||
    seed.entities.length === 0
  ) {
    throw new Error("样例资料缺少必要字段");
  }
  const audit = createAuditLog();
  const registry = createRegistry(audit);
  const service = createReviewService({ registry, audit, policy: seed.policy, products: seed.products });
  for (const entity of seed.entities) {
    service.registerEntityVersion({ ...entity, actor: "seed" });
  }
  return { seed, audit, registry, service };
}
