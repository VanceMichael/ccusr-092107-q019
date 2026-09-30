// 完整虚构剧本：用固定时间重放一条真实调查会遇到的时间线。
// 覆盖：两版配方/多版包装、功效暗示被否、并发审批冲突、跨渠道复用、代言超范围、
// 配方变更撤批、旧图回流（未批准上架）、商标无效、法规换版、下架澄清、投诉时点还原。
import { ApprovalService, ConcurrencyConflictError, ComplianceBlockedError } from "./service.js";

export function buildScenario() {
  const svc = new ApprovalService({ clock: () => "2026-09-30T09:00:00+08:00" });
  const exceptions = [];
  const attempt = (label, fn) => {
    try { return fn(); }
    catch (e) {
      if (!(e instanceof ConcurrencyConflictError || e instanceof ComplianceBlockedError)) throw e;
      exceptions.push({ label, code: e.code, message: e.message });
      return null;
    }
  };
  const reg = (kind, id, data, at, actor) => svc.registerEntity(kind, id, data, { at, actor });
  const revise = (kind, id, data, at, actor) => svc.publishNewVersion(kind, id, data, { at, actor });

  const U = {
    pm: "u-linzhiyao", rnd: "u-hewenshan", brand: "u-zhouce", channel: "u-censui",
    legal: "u-weilan", comp: "u-baizheng", qa: "u-wrenyue",
    handler: "u-shaomingheng", lead: "u-yingtianlan",
  };

  // ---- 1. 基础资料登记（2026-03 初）-------------------------------------
  reg("category", "CAT-BEVERAGE", {
    name: "风味饮料（普通食品）", ordinary_food: true,
    note: "非保健食品、非药品，不得宣称疾病预防治疗或保健功效",
  }, "2026-03-01T10:00:00+08:00", U.pm);

  reg("recipe", "RC-TANG", {
    name: "棠参饮配方",
    ingredients: [
      { name: "饮用水", per_100g: 85, unit: "g" },
      { name: "棠梨原汁", per_100g: 10, unit: "g" },
      { name: "人参（人工种植，5年及以下）", per_100g: 0.3, unit: "g" },
      { name: "蜂蜜", per_100g: 4, unit: "g" },
    ],
    flavorings: ["棠梨香精"],
  }, "2026-03-01T10:10:00+08:00", U.rnd);

  reg("trademark", "TM-TANGSHEN", {
    name: "棠参", reg_no_fictional: "TM-X-000001", status: "registered", status_label: "已注册",
    applicant_fictional: "虚构棠果食品公司",
  }, "2026-03-01T10:20:00+08:00", U.legal);

  reg("regulation", "REG-CN-FOODAD", {
    title: "普通食品营销表述规范（虚构示例）", status: "in_force",
    rules: ["普通食品不得标注或暗示疾病预防、治疗功能", "不得借助名称、图案混淆为药品", "成分定量宣称须与真实投料一致"],
  }, "2026-03-01T10:30:00+08:00", U.legal);

  reg("legal_opinion", "LO-01", {
    title: "棠参饮包装表述法律意见（首版）",
    conclusions: [
      {
        claim_key: "C1", claim_text: "人参配方（人工种植人参0.3g/100g）",
        decision: "permitted", basis_regulation: "regulation/REG-CN-FOODAD@v1",
        note: "含量必须与真实配方一致；人工种植5年及以下人参可作为普通食品原料",
      },
      {
        claim_key: "C2", claim_text: "提神抗疲劳，熬夜必备",
        decision: "prohibited", basis_regulation: "regulation/REG-CN-FOODAD@v1",
        reason: "抗疲劳属保健功能暗示，普通食品不得使用，抽检合格报告不能替代该结论",
      },
      {
        claim_key: "C4", claim_text: "以「棠参」为商品名（与虚构药品「棠参片」近似）",
        decision: "permitted_with_conditions", basis_regulation: "regulation/REG-CN-FOODAD@v1",
        required_markings: ["本品为普通食品，不能代替药物"],
        note: "可使用名称近似商标，但正面必须同屏显著标注普通食品身份，禁止任何疗效字样",
      },
    ],
  }, "2026-03-02T09:00:00+08:00", U.legal);

  reg("test_report", "TR-Q1-2026", {
    report_no_fictional: "TR-2026-Q1-0088", kind_label: "产品质量监督抽检",
    sampled_at: "2026-03-03", conclusion: "所检质量指标合格",
    batches: ["B20260301", "B20260305"],
    tested_items: ["菌落总数", "大肠菌群", "铅", "食品添加剂"],
    scope_note: "仅证明抽样批次的质量指标合格，不证明任何成分含量宣称或功效",
  }, "2026-03-05T14:00:00+08:00", U.qa);

  reg("endorsement", "ED-JIANGJQ", {
    celebrity: "江见青（虚构艺人）", status: "active",
    period: { from: "2026-03-15", to: "2026-09-30" },
    channels: ["tmall", "jd"],
    audiences: ["成人普通消费者"],
    product_ids: ["PRD-TANG-001"],
    scope_note: "代言仅覆盖棠参饮一个SKU，授权渠道不含拼多多/快手",
  }, "2026-03-28T11:00:00+08:00", U.brand);

  // 包装 v1：带功效暗示，送审被否
  reg("packaging", "PK-TANG", {
    product_id: "PRD-TANG-001", name: "棠参饮正面包装 v1",
    front_copy: "棠参饮｜人参配方，提神抗疲劳，熬夜必备",
    markings: [],
    category_ref: "category/CAT-BEVERAGE@v1",
    recipe_ref: "recipe/RC-TANG@v1",
    trademark_ref: "trademark/TM-TANGSHEN@v1",
    endorsement_refs: [],
    test_report_refs: ["test_report/TR-Q1-2026@v1"],
    legal_opinion_refs: ["legal_opinion/LO-01@v1"],
    claims: [
      { key: "C1", kind: "ingredient", text: "人参配方", ingredient: "人参（人工种植，5年及以下）", require_min_per_100g: 0.3 },
      { key: "C2", kind: "function", text: "提神抗疲劳，熬夜必备" },
    ],
  }, "2026-03-06T15:00:00+08:00", U.pm);

  reg("channel_page", "CP-TMALL", {
    channel_id: "tmall", title: "天猫旗舰店·棠参饮详情页", url_fictional: "https://example.invalid/tmall/tang",
    shown_packaging: "packaging/PK-TANG@v1",
  }, "2026-03-06T16:00:00+08:00", U.brand);
  reg("channel_page", "CP-PDD", {
    channel_id: "pdd", title: "拼多多旗舰店·棠参饮详情页", url_fictional: "https://example.invalid/pdd/tang",
    shown_packaging: "packaging/PK-TANG@v1",
  }, "2026-03-06T16:10:00+08:00", U.brand);

  // ---- 2. 送审 v1：评估留痕，合规要求修改 --------------------------------
  const sub1 = svc.submitForReview({
    submission_id: "SUB-2026-001", product_id: "PRD-TANG-001",
    packaging_ref: "packaging/PK-TANG@v1",
    channel_page_refs: ["channel_page/CP-TMALL@v1", "channel_page/CP-PDD@v1"],
    submitted_by: U.pm, at: "2026-03-07T09:30:00+08:00",
  });

  svc.recordReview({
    submission_id: "SUB-2026-001", reviewer: U.comp, role: "compliance_reviewer",
    decision: "reject", note: "「提神抗疲劳」为功效暗示，法律意见明确禁止；抽检合格不支撑该表述",
    base_revision: 1, at: "2026-03-07T14:00:00+08:00",
  });

  // ---- 3. 修订为 v2；并发审批：法务基于旧修订号的意见被拒，留痕后重提 ----
  revise("packaging", "PK-TANG", {
    product_id: "PRD-TANG-001", name: "棠参饮正面包装 v2",
    front_copy: "棠参饮｜人参配方（人工种植人参0.3g/100g）·棠梨味",
    markings: ["本品为普通食品，不能代替药物"],
    category_ref: "category/CAT-BEVERAGE@v1",
    recipe_ref: "recipe/RC-TANG@v1",
    trademark_ref: "trademark/TM-TANGSHEN@v1",
    endorsement_refs: ["endorsement/ED-JIANGJQ@v1"],
    test_report_refs: ["test_report/TR-Q1-2026@v1"],
    legal_opinion_refs: ["legal_opinion/LO-01@v1"],
    claims: [
      { key: "C1", kind: "ingredient", text: "人参配方（人工种植人参0.3g/100g）", ingredient: "人参（人工种植，5年及以下）", require_min_per_100g: 0.3 },
      { key: "C3", kind: "flavor", text: "棠梨味", flavor_of: "棠梨原汁" },
      { key: "C4", kind: "name_likeness", text: "商品名「棠参」与虚构药品「棠参片」近似" },
    ],
  }, "2026-03-09T10:00:00+08:00", U.pm);

  svc.reviseSubmission({
    submission_id: "SUB-2026-001", packaging_ref: "packaging/PK-TANG@v2",
    actor: U.pm, at: "2026-03-09T11:00:00+08:00", note: "删除功效暗示，补普通食品身份标注",
  });

  attempt("法务基于旧修订号审批（并发冲突）", () => svc.recordReview({
    submission_id: "SUB-2026-001", reviewer: U.legal, role: "legal_reviewer",
    decision: "approve", note: "旧版意见", base_revision: 1, at: "2026-03-09T13:00:00+08:00",
  }));

  svc.recordReview({
    submission_id: "SUB-2026-001", reviewer: U.comp, role: "compliance_reviewer",
    decision: "approve", note: "三条表述均有对应证据：含量见配方、风味见棠梨汁、名称见附条件意见",
    base_revision: 2, at: "2026-03-10T09:00:00+08:00",
  });
  svc.recordReview({
    submission_id: "SUB-2026-001", reviewer: U.legal, role: "legal_reviewer",
    decision: "approve", note: "普通食品标识已同屏标注，同意按修订版批准",
    base_revision: 2, at: "2026-03-10T10:00:00+08:00",
  });
  svc.issueApproval({
    approval_no: "AP-2026-001", submission_id: "SUB-2026-001", actor: U.lead,
    at: "2026-03-10T15:00:00+08:00", base_revision: 2,
    scope: {
      channel_ids: ["tmall", "jd"], audiences: ["成人普通消费者"], regions: ["中国大陆"],
      valid_from: "2026-03-20", valid_to: "2026-12-31",
    },
  });

  // ---- 4. 天猫投放 + 渠道页换版 ------------------------------------------
  revise("channel_page", "CP-TMALL", {
    channel_id: "tmall", title: "天猫旗舰店·棠参饮详情页", url_fictional: "https://example.invalid/tmall/tang",
    shown_packaging: "packaging/PK-TANG@v2",
  }, "2026-03-19T18:00:00+08:00", U.brand);

  svc.launchPlacement({
    placement_id: "PL-TMALL-01", channel_id: "tmall", channel_page_ref: "channel_page/CP-TMALL@v2",
    packaging_ref: "packaging/PK-TANG@v2", audience: "成人普通消费者", region: "中国大陆",
    approval_no: "AP-2026-001", actor: U.brand, at: "2026-03-20T00:05:00+08:00",
  });

  // ---- 5. 跨渠道复用拼多多：另走批准；代言授权当时不含 pdd，异常留痕 ------
  const sub2 = svc.submitForReview({
    submission_id: "SUB-2026-002", product_id: "PRD-TANG-001",
    packaging_ref: "packaging/PK-TANG@v2", channel_page_refs: ["channel_page/CP-PDD@v1"],
    submitted_by: U.brand, at: "2026-04-06T09:00:00+08:00",
  });
  svc.recordReview({ submission_id: "SUB-2026-002", reviewer: U.comp, role: "compliance_reviewer", decision: "approve", note: "素材与已批准版本一致", base_revision: 1, at: "2026-04-06T10:00:00+08:00" });
  svc.recordReview({ submission_id: "SUB-2026-002", reviewer: U.legal, role: "legal_reviewer", decision: "approve", note: "仅限拼多多渠道使用", base_revision: 1, at: "2026-04-06T11:00:00+08:00" });
  svc.issueApproval({
    approval_no: "AP-2026-002", submission_id: "SUB-2026-002", actor: U.lead,
    at: "2026-04-07T09:00:00+08:00", base_revision: 1,
    scope: { channel_ids: ["pdd"], audiences: ["成人普通消费者"], regions: ["中国大陆"], valid_from: "2026-04-07", valid_to: "2026-12-31" },
  });

  svc.launchPlacement({
    placement_id: "PL-PDD-01", channel_id: "pdd", channel_page_ref: "channel_page/CP-PDD@v1",
    packaging_ref: "packaging/PK-TANG@v2", audience: "成人普通消费者", region: "中国大陆",
    approval_no: "AP-2026-002", source: { type: "reuse", from_placement_id: "PL-TMALL-01" },
    actor: U.brand, at: "2026-04-08T00:10:00+08:00",
  });

  // 代言扩权到拼多多（授权范围版本化）
  revise("endorsement", "ED-JIANGJQ", {
    celebrity: "江见青（虚构艺人）", status: "active",
    period: { from: "2026-03-15", to: "2026-09-30" },
    channels: ["tmall", "jd", "pdd"],
    audiences: ["成人普通消费者"],
    product_ids: ["PRD-TANG-001"],
    scope_note: "补充授权拼多多渠道",
  }, "2026-04-09T10:00:00+08:00", U.brand);
  revise("channel_page", "CP-PDD", {
    channel_id: "pdd", title: "拼多多旗舰店·棠参饮详情页", url_fictional: "https://example.invalid/pdd/tang",
    shown_packaging: "packaging/PK-TANG@v2",
  }, "2026-04-09T12:00:00+08:00", U.brand);

  // ---- 6. 超范围投放快手/青少年受众：直接拦截并留痕 -----------------------
  attempt("快手渠道+青少年受众超范围投放", () => svc.launchPlacement({
    placement_id: "PL-KS-ATTEMPT", channel_id: "kuaishou",
    packaging_ref: "packaging/PK-TANG@v2", audience: "青少年",
    approval_no: "AP-2026-001", actor: U.channel, at: "2026-05-02T20:00:00+08:00",
  }));

  // ---- 7. 配方变更：人参含量 0.3→0.1，旧批准撤销，包装出 v3 --------------
  revise("recipe", "RC-TANG", {
    name: "棠参饮配方（降本改版）",
    ingredients: [
      { name: "饮用水", per_100g: 88, unit: "g" },
      { name: "棠梨原汁", per_100g: 10, unit: "g" },
      { name: "人参（人工种植，5年及以下）", per_100g: 0.1, unit: "g" },
      { name: "蜂蜜", per_100g: 1.5, unit: "g" },
    ],
    flavorings: ["棠梨香精"],
    change_note: "人参投料量下调，旧版「0.3g/100g」宣称不得继续使用",
  }, "2026-06-01T09:00:00+08:00", U.rnd);

  svc.revokeApproval({ approval_no: "AP-2026-001", reason: "配方已变更，旧版含量宣称依据失效", actor: U.lead, at: "2026-06-05T09:00:00+08:00" });
  svc.revokeApproval({ approval_no: "AP-2026-002", reason: "配方已变更，旧版含量宣称依据失效", actor: U.lead, at: "2026-06-05T09:05:00+08:00" });
  svc.endPlacement({ placement_id: "PL-TMALL-01", reason: "配方变更，切换新包装", actor: U.brand, at: "2026-06-05T10:00:00+08:00" });
  svc.endPlacement({ placement_id: "PL-PDD-01", reason: "配方变更，切换新包装", actor: U.brand, at: "2026-06-05T10:05:00+08:00" });

  reg("test_report", "TR-Q2-2026", {
    report_no_fictional: "TR-2026-Q2-0215", kind_label: "产品质量监督抽检",
    sampled_at: "2026-06-07", conclusion: "所检质量指标合格",
    batches: ["B20260603", "B20260606"],
    tested_items: ["菌落总数", "大肠菌群", "铅", "食品添加剂", "人参含量"],
    scope_note: "仅证明新配方抽样批次的质量指标；人参含量实测0.1g/100g，不等于允许任何功效宣称",
  }, "2026-06-07T14:00:00+08:00", U.qa);

  revise("packaging", "PK-TANG", {
    product_id: "PRD-TANG-001", name: "棠参饮正面包装 v3",
    front_copy: "棠参饮·棠梨味｜清新果香",
    markings: ["本品为普通食品，不能代替药物"],
    category_ref: "category/CAT-BEVERAGE@v1",
    recipe_ref: "recipe/RC-TANG@v2",
    trademark_ref: "trademark/TM-TANGSHEN@v1",
    endorsement_refs: ["endorsement/ED-JIANGJQ@v2"],
    test_report_refs: ["test_report/TR-Q2-2026@v1"],
    legal_opinion_refs: ["legal_opinion/LO-01@v1"],
    claims: [
      { key: "C3", kind: "flavor", text: "棠梨味", flavor_of: "棠梨原汁" },
      { key: "C4", kind: "name_likeness", text: "商品名「棠参」与虚构药品「棠参片」近似" },
    ],
  }, "2026-06-06T10:00:00+08:00", U.pm);

  svc.submitForReview({
    submission_id: "SUB-2026-003", product_id: "PRD-TANG-001",
    packaging_ref: "packaging/PK-TANG@v3", submitted_by: U.pm, at: "2026-06-06T11:00:00+08:00",
  });
  svc.recordReview({ submission_id: "SUB-2026-003", reviewer: U.comp, role: "compliance_reviewer", decision: "approve", note: "已删去含量宣称，与新配方一致", base_revision: 1, at: "2026-06-07T09:00:00+08:00" });
  svc.recordReview({ submission_id: "SUB-2026-003", reviewer: U.legal, role: "legal_reviewer", decision: "approve", note: "普通食品标注保留", base_revision: 1, at: "2026-06-07T10:00:00+08:00" });
  svc.issueApproval({
    approval_no: "AP-2026-003", submission_id: "SUB-2026-003", actor: U.lead,
    at: "2026-06-08T09:00:00+08:00", base_revision: 1,
    scope: { channel_ids: ["tmall", "jd", "pdd"], audiences: ["成人普通消费者"], regions: ["中国大陆"], valid_from: "2026-06-08", valid_to: "2026-12-31" },
  });
  revise("channel_page", "CP-TMALL", {
    channel_id: "tmall", title: "天猫旗舰店·棠参饮详情页", url_fictional: "https://example.invalid/tmall/tang",
    shown_packaging: "packaging/PK-TANG@v3",
  }, "2026-06-08T18:00:00+08:00", U.brand);
  svc.launchPlacement({
    placement_id: "PL-TMALL-02", channel_id: "tmall", channel_page_ref: "channel_page/CP-TMALL@v3",
    packaging_ref: "packaging/PK-TANG@v3", audience: "成人普通消费者", region: "中国大陆",
    approval_no: "AP-2026-003", actor: U.brand, at: "2026-06-09T00:05:00+08:00",
  });

  // ---- 8. 旧图回流：拼多多渠道运营私自重上 v2（巡检发现，非批准路径）------
  svc.observeUnauthorizedPlacement({
    placement_id: "PL-PDD-02", channel_id: "pdd", channel_page_ref: "channel_page/CP-PDD@v2",
    packaging_ref: "packaging/PK-TANG@v2", audience: "成人普通消费者", region: "中国大陆",
    observed_at: "2026-06-12T19:40:00+08:00",
    source: { type: "old_image", detail: "渠道运营误用历史素材包重新上架" },
    evidence: ["patrol-screenshot-fictional-sha256:9f1c"],
    actor: U.handler, at: "2026-06-12T20:00:00+08:00",
  });
  svc.endPlacement({ placement_id: "PL-PDD-02", reason: "巡检发现旧图回流且无有效批准，强制下架", actor: U.handler, at: "2026-06-13T08:30:00+08:00" });
  svc.issueClarification({
    placement_id: "PL-PDD-02", channel_id: "pdd",
    text: "澄清：2026年6月12日本店拼多多页面误展示旧版包装，其「人参0.3g/100g」表述对应旧配方，现行产品人参含量为0.1g/100g；本品为普通食品，不具备任何功效。已下架并致歉。",
    actor: U.handler, at: "2026-06-13T09:00:00+08:00",
  });

  // ---- 9. 商标被无效：影响扫描标出仍在投放素材，下架并澄清 ---------------
  revise("trademark", "TM-TANGSHEN", {
    name: "棠参", reg_no_fictional: "TM-X-000001", status: "invalid", status_label: "已无效（异议成立）",
    applicant_fictional: "虚构棠果食品公司",
    change_note: "2026-07-15 商标异议裁定生效，不得继续使用",
  }, "2026-07-15T10:00:00+08:00", U.legal);
  const scanTm = svc.scanImpactOfChange({
    change_ref: "trademark/TM-TANGSHEN@v2", reason: "商标异议无效，继续使用构成侵权与误导",
    actor: U.legal, at: "2026-07-15T11:00:00+08:00",
  });
  svc.endPlacement({ placement_id: "PL-TMALL-02", reason: "商标无效，停止使用旧标识包装", actor: U.brand, at: "2026-07-16T08:00:00+08:00" });
  svc.issueClarification({
    placement_id: "PL-TMALL-02", channel_id: "tmall",
    text: "澄清：因「棠参」商标被裁定无效，本店已更换商标与包装，旧标识商品不再销售，产品本身为普通食品，配方与质量不受影响。",
    actor: U.handler, at: "2026-07-16T10:00:00+08:00",
  });

  // 替代商标与包装 v4（此时尚未投放）
  reg("trademark", "TM-TANGLI", {
    name: "棠里", reg_no_fictional: "TM-X-000002", status: "registered", status_label: "已注册",
    applicant_fictional: "虚构棠果食品公司",
  }, "2026-07-20T09:00:00+08:00", U.legal);
  revise("packaging", "PK-TANG", {
    product_id: "PRD-TANG-001", name: "棠里饮正面包装 v4",
    front_copy: "棠里·棠梨味｜清新果香",
    markings: ["本品为普通食品，不能代替药物"],
    category_ref: "category/CAT-BEVERAGE@v1",
    recipe_ref: "recipe/RC-TANG@v2",
    trademark_ref: "trademark/TM-TANGLI@v1",
    endorsement_refs: ["endorsement/ED-JIANGJQ@v2"],
    test_report_refs: ["test_report/TR-Q1-2026@v1"],
    legal_opinion_refs: ["legal_opinion/LO-01@v1"],
    claims: [
      { key: "C3", kind: "flavor", text: "棠梨味", flavor_of: "棠梨原汁" },
    ],
  }, "2026-07-22T10:00:00+08:00", U.pm);

  // ---- 10. 法规换版：在途 v4 因法律意见依据旧版被扫描标出 ---------------
  revise("regulation", "REG-CN-FOODAD", {
    title: "普通食品营销表述规范（虚构示例）", status: "in_force",
    rules: ["普通食品不得标注或暗示疾病预防、治疗功能", "不得借助名称、图案混淆为药品", "成分定量宣称须与真实投料一致", "新增：名称近似类标注须使用指定字号与对比度"],
    change_note: "2026-08-01 换版，名称近似标注要求加严",
  }, "2026-08-01T00:00:00+08:00", U.legal);
  svc.submitForReview({
    submission_id: "SUB-2026-004", product_id: "PRD-TANG-001",
    packaging_ref: "packaging/PK-TANG@v4", submitted_by: U.pm, at: "2026-08-02T09:00:00+08:00",
  });
  const scanReg = svc.scanImpactOfChange({
    change_ref: "regulation/REG-CN-FOODAD@v2", reason: "规范换版，依据旧版出具的法律意见需重出",
    actor: U.legal, at: "2026-08-02T10:00:00+08:00",
  });

  // 按新规重出法律意见，包装 v5 获批投放
  reg("legal_opinion", "LO-02", {
    title: "棠里饮包装法律意见（按新规重出）",
    conclusions: [
      {
        claim_key: "C4", claim_text: "名称近似风险标注（新商标无近似问题，仅保留普通食品身份标注）",
        decision: "permitted_with_conditions", basis_regulation: "regulation/REG-CN-FOODAD@v2",
        required_markings: ["本品为普通食品，不能代替药物"],
        note: "按 v2 新规指定字号同屏标注",
      },
    ],
  }, "2026-08-04T09:00:00+08:00", U.legal);
  revise("packaging", "PK-TANG", {
    product_id: "PRD-TANG-001", name: "棠里饮正面包装 v5",
    front_copy: "棠里·棠梨味｜清新果香",
    markings: ["本品为普通食品，不能代替药物"],
    category_ref: "category/CAT-BEVERAGE@v1",
    recipe_ref: "recipe/RC-TANG@v2",
    trademark_ref: "trademark/TM-TANGLI@v1",
    endorsement_refs: ["endorsement/ED-JIANGJQ@v2"],
    test_report_refs: ["test_report/TR-Q2-2026@v1"],
    legal_opinion_refs: ["legal_opinion/LO-02@v1"],
    claims: [
      { key: "C3", kind: "flavor", text: "棠梨味", flavor_of: "棠梨原汁" },
      { key: "C4", kind: "name_likeness", text: "普通食品身份标注按新规执行" },
    ],
  }, "2026-08-05T10:00:00+08:00", U.pm);
  svc.reviseSubmission({ submission_id: "SUB-2026-004", packaging_ref: "packaging/PK-TANG@v5", actor: U.pm, at: "2026-08-06T09:00:00+08:00", note: "改用依据新规的法律意见" });
  svc.recordReview({ submission_id: "SUB-2026-004", reviewer: U.comp, role: "compliance_reviewer", decision: "approve", note: "表述与新配方一致", base_revision: 2, at: "2026-08-07T09:00:00+08:00" });
  svc.recordReview({ submission_id: "SUB-2026-004", reviewer: U.legal, role: "legal_reviewer", decision: "approve", note: "已按新规复核", base_revision: 2, at: "2026-08-07T10:00:00+08:00" });
  svc.issueApproval({
    approval_no: "AP-2026-005", submission_id: "SUB-2026-004", actor: U.lead,
    at: "2026-08-08T09:00:00+08:00", base_revision: 2,
    scope: { channel_ids: ["tmall", "jd", "pdd"], audiences: ["成人普通消费者"], regions: ["中国大陆"], valid_from: "2026-08-08", valid_to: "2026-12-31" },
  });
  revise("channel_page", "CP-TMALL", {
    channel_id: "tmall", title: "天猫旗舰店·棠里饮详情页", url_fictional: "https://example.invalid/tmall/tangli",
    shown_packaging: "packaging/PK-TANG@v5",
  }, "2026-08-11T18:00:00+08:00", U.brand);
  svc.launchPlacement({
    placement_id: "PL-TMALL-03", channel_id: "tmall", channel_page_ref: "channel_page/CP-TMALL@v4",
    packaging_ref: "packaging/PK-TANG@v5", audience: "成人普通消费者", region: "中国大陆",
    approval_no: "AP-2026-005", actor: U.brand, at: "2026-08-12T00:05:00+08:00",
  });

  // ---- 11. 消费者投诉：截图时间为 6 月旧图回流当晚 -----------------------
  svc.registerComplaint({
    complaint_id: "CMP-2026-0912-09", channel_id: "pdd",
    captured_at: "2026-06-12T20:30:00+08:00",
    captured_packaging_ref: "packaging/PK-TANG@v2",
    description: "截图显示拼多多页面宣称「人参0.3g/100g」并有明星江见青形象，质疑含量与功效，要求核实当时在售版本与依据。仅有一份抽检合格报告不能说明问题。",
    evidence: ["complaint-screenshot-fictional-sha256:7d2a", "complaint-video-fictional-sha256:b08e"],
    actor: U.handler, at: "2026-09-12T09:30:00+08:00",
  });
  const linked = svc.linkComplaint({ complaint_id: "CMP-2026-0912-09", actor: U.handler, at: "2026-09-12T10:00:00+08:00" });
  svc.handleComplaint({
    complaint_id: "CMP-2026-0912-09", decision: "部分属实并已处置",
    note: "截图对应未批准的旧图回流投放，当晚已下架、次日澄清；现行含量0.1g/100g；代言当晚授权已覆盖pdd但商品现使用新包装；向投诉人书面反馈并留档。",
    actor: U.handler, at: "2026-09-13T15:00:00+08:00",
  });

  return {
    service: svc,
    exceptions,
    scans: { trademark: scanTm, regulation: scanReg },
    complaint: linked,
    refs: {
      rejected_packaging: "packaging/PK-TANG@v1",
      old_packaging: "packaging/PK-TANG@v2",
      new_recipe: "recipe/RC-TANG@v2",
      invalid_trademark: "trademark/TM-TANGSHEN@v2",
      new_regulation: "regulation/REG-CN-FOODAD@v2",
      current_packaging: "packaging/PK-TANG@v5",
      unauthorized_placement: "PL-PDD-02",
      complaint_id: "CMP-2026-0912-09",
    },
  };
}
