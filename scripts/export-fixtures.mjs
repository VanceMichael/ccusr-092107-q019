// 重放虚构剧本，导出两份调查产物：
//  fixtures/bundle.json                   只增台账取证包（含哈希链与校验结论）
//  fixtures/complaint-reconstruction.json 按投诉截图时间还原的现场与处置链
// 运行：npm run build:fixtures
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildScenario } from "../src/scenario.js";
import { fingerprintBundle } from "../src/service.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../fixtures");

const { service, scans, exceptions, refs } = buildScenario();
const bundle = service.exportBundle();
// 在最终状态（投诉已关联、已处置）上按截图时间重新还原，处置链才包含投诉事件。
const complaint = service.reconstruct({ placement_id: "PL-PDD-02", at: "2026-06-12T20:30:00+08:00" });
const report = {
  generated_for: "普通食品营销表述审签服务·调查还原示例（全部主体虚构）",
  complaint_id: refs.complaint_id,
  captured_at: "2026-06-12T20:30:00+08:00",
  key_findings: {
    packaging_seen: complaint.packaging_seen.ref,
    front_copy: complaint.packaging_seen.front_copy,
    recipe_on_packaging: complaint.recipe_on_packaging.ref,
    recipe_actual_at_capture: complaint.recipe_actual_at.ref,
    actual_ginseng_per_100g: complaint.recipe_actual_at.ingredients.find((i) => i.name.includes("人参")).per_100g,
    launch_mode: complaint.launch_mode,
    decision_at_capture: complaint.claim_evaluation_at.decision,
    endorsement_coverage_at_capture: complaint.endorsement_status_at.map((e) => ({
      ref: e.ref, celebrity: e.celebrity,
      covers_pinned: e.covers_pinned, pinned_problems_at: e.pinned_problems_at,
      effective_version_at: e.effective_version_at, effective_problems_at: e.effective_problems_at,
      within_scope_at: e.within_scope_at,
    })),
    basis_notes: complaint.claim_evaluation_at.basis_notes,
    reports_not_applicable_to_function_claims:
      complaint.claim_evaluation_at.results
        .flatMap((r) => r.not_applicable ?? [])
        .map((n) => ({ ref: n.ref, reason: n.reason })),
    test_reports_attached_to_packaging: complaint.test_reports_attached,
  },
  subsequent_actions: complaint.subsequent_actions.map((a) => ({ at: a.at, type: a.type, actor: a.actor })),
  impact_scans: {
    trademark_invalid: {
      change_ref: scans.trademark.change_ref,
      live_placements_flagged: scans.trademark.live_placements.map((p) => p.placement_id),
      channel_pages_flagged: scans.trademark.channel_pages.map((p) => p.channel_page_ref),
      action_required: scans.trademark.action_required,
    },
    regulation_reissued: {
      change_ref: scans.regulation.change_ref,
      pending_submissions_flagged: scans.regulation.pending_submissions.map((s) => s.submission_id),
      action_required: scans.regulation.action_required,
    },
  },
  blocked_attempts_left_in_ledger: exceptions,
  ledger: { verified: bundle.verified, event_count: bundle.events.length, fingerprint_sha256: fingerprintBundle(bundle) },
};

await mkdir(out, { recursive: true });
await writeFile(resolve(out, "bundle.json"), JSON.stringify(bundle, null, 2) + "\n", "utf8");
await writeFile(resolve(out, "complaint-reconstruction.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(`已导出 ${bundle.events.length} 个台账事件与投诉还原报告，台账校验：${bundle.verified}`);
