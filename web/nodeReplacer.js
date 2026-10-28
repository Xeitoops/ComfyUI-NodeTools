/**
 * ============================================================
 *  ComfyUI-NodeReplacer  v3.7
 *  用画布上已有的一个节点，直接顶替另一个节点
 * ============================================================
 *
 *  不是「搜索节点类型新建」，而是「拿现成的节点去换」。
 *
 *  用法（点选式，无快捷键，不和其他插件抢键）：
 *    1. 左键点选一个节点（想串成链就多选几个）→ 右键 → 「🔄 替换节点…」
 *    2. 进入替换模式：该节点高亮，顶部出现提示条
 *    3. 左键点一下另一个节点 → 立即完成替换
 *    4. Esc / 右键 / 点空白 取消
 *
 *  ★ v3.0 起「顺序不限」：
 *    先右键哪个、后点哪个都行，方向由连线自动判断 ——
 *      · 只有一边有连线 → 有连线的那边被接管（另一边的节点去顶替它）
 *      · 两边都有连线   → 弹两行按钮问你往哪边接（Enter 选第一项）
 *      · 两边都没连线   → 只互换位置
 *
 *  ★ v3.1 多选 = 串成链：
 *    选中好几个都没连线的节点，去点一个已连线的节点 →
 *    这几个节点按从左到右串成一条链，整串顶替它（上游→第一个，最后一个→下游，
 *    中间按数据类型穿透，model+clip 并排的线整组穿过去）。
 *
 *  ★ v3.2 端口对不上时不再「搬一半」：
 *    同一数据类型的线整组处理。新节点少了 CLIP 输出口时，
 *    CLIP 的输入也不会被搬走 —— 否则旧节点的 CLIP 输出变成无源、下游直接断供。
 *    （当时这里会先弹个确认条，v3.11 已撤掉，见下。）
 *
 *  ★ v3.11 搬不动的那类线，改走「上游直连下游」；不再问、不再留线：
 *    新节点没有这类口子（比旧节点少一类口，或反过来），旧做法是把线留在旧节点上。
 *    问题是旧节点还挂在这条数据路上继续加工，用户以为换掉了其实还在生效，
 *    而且它身上还挂着线，看着就不像被替换。现在直接把上游接到下游
 *    （等价于只对这一类做一次「从连线中分离」），旧节点彻底退出这条线。
 *    只有这类输入正好一条时才动手；多条输入、或上游根本没有，就原样留着并在
 *    提示里说明原因。另外：不再弹「有 N 类线接不上，还要继续吗」——
 *    既然点了替换就是知道自己在做什么，全部写进完成提示和连线报告里。
 *
 *  ★ v3.4 串联时缺端口不再整类放弃：
 *    链上某个节点没有这类口子，就把它「旁路」掉 —— 这类线跨过它，
 *    接到下一个能承接的节点。只有整条链都没这种口子，整类才留旧节点。
 *
 *  ★ v3.5 多选两个玩法 + 补连空口：
 *    选中一批「已有连线」的节点再点一个节点 → 弹面板问：
 *      · 合并成一个：这批的对外连线全部交给它，旧节点断线保留（一换多）
 *      · 分别替换：第一个用它，其余克隆同款，各自接管自己的线（一 一 一）
 *    替换完成后，新节点上还空着、但能从上游源节点补上的「数据口」
 *    （MODEL / CLIP / VAE / LATENT 这类，参数口不动）会自动接上。
 *
 *  ★ v3.6 换顺序（调序）：
 *    两个节点在链上一前一后（紧挨着、或者中间隔着别的节点都行），
 *    点完第二个节点时面板里会多一项「交换顺序」——
 *      上游U → [A] → X → [B] → 下游D   变成
 *      上游U → [B] → X → [A] → 下游D
 *    做法是对调上下游（不是搬线），两者直接连着的那段方向反过来；
 *    按数据类型一类一类换，某一类只有一边有口子就整类留在原节点上。
 *
 *  ★ v3.7 不留悬空旧线：
 *    因为缺口子而留在旧节点上的那类线，先看旧节点这类出口还有没有下游 ——
 *    没有就说明这条输入什么也喂不出去，直接断开（不再问、不再警告）。
 *    出口还在供货的正常情况一律保留。
 *
 *  ★ v3.13.1 橙点不再写进工作流：
 *    节点左上角那个小圆点是 litegraph 的「标题框颜色点」，取的是 node.boxcolor。
 *    以前直接改 boxcolor 来高亮待替换节点，而 boxcolor 会被序列化 ——
 *    标记期间只要保存/自动保存过一次，橙点就永久留在节点上（撤销也回不来）。
 *    现在改成临时覆盖绘制方法：画面一样，工作流里不留任何痕迹；
 *    并顺手清掉老版本已经写死在 boxcolor 里的橙点。
 *
 *  行为：
 *    · 新节点接管旧节点的全部输入 / 输出连线
 *    · 新旧节点位置互换：新节点占住原来的走线位置，旧节点挪到新节点原先的位置
 *    · 旧节点不删除，留着对比；断线但不影响节点本身和你调好的参数
 *    · 新节点自己的参数、标题、外观一律不动
 *    · 撤销（Ctrl+Z）可整体还原
 * ============================================================
 */

import { app } from "../../scripts/app.js";

const EXT_NAME = "ComfyUI.NodeReplacer";
const VERSION = "1.0.0";
const LOG = "[NodeReplacer]";

/* 替换模式里给「待替换节点」打的橙点 */
const MARK_COLOR = "#ff7a45";

/* ============================================================
 * 一、基础工具
 * ============================================================ */

function LG() {
  return (
    window.LiteGraph ||
    window.comfyAPI?.litegraph?.LiteGraph ||
    window.comfyAPI?.LiteGraph ||
    null
  );
}

/** 类型描述规范化：'MODEL' / ['MODEL','CLIP'] / 'MODEL,CLIP' 都拆成数组 */
function typeTokens(t) {
  if (t === null || t === undefined) return ["*"];
  if (Array.isArray(t)) {
    const out = [];
    for (const x of t) out.push(...typeTokens(x));
    return out.length ? out : ["*"];
  }
  const s = String(t).trim();
  if (!s) return ["*"];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 目标端 destType 能否接收源端 srcType 的数据 */
function compatible(destType, srcType) {
  const d = typeTokens(destType);
  const s = typeTokens(srcType);
  if (d.includes("*") || s.includes("*")) return true;
  return s.some((x) => d.includes(x));
}

/** 名称归一化：小写、去分隔符、去结尾数字 */
function normName(n) {
  return String(n ?? "")
    .toLowerCase()
    .replace(/[\s_\-.]/g, "")
    .replace(/\d+$/, "");
}

/** graph.links 在新旧版本里可能是普通对象，也可能是 Map */
function getLink(graph, id) {
  if (!graph || id === null || id === undefined) return null;
  const links = graph.links ?? graph._links;
  if (!links) return null;
  if (typeof links.get === "function") return links.get(id) ?? null;
  return links[id] ?? null;
}

function toast(severity, summary, detail, life = 6000) {
  try {
    const t = app.extensionManager?.toast;
    if (t?.add) {
      t.add({ severity, summary: tr(summary), detail: tr(detail), life });
      return;
    }
  } catch (err) {
    /* ignore */
  }
  const fn = severity === "error" ? console.error : console.log;
  fn(LOG, summary, detail ?? "");
}

function beginChange() {
  try {
    app.canvas?.emitBeforeChange?.();
  } catch (err) {
    /* ignore */
  }
}

function endChange() {
  try {
    app.canvas?.emitAfterChange?.();
  } catch (err) {
    /* ignore */
  }
}

/** 当前选中的节点（去重） */
function selectedNodes() {
  const out = [];
  const seen = new Set();
  const add = (n) => {
    if (n && n.id !== undefined && !seen.has(n.id)) {
      seen.add(n.id);
      out.push(n);
    }
  };

  const sel = app.canvas?.selected_nodes;
  if (sel) {
    for (const n of Object.values(sel)) add(n);
  }

  // 兜底：有些版本选中状态挂在节点自身的 selected 标记上
  if (!out.length && Array.isArray(app.graph?._nodes)) {
    for (const n of app.graph._nodes) {
      if (n?.selected) add(n);
    }
  }

  return out;
}

/** 节点身上挂着多少根线（输入 + 输出一起算） */
function linkCountOf(node) {
  if (!node) return 0;
  let n = 0;
  for (const slot of node.inputs ?? []) {
    if (slot?.link !== null && slot?.link !== undefined) n++;
  }
  for (const slot of node.outputs ?? []) {
    n += Array.isArray(slot?.links) ? slot.links.length : 0;
  }
  return n;
}

/** 节点显示名，给提示语用 */
function displayName(node) {
  return node?.title || node?.type || "节点";
}

/* ============================================================
 * 排查：把节点的每个槽位和连线导成纯文本
 *
 * 替换完成后自动复制一份到剪贴板，出问题时直接粘出来就能定位，
 * 不用再靠截图猜。
 * ============================================================ */

let lastReport = null;

function dumpNodeLines(node, graph) {
  if (!node) return ["(节点不存在)"];
  const label = (n) => (n ? `${displayName(n)}#${n.id}` : "?");
  const rows = [];

  rows.push(
    `── ${label(node)}  [type=${node.type}]  `
      + `pos ${Math.round(node.pos?.[0] ?? 0)},${Math.round(node.pos?.[1] ?? 0)}`,
  );

  (node.inputs ?? []).forEach((s, i) => {
    const l = getLink(graph, s?.link);
    rows.push(
      l
        ? `  in  [${i}] ${s.name} (${s.type})  ←  ${label(graph.getNodeById(l.origin_id))}.out[${l.origin_slot}]  link.type=${l.type}`
        : `  in  [${i}] ${s.name} (${s.type})  ←  —`,
    );
  });

  (node.outputs ?? []).forEach((s, i) => {
    const ids = Array.isArray(s?.links) ? s.links : [];
    if (!ids.length) {
      rows.push(`  out [${i}] ${s.name} (${s.type})  →  —`);
      return;
    }
    for (const id of ids) {
      const l = getLink(graph, id);
      rows.push(
        l
          ? `  out [${i}] ${s.name} (${s.type})  →  ${label(graph.getNodeById(l.target_id))}.in[${l.target_slot}]  link.type=${l.type}`
          : `  out [${i}] ${s.name} (${s.type})  →  link#${id} 已失效`,
      );
    }
  });

  return rows;
}

function dumpText(nodes, graph) {
  const g = graph ?? app.graph;
  return nodes.filter(Boolean).flatMap((n) => [...dumpNodeLines(n, g), ""]).join("\n");
}

/** 报告存起来 + 尽量复制到剪贴板；返回是否复制成功 */
function publishReport(kind, headline, sections) {
  const text = trBlock(
    [`ComfyUI-NodeReplacer v${VERSION} — ${tr(kind)}`, headline, "", ...sections].join("\n"),
  );
  lastReport = text;

  let copied = false;
  try {
    const nav = globalThis.navigator;
    if (nav?.clipboard?.writeText) {
      nav.clipboard.writeText(text).then(
        () => {},
        () => {},
      );
      copied = true;
    }
  } catch (err) {
    /* 剪贴板不可用就只留 console */
  }

  console.log(`${LOG} ${kind}报告\n${text}`);
  return copied;
}

/* ============================================================
 * 二、连线槽位匹配
 * ============================================================ */

/**
 * 在 target 上为 source 的每个「已连线」槽位找落点。
 *
 * 五轮，逐轮放宽：
 *   1. 名字完全相同 + 类型兼容
 *   2. 归一化名字相同 + 类型兼容
 *   3. 索引相同 + 类型兼容
 *   4. 任意「空着的」兼容槽位（不抢占 target 原有连线）
 *   5. 任意兼容槽位（会覆盖 target 原有连线）
 *
 * @returns {{pairs: Array<{from:number,to:number}>, fuzzy: Array, unmatched: number[]}}
 */
function matchSlots(source, target, isInput, graph) {
  const srcSlots = (isInput ? source.inputs : source.outputs) ?? [];
  const dstSlots = (isInput ? target.inputs : target.outputs) ?? [];

  const usedDst = new Set();
  const doneSrc = new Set();
  const pairs = [];
  const fuzzy = [];
  const unmatched = [];

  const hasLink = (slot) =>
    isInput
      ? slot?.link !== null && slot?.link !== undefined
      : (slot?.links?.length ?? 0) > 0;

  const pending = [];
  srcSlots.forEach((s, i) => {
    if (hasLink(s)) pending.push(i);
  });
  if (!pending.length) return { pairs, fuzzy, unmatched };

  const isEmptySlot = (j) =>
    isInput
      ? dstSlots[j]?.link === null || dstSlots[j]?.link === undefined
      : (dstSlots[j]?.links?.length ?? 0) === 0;

  const srcTypeOf = (i) => {
    const s = srcSlots[i];
    if (s?.type) return s.type;
    if (isInput) {
      const l = getLink(graph, s?.link);
      return l?.type ?? "*";
    }
    const first = s?.links?.[0];
    const l = first !== undefined ? getLink(graph, first) : null;
    return l?.type ?? "*";
  };

  const run = (pred, isFuzzy) => {
    for (const i of pending) {
      if (doneSrc.has(i)) continue;
      const want = srcTypeOf(i);

      let hit = -1;
      for (let j = 0; j < dstSlots.length; j++) {
        if (usedDst.has(j)) continue;
        if (!compatible(dstSlots[j]?.type, want)) continue;
        if (!pred(dstSlots[j], j, i)) continue;
        hit = j;
        break;
      }

      if (hit >= 0) {
        usedDst.add(hit);
        doneSrc.add(i);
        pairs.push({ from: i, to: hit });
        if (isFuzzy) {
          fuzzy.push({
            from: i,
            to: hit,
            srcName: srcSlots[i]?.name,
            dstName: dstSlots[hit]?.name,
          });
        }
      }
    }
  };

  run((n, _j, i) => n?.name === srcSlots[i]?.name, false); // 1 精确同名
  run((n, _j, i) => normName(n?.name) === normName(srcSlots[i]?.name), false); // 2 归一化同名
  run((_n, j, i) => j === i, true); // 3 同索引
  run((_n, j) => isEmptySlot(j), true); // 4 空槽优先
  run(() => true, false); // 5 任意兼容（会覆盖原有连线）

  for (const i of pending) {
    if (!doneSrc.has(i)) unmatched.push(i);
  }

  return { pairs, fuzzy, unmatched };
}

/* ============================================================
 * 三、核心：现成节点顶替旧节点
 * ============================================================ */

/**
 * 取某个槽位的数据类型（槽位没写就顺着线去取）
 */
function slotTypeOf(node, idx, isInput, graph) {
  const slot = (isInput ? node.inputs : node.outputs)?.[idx];
  if (slot?.type) return slot.type;
  if (isInput) {
    const l = getLink(graph, slot?.link);
    return l?.type ?? "*";
  }
  const first = slot?.links?.[0];
  const l = first !== undefined ? getLink(graph, first) : null;
  return l?.type ?? "*";
}

function typeKeyOf(t) {
  return typeTokens(t).sort().join(",");
}

/**
 * 旧节点上「悬空」的输入线：同类型的出口在它身上确实存在，却一个下游都没接。
 * 这种线留着只是画布上飘着一截，什么也喂不出去 —— 直接断掉。
 *
 * 判断标准刻意保守：
 *   · 节点根本没有这种出口（保存/预览这类终点节点）→ 不碰
 *   · 出口还有下游 → 不碰（这条输入是活链路的一部分）
 *   · 有出口但空着 → 这条输入是死线
 *
 * @param {LGraphNode} node 被替换后留下的旧节点
 * @param {object} graph
 * @param {Set<string>} [onlyKeys] 只认这些类型（typeKeyOf 的 key）
 * @returns {Array<{slot:number,key:string,type:string}>}
 */
function danglingInputs(node, graph, onlyKeys) {
  const g = graph ?? app.graph;
  const outs = node?.outputs ?? [];
  if (!outs.length) return []; // 没有出口的终点节点，绝不碰它的输入

  const outLive = new Map(); // key -> 这个出口还剩几条下游
  outs.forEach((s, i) => {
    const key = typeKeyOf(slotTypeOf(node, i, false, g));
    outLive.set(key, (outLive.get(key) ?? 0) + (Array.isArray(s?.links) ? s.links.length : 0));
  });

  const out = [];
  (node.inputs ?? []).forEach((s, i) => {
    if (s?.link === null || s?.link === undefined) return;
    const type = slotTypeOf(node, i, true, g);
    const key = typeKeyOf(type);
    if (!outLive.has(key)) return; // 这节点没有这种出口，不碰
    if (outLive.get(key) > 0) return; // 出口还在用，这条输入是活的
    if (onlyKeys && !onlyKeys.has(key)) return;
    out.push({ slot: i, key, type: String(type) });
  });
  return out;
}

/** 真的把悬空输入断掉，返回断掉的清单 */
function cutDanglingInputs(node, graph, onlyKeys) {
  const list = danglingInputs(node, graph, onlyKeys);
  const cut = [];
  for (const c of list) {
    try {
      node.disconnectInput(c.slot);
      cut.push(c);
    } catch (err) {
      console.warn(LOG, "断开悬空输入失败", c.slot, err);
    }
  }
  return cut;
}

/** 把断掉的线念成人话：「CLIP」「CLIP、VAE」 */
function cutLabel(cut) {
  const uniq = [];
  for (const c of cut) if (!uniq.includes(c.type)) uniq.push(c.type);
  return uniq.join("、");
}

/** 这个口子上真的挂着线吗（输入看 link，输出看 links） */
function slotHasLine(node, idx, isInput, graph) {
  const slot = (isInput ? node?.inputs : node?.outputs)?.[idx];
  if (!slot) return false;
  if (isInput) return getLink(graph, slot.link) !== null;
  const ids = Array.isArray(slot.links) ? slot.links : [];
  return ids.some((id) => getLink(graph, id));
}

/**
 * 规划一次替换：哪些线能搬、哪些搬不动。
 *
 * 规矩：**同一数据类型的线整组处理**。CLIP 的输入能搬、输出搬不动时，
 * 不搬输入 —— 否则旧节点的 CLIP 输出就成了无源，下游直接断供。
 * 整组先留在旧节点上，再由 spliceStuck 试着从上游直连下游把它绕过去；
 * 绕不过去（输入不唯一 / 上游没有）才真的原样留着。
 */
function planTransfer(oldNode, newNode, graph) {
  const inMatch = matchSlots(oldNode, newNode, true, graph);
  const outMatch = matchSlots(oldNode, newNode, false, graph);

  const stuck = new Map();
  const markStuck = (idx, isInput) => {
    // 这个口子本来就没接线 → 没有线要搬，不算「卡住」，也别去报告里凑数
    if (!slotHasLine(oldNode, idx, isInput, graph)) return;
    const type = slotTypeOf(oldNode, idx, isInput, graph);
    const key = typeKeyOf(type);
    const e = stuck.get(key)
      ?? { key, type: String(type), sides: new Set(), inSlots: [], outSlots: [] };
    e.sides.add(isInput ? "in" : "out");
    (isInput ? e.inSlots : e.outSlots).push(idx);
    stuck.set(key, e);
  };
  for (const i of inMatch.unmatched) markStuck(i, true);
  for (const i of outMatch.unmatched) markStuck(i, false);

  const keyOf = (idx, isInput) => typeKeyOf(slotTypeOf(oldNode, idx, isInput, graph));
  const inPairs = inMatch.pairs.filter((p) => !stuck.has(keyOf(p.from, true)));
  const outPairs = outMatch.pairs.filter((p) => !stuck.has(keyOf(p.from, false)));

  /* ---- 死线不算卡住 ----
     只卡在输入侧、且旧节点这类出口本来就空着（没下游）时，
     这条线留着毫无意义，替换完直接断掉即可 —— 不用问、不用警告。 */
  const dead = [];
  for (const [key, e] of [...stuck]) {
    const onlyIn = e.sides.size === 1 && e.sides.has("in");
    if (!onlyIn) continue;
    const dangling = danglingInputs(oldNode, graph, new Set([key]));
    if (!dangling.length) continue;
    dead.push({ ...e, slots: dangling });
    stuck.delete(key);
  }

  return { inMatch, outMatch, inPairs, outPairs, stuck: [...stuck.values()], dead };
}

/** 快照旧节点现有的连线（断开之后就取不到了） */
function snapshotLinks(oldNode, graph) {
  const ins = [];
  (oldNode.inputs ?? []).forEach((slot, i) => {
    const l = getLink(graph, slot?.link);
    if (!l) return;
    ins.push({ index: i, originId: l.origin_id, originSlot: l.origin_slot });
  });

  const outs = [];
  (oldNode.outputs ?? []).forEach((slot, i) => {
    for (const id of Array.isArray(slot?.links) ? [...slot.links] : []) {
      const l = getLink(graph, id);
      if (!l) continue;
      outs.push({ index: i, targetId: l.target_id, targetSlot: l.target_slot });
    }
  });

  return { ins, outs };
}

/**
 * 搬不动的类型：直接从上游接到下游，把这个节点从那条路上摘出去。
 *
 * 为什么必须有这一步（v3.11 之前没有，实际用出来的问题）：
 *   某一类数据从上游进来、再从它出去，中间这个节点换成了没有这类口的节点。
 *   旧做法是「整组留在旧节点上」—— 图确实没断，但旧节点还挂在这条路上
 *   继续加工，用户以为它已经被换掉了，其实它仍在生效；而且它身上还挂着线，
 *   看着就不像「被替换」，像是没换干净。
 *   也不能直接剪：剪了下游立刻断供。唯一正确的结果是两头接起来，
 *   让数据从旧节点旁边绕过去（等价于只对这一类做一次「从连线中分离」）。
 *
 * 取线一律从替换前的快照里找**这类数据的全部线**（不只是没匹配上的那几个口）：
 * 一个类型只要有一头搬不动，按规矩整类都留在旧节点上，所以两头都还在。
 *
 * 只在两头都唯一时动手：
 *   · 这类输入正好 1 条（多条不知道该用哪条喂下游）
 *   · 这类输出至少 1 条（没有就说明下游根本没人要，属于死线，另走 cutDangling）
 * 不满足就一律不动 —— 那已经超出「搬线」的范围，留给用户。
 *
 * @returns {{spliced:number, pairs:Array, left:Array}}
 */
function spliceStuck(oldNode, newNode, snap, plan, graph) {
  const res = { spliced: 0, pairs: [], left: [] };
  const keyAt = (idx, isInput) => typeKeyOf(slotTypeOf(oldNode, idx, isInput, graph));

  for (const e of plan.stuck ?? []) {
    const srcRecs = (snap.ins ?? []).filter((r) => keyAt(r.index, true) === e.key);
    const outRecs = snap.outs ?? [];
    const dstRecs = outRecs.filter((r) => keyAt(r.index, false) === e.key);

    if (srcRecs.length > 1) {
      res.left.push({ type: e.type, why: `这类输入有 ${srcRecs.length} 条，不知道用哪条` });
      continue;
    }
    if (!srcRecs.length) {
      res.left.push({ type: e.type, why: "上游没有这类线，数据是它自己产出的" });
      continue;
    }
    if (!dstRecs.length) {
      res.left.push({ type: e.type, why: "下游没有这类线" });
      continue;
    }

    const src = srcRecs[0];
    if (src.originId === newNode.id) {
      res.left.push({ type: e.type, why: "上游就是替换者自己" });
      continue;
    }
    const srcNode = graph.getNodeById(src.originId);
    if (!srcNode) {
      res.left.push({ type: e.type, why: "上游节点找不到了" });
      continue;
    }

    let ok = 0;
    let bad = 0;
    for (const rec of dstRecs) {
      if (rec.targetId === newNode.id) continue; // 防止自连
      const tgt = graph.getNodeById(rec.targetId);
      if (!tgt) {
        bad++;
        continue;
      }
      try {
        srcNode.connect(src.originSlot, tgt, rec.targetSlot);
        ok++;
        res.pairs.push({
          type: String(e.type),
          from: `${displayName(srcNode)}#${srcNode.id}.out[${src.originSlot}]`,
          to: `${displayName(tgt)}#${tgt.id}.${tgt.inputs?.[rec.targetSlot]?.name ?? "in"}`,
        });
      } catch (err) {
        console.warn(LOG, "旁路直连失败", e.type, src.originSlot, "→", rec.targetId, rec.targetSlot, err);
        bad++;
      }
    }

    if (!ok) {
      res.left.push({ type: e.type, why: "上游接不到下游" });
      continue;
    }
    res.spliced += ok;

    // 旧节点这两头的线撤掉（下游那几根已经在上面改接到上游了）
    for (const rec of srcRecs) {
      try {
        oldNode.disconnectInput(rec.index);
      } catch (err) {
        /* ignore */
      }
    }
    if (!bad) {
      for (const rec of dstRecs) {
        try {
          oldNode.disconnectOutput(rec.index);
        } catch (err) {
          /* ignore */
        }
      }
    }
  }

  return res;
}

/**
 * @param {LGraphNode} oldNode 被替换的节点（线会被搬走，节点保留）
 * @param {LGraphNode} newNode 替换者（画布上已有的节点）
 * @param {string} [note] 额外补一句提示（方向自动判断时会带上）
 * @returns {boolean}
 */
function replaceWithNode(oldNode, newNode, note) {
  const graph = app.graph;
  if (!graph || !oldNode || !newNode) return false;

  if (oldNode === newNode || oldNode.id === newNode.id) {
    toast("warn", "不能自己替换自己", "请选中另外两个节点。", 3500);
    return false;
  }

  closeChoice();

  const snap = snapshotLinks(oldNode, graph);
  const plan = planTransfer(oldNode, newNode, graph);

  /* 不再有「口子对不上就取消」和「接不上要确认」这两道关：
     只要点了替换就动图，能搬的搬、搬不动的按类型旁路直连（见 executeReplace），
     结果写进提示和报告。图不会因为这类事停在半路。 */
  return executeReplace(oldNode, newNode, snap, plan, note);
}

/** 真正动手：位置互换 + 按规划搬线 */
function executeReplace(oldNode, newNode, snap, plan, note) {
  const graph = app.graph;
  if (!graph) return false;

  const { ins: inputSnap, outs: outputSnap } = snap;
  const oldPos = [oldNode.pos[0], oldNode.pos[1]];
  const newPos = [newNode.pos[0], newNode.pos[1]];

  // 动手前先留一份原始接线，报告里用来对比
  const beforeText = dumpText([oldNode, newNode], graph);

  beginChange();

  try {
    /* ---- 1. 位置互换：新节点站到旧节点的走线位置，旧节点退到一旁 ---- */
    newNode.pos = [oldPos[0], oldPos[1]];
    oldNode.pos = [newPos[0], newPos[1]];

    /* ---- 2. 输入侧：旧节点吃进来的线，转给替换者 ---- */
    let inDone = 0;
    let inFail = 0;
    let overwritten = 0;

    for (const { from, to } of plan.inPairs) {
      const rec = inputSnap.find((x) => x.index === from);
      if (!rec) continue;
      if (rec.originId === newNode.id) continue; // 防止自连

      const srcNode = graph.getNodeById(rec.originId);
      if (!srcNode) {
        inFail++;
        continue;
      }

      // 替换者该输入位已有连线 → 以旧节点的接线关系为准，先断开
      try {
        const existing = newNode.inputs?.[to]?.link;
        if (existing !== null && existing !== undefined) {
          newNode.disconnectInput(to);
          overwritten++;
        }
      } catch (err) {
        /* ignore */
      }

      // 先把旧节点这一路断开，线才能让给替换者
      try {
        oldNode.disconnectInput(from);
      } catch (err) {
        /* ignore */
      }

      try {
        srcNode.connect(rec.originSlot, newNode, to);
        inDone++;
      } catch (err) {
        console.warn(LOG, "输入连接失败", from, "→", to, err);
        inFail++;
      }
    }
    // 注：matchSlots 里没找到落点的那几条，都已在 plan.stuck 里，
    // 属于「整组留在旧节点上」，不算失败，所以这里不加进 inFail。

    /* ---- 3. 输出侧：旧节点送出去的线，转给替换者 ---- */
    let outDone = 0;
    let outFail = 0;

    for (const { from, to } of plan.outPairs) {
      const recs = outputSnap.filter((x) => x.index === from);

      // 断开旧节点这一路输出，把下游让给替换者
      try {
        oldNode.disconnectOutput(from);
      } catch (err) {
        /* ignore */
      }

      for (const rec of recs) {
        if (rec.targetId === newNode.id) continue; // 防止自连
        const tgtNode = graph.getNodeById(rec.targetId);
        if (!tgtNode) {
          outFail++;
          continue;
        }
        try {
          newNode.connect(to, tgtNode, rec.targetSlot);
          outDone++;
        } catch (err) {
          console.warn(LOG, "输出连接失败", from, "→", to, err);
          outFail++;
        }
      }
    }
    // 同上：没落点的已在 plan.stuck 里，不算失败。

    /* ---- 4. 收尾（旧节点保留在画布上，只断了线） ---- */
    // 新节点没有这类口子（搬不动），但旧节点这一进一出是通的 →
    // 直接把上游接到下游，让数据从旧节点旁边绕过去。
    // 必须在 cutDangling 之前：先接通，再判断哪些线真的没人要。
    const splice = spliceStuck(oldNode, newNode, snap, plan, graph);

    // 留在旧节点上的线里，出口本来就空着的那几条是死线，直接断掉
    const cutDead = cutDanglingInputs(oldNode, graph, new Set(plan.dead.map((d) => d.key)));

    // 新节点多出来的输出口（旧节点上根本没有对应的线可搬，比如新节点多一类口）：
    // 去旧节点的下游找落点。必须在补输入之前做 ——
    // 补输入那边的 canOut 检查要靠这一步先把出口接上。
    const topOut = topUpOutputs(newNode, snap, graph);

    // 新节点上还空着、但能从已供料的源节点补上的数据口，顺手接上
    const top = topUpInputs(newNode, graph);

    newNode.setDirtyCanvas?.(true, true);
    oldNode.setDirtyCanvas?.(true, true);
    graph.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);

    try {
      app.canvas?.selectNode?.(newNode, false);
    } catch (err) {
      try {
        if (app.canvas) app.canvas.selected_nodes = { [newNode.id]: newNode };
      } catch (err2) {
        /* ignore */
      }
    }

    /* ---- 汇总提示 ---- */
    const transferTotal = inputSnap.length + outputSnap.length;
    const parts = [`连线 输入 ${inDone}/${inputSnap.length} · 输出 ${outDone}/${outputSnap.length}`];
    if (overwritten) parts.push(`覆盖了替换者原有 ${overwritten} 条输入线`);
    if (splice.spliced) {
      const types = [...new Set(splice.pairs.map((p) => p.type))].join("、");
      parts.push(`${types} 改成了上游直连下游（旧节点不在这条线上了）`);
    }
    if (splice.left.length) {
      parts.push(`没动的：${splice.left.map((l) => `${l.type}（${l.why}）`).join("、")}`);
    }
    if (cutDead.length) parts.push(`断开了 ${cutDead.length} 条没下游的悬空线（${cutLabel(cutDead)}）`);
    if (topOut.added) {
      parts.push(`下游补连 ${topOut.added} 条（${topOut.pairs.filter((p) => p.how === "补空").map((p) => p.type).join("、")}）`);
    }
    if (topOut.bridged) {
      parts.push(`改接 ${topOut.bridged} 条到新节点（${topOut.pairs.filter((p) => p.how === "改接").map((p) => p.type).join("、")}，原先直接绕过它的）`);
    }
    if (top.added) parts.push(`补连 ${top.added} 条空口（${top.pairs.map((p) => p.type).join("、")}）`);

    // 补进来的类型里，出口还没下游的（数据进得来出不去）
    const deadEndTypes = [...new Set(top.pairs.map((p) => p.type))].filter((t) => {
      const outs = (newNode.outputs ?? []).filter((s) => compatible(s?.type, t));
      return outs.length > 0 && outs.every((s) => !(Array.isArray(s.links) && s.links.length));
    });
    if (deadEndTypes.length) parts.push(`${deadEndTypes.join("、")} 出口还没接下游，要手动接`);
    parts.push(transferTotal ? "旧节点已保留，位置互换完成" : "两边都没有连线，只互换了位置");

    /* ---- 导出报告：出问题时粘出来就能定位 ---- */
    const reportCopied = publishReport(
      "替换",
      `${displayName(oldNode)}#${oldNode.id} → ${displayName(newNode)}#${newNode.id}`,
      [
        `结果：搬过去 输入 ${inDone}/${inputSnap.length} · 输出 ${outDone}/${outputSnap.length}`
          + ` · 旁路直连 ${splice.pairs.length} · 原样留下 ${splice.left.length}`,
        `可搬槽位：in=${JSON.stringify(plan.inPairs)} out=${JSON.stringify(plan.outPairs)}`,
        `旁路直连（上游 → 下游）：${splice.pairs.length
          ? splice.pairs.map((p) => `${p.type} ${p.from} → ${p.to}`).join("、")
          : "无"}`,
        `原样留在旧节点上：${splice.left.length
          ? splice.left.map((l) => `${l.type}（${l.why}）`).join("、")
          : "无"}`,
        `断开的悬空线：${cutDead.length ? `${cutLabel(cutDead)}（${cutDead.length} 条）` : "无"}`,
        `覆盖替换者原有输入线：${overwritten} 条`,
        `下游补连：${topOut.pairs.length ? topOut.pairs.map((p) => `${p.how} ${p.type} → ${p.to}`).join("、") : "无"}`,
        `补连空口（上游 → 新节点）：${top.added ? top.pairs.map((p) => `${p.from} → ${p.to}`).join("、") : "无"}`,
        "",
        "【替换前】",
        beforeText,
        "【替换后】",
        dumpText([oldNode, newNode], graph),
      ],
    );
    if (reportCopied) parts.push("连线报告已复制到剪贴板");

    const softWarn = plan.inMatch.fuzzy.length + plan.outMatch.fuzzy.length;

    if (inFail <= 0 && outFail <= 0) {
      if (!transferTotal) {
        toast(
          "info",
          "只互换了位置",
          `${displayName(oldNode)} ↔ ${displayName(newNode)}　·　两个节点都没有连线，没有线要搬`,
          4000,
        );
      } else if (splice.left.length) {
        const summary = note ? `${note} · ${parts.join(" · ")}` : parts.join(" · ");
        toast("warn", `已用 ${displayName(newNode)} 替换`, summary, 9000);
      } else {
        const summary = note ? `${note} · ${parts.join(" · ")}` : parts.join(" · ");
        toast("success", `已用 ${displayName(newNode)} 替换`, summary, 4500);
      }
    } else {
      parts.push(`没接上 ${inFail + outFail} 条`);
      if (softWarn) parts.push(`${softWarn} 处为近似匹配，请复核`);
      const summary = note ? `${note} · ${parts.join(" · ")}` : parts.join(" · ");
      toast("warn", "替换完成，但部分连线没接上", summary, 9000);
    }

    console.log(LOG, `替换 ${oldNode.type} → ${newNode.type}`, {
      input: plan.inMatch,
      output: plan.outMatch,
      moved: { in: plan.inPairs, out: plan.outPairs },
      spliced: splice.pairs,
      leftOnOld: splice.left,
      overwritten,
    });

    return true;
  } catch (err) {
    console.error(LOG, "替换过程中出错", err);
    toast("error", "替换失败", String(err?.message ?? err));
    return false;
  } finally {
    endChange();
  }
}

/* ============================================================
 * 四、替换模式（点选式交互）
 *
 *   右键旧节点 → 进入替换模式（旧节点高亮 + 顶部提示条）
 *   → 左键点一下要用的那个节点，立即完成替换
 *   → Esc / 右键 / 点空白 取消
 * ============================================================ */

const BAR_ID = "cnr-armed-bar";
const STYLE_ID = "cnr-armed-style";

const ARMED_CSS = `
#cnr-armed-bar {
  position: fixed;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 99999;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-radius: 9px;
  border: 1px solid #ff7a45;
  background: var(--comfy-menu-bg, #1f1f23);
  color: var(--input-text, #eaeaea);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12.5px;
  box-shadow: 0 8px 26px rgba(0,0,0,0.45), 0 0 0 3px rgba(255,122,69,0.14);
  pointer-events: none;
  user-select: none;
  animation: cnr-in 0.14s ease-out;
}
@keyframes cnr-in {
  from { opacity: 0; transform: translateX(-50%) translateY(-6px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
#cnr-armed-bar .cnr-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #ff7a45;
  box-shadow: 0 0 0 0 rgba(255,122,69,0.7);
  animation: cnr-pulse 1.1s infinite;
  flex: none;
}
@keyframes cnr-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(255,122,69,0.65); }
  70%  { box-shadow: 0 0 0 7px rgba(255,122,69,0); }
  100% { box-shadow: 0 0 0 0 rgba(255,122,69,0); }
}
#cnr-armed-bar .cnr-msg { font-size: 13px; font-weight: 600; }
#cnr-armed-bar .cnr-body { display: flex; flex-direction: column; gap: 3px; }
#cnr-armed-bar .cnr-sub {
  font-size: 11px;
  opacity: 0.62;
  max-width: 56vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#cnr-armed-bar .cnr-key {
  display: inline-block;
  padding: 0 4px;
  margin: 0 1px;
  border: 1px solid rgba(140,140,140,0.45);
  border-radius: 3px;
  font-size: 10px;
  line-height: 14px;
}
/* 版本号：一眼确认浏览器加载的是哪一版，排查缓存用 */
#cnr-armed-bar .cnr-ver {
  align-self: flex-start;
  font-size: 10px;
  opacity: 0.34;
  letter-spacing: 0.02em;
}

/* ---- 方向选择条（两个节点都有连线时弹出） ---- */
#cnr-choice {
  position: fixed;
  z-index: 100000;
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 11px 12px 9px;
  border-radius: 10px;
  border: 1px solid #ff7a45;
  background: var(--comfy-menu-bg, #1f1f23);
  color: var(--input-text, #eaeaea);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12.5px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.5), 0 0 0 3px rgba(255,122,69,0.14);
  user-select: none;
  animation: cnr-in-choice 0.12s ease-out;
}
@keyframes cnr-in-choice {
  from { opacity: 0; transform: translateY(-5px); }
  to   { opacity: 1; transform: translateY(0); }
}
#cnr-choice .cnr-choice-title {
  font-size: 12px;
  font-weight: 700;
  opacity: 0.92;
  margin-bottom: 1px;
}
#cnr-choice .cnr-choice-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  width: 100%;
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid rgba(255,122,69,0.45);
  background: rgba(255,122,69,0.09);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
}
#cnr-choice .cnr-choice-btn:hover {
  background: rgba(255,122,69,0.2);
  border-color: #ff7a45;
}
#cnr-choice .cnr-choice-btn .cnr-choice-main { font-weight: 600; }
#cnr-choice .cnr-choice-btn .cnr-choice-sub {
  font-size: 11px;
  opacity: 0.6;
  line-height: 1.35;
}
#cnr-choice .cnr-choice-hint {
  font-size: 11px;
  opacity: 0.5;
  margin-top: 1px;
}
#cnr-choice .cnr-choice-hint b { font-weight: 600; opacity: 0.85; }

`;

let armed = null; // { oldNodes, handler, keyHandler, el }

function ensureArmedStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = ARMED_CSS;
  document.head.appendChild(s);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function canvasElement() {
  try {
    return app.canvasEl ?? app.canvas?.canvas ?? null;
  } catch (err) {
    return null;
  }
}

/** 用画布的 ds（缩放 / 平移）把屏幕坐标换算成图坐标，再取该位置的节点 */
function pickNodeAt(e, el) {
  const cnv = app.canvas;
  const graph = app.graph;
  if (!cnv || !graph) return null;

  try {
    const rect = el.getBoundingClientRect();
    const ds = cnv.ds ?? { scale: 1, offset: [0, 0] };
    const scale = ds.scale || 1;
    const ox = ds.offset?.[0] ?? 0;
    const oy = ds.offset?.[1] ?? 0;

    const gx = (e.clientX - rect.left) / scale - ox;
    const gy = (e.clientY - rect.top) / scale - oy;

    // 用全量节点表更稳（getNodeOnPos 内部会反序遍历，后添加的在上层）
    const nodes = graph._nodes ?? cnv.visible_nodes;
    return graph.getNodeOnPos?.(gx, gy, nodes, 0) ?? null;
  } catch (err) {
    console.warn(LOG, "点击定位失败", err);
    return null;
  }
}

function showArmedBar(oldNodes) {
  document.getElementById(BAR_ID)?.remove();
  ensureArmedStyle();

  const names = oldNodes.map((n) => n.title || n.type);
  const preview =
    names.length <= 2
      ? names.join("、")
      : `${names.slice(0, 2).join("、")} 等 ${names.length} 个`;
  // 多选时点一个「有线」的节点 = 串成链，提前说一声，单选时不加字
  const chainHint = oldNodes.length > 1 ? tr("　·　多个节点将按从左到右串成一条链") : "";

  const bar = document.createElement("div");
  bar.id = BAR_ID;
  bar.innerHTML = `
    <span class="cnr-dot"></span>
    <div class="cnr-body">
      <div class="cnr-msg">${tr("左键点另一个节点，立即替换")}</div>
      <div class="cnr-sub">
        ${tr("已选：")}${escapeHtml(preview)}${chainHint}　·　${tr("取消：")}<span class="cnr-key">Esc</span> / ${tr("右键 / 点空白")}
      </div>
    </div>
    <span class="cnr-ver">v${VERSION}</span>
  `;
  document.body.appendChild(bar);
}

/* ============================================================
 * 四·五、方向选择条
 *
 *   两个节点身上都有连线时，"谁接管谁的线"没有唯一答案，
 *   这时在鼠标位置弹一个小面板，两行按钮，Enter 选第一项。
 * ============================================================ */

const CHOICE_ID = "cnr-choice";
const CHOICE_TIMEOUT = 25000;
let choice = null; // { root, onDown, onKey, timer }

function closeChoice() {
  if (!choice) return;
  const { root, onDown, onKey, timer } = choice;
  choice = null;
  try {
    clearTimeout(timer);
  } catch (err) {
    /* ignore */
  }
  document.removeEventListener("pointerdown", onDown, true);
  window.removeEventListener("keydown", onKey, true);
  try {
    root?.remove();
  } catch (err) {
    /* ignore */
  }
}

/* v3.11 起：没有「先问一句」的确认条了。替换是你决定的事，
   问一句只是多一步 —— 该说的都写在完成提示和连线报告里。 */

/** 面板贴着鼠标出现，靠边就翻到另一侧，别出屏幕 */
function placeNearMouse(root, at) {
  try {
    const rect = root.getBoundingClientRect();
    const px = at?.x ?? window.innerWidth / 2;
    const py = at?.y ?? window.innerHeight / 2;
    let left = px + 14;
    let top = py + 14;
    if (left + rect.width > window.innerWidth - 8) left = px - rect.width - 14;
    if (top + rect.height > window.innerHeight - 8) top = py - rect.height - 14;
    root.style.left = `${Math.max(8, Math.round(left))}px`;
    root.style.top = `${Math.max(8, Math.round(top))}px`;
  } catch (err) {
    /* ignore */
  }
}

/**
 * 两边都有连线、**又不是一前一后**时，问一句「往哪边接」。
 *
 * ★ v3.12：一前一后（同一条链上）不再走这里，也不弹任何面板 ——
 *   那种情况下唯一站得住的动作就是交换顺序，只有一种可能就不该让人选。
 *   `routeReplace` 那里直接调 `swapOrder`。
 *
 * 这里剩下的只有「并行分支」：两个节点互不上下游，各带各的线，
 * 那才真有「往哪边接」这个问题要问。
 *
 * @param {LGraphNode} armedNode 先右键选中的那个
 * @param {LGraphNode} clickedNode 后点的那个
 * @param {{x:number,y:number}} [at] 鼠标位置（屏幕坐标），用来定位面板
 */
function askDirection(armedNode, clickedNode, at) {
  closeChoice();
  ensureArmedStyle();

  const nameA = displayName(armedNode);
  const nameB = displayName(clickedNode);
  const cntA = linkCountOf(armedNode);
  const cntB = linkCountOf(clickedNode);

  // 两项都是「替换」：线全交给对面，自己留在画布上（线清空，要清掉自己按 Delete）。
  // 别写「跳过 / 摘掉」——节点并没有被摘掉，措辞得和实际动作一致。
  const names = { A: escapeHtml(nameA), B: escapeHtml(nameB) };
  const mainFirst = fillTpl(tr("用「{B}」替换「{A}」"), names);
  const mainSecond = fillTpl(tr("用「{A}」替换「{B}」"), names);

  const root = document.createElement("div");
  root.id = CHOICE_ID;
  root.innerHTML = `
    <div class="cnr-choice-title">${tr("两个节点都有连线，往哪边接？")}</div>
    <button class="cnr-choice-btn" data-pick="first">
      <span class="cnr-choice-main">${mainFirst}</span>
      <span class="cnr-choice-sub">${fillTpl(
        tr("{A}（{NA} 根线）全交给 {B}（{NB} 根线），{A} 留在画布上"),
        { ...names, NA: cntA, NB: cntB }
      )}</span>
    </button>
    <button class="cnr-choice-btn" data-pick="second">
      <span class="cnr-choice-main">${mainSecond}</span>
      <span class="cnr-choice-sub">${fillTpl(
        tr("{B}（{NB} 根线）全交给 {A}（{NA} 根线），{B} 留在画布上"),
        { ...names, NA: cntA, NB: cntB }
      )}</span>
    </button>
    <div class="cnr-choice-hint"><b>Enter</b> ${tr("第一项")}　·　<b>Esc</b> ${tr("取消")}</div>
  `;
  document.body.appendChild(root);

  /* ---- 定位：贴着鼠标，别出屏幕 ---- */
  placeNearMouse(root, at);

  const run = (which) => {
    closeChoice();
    if (which === "second") replaceWithNode(clickedNode, armedNode, "方向：按你选的来（反接）");
    else replaceWithNode(armedNode, clickedNode, "");
  };

  const onDown = (e) => {
    if (root.contains(e.target)) return; // 点面板内部交给按钮自己处理
    closeChoice(); // 点别处 = 放弃
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeChoice();
      return;
    }
    if (e.key === "Enter" || e.key === "NumpadEnter") {
      e.preventDefault();
      e.stopPropagation();
      run("first");
    }
  };

  root.addEventListener("click", (e) => {
    const btn = e.target?.closest?.(".cnr-choice-btn");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    run(btn.dataset.pick);
  });

  document.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKey, true);

  choice = {
    root,
    onDown,
    onKey,
    timer: setTimeout(() => closeChoice(), CHOICE_TIMEOUT),
  };
}

/**
 * 多选、又点了一个节点时，问这次怎么换：
 *   合并成一个（一换多）／ 每个各换一个同款（一 一 一）
 *
 * @param {LGraphNode[]} nodes 选中的那批（都有连线）
 * @param {LGraphNode} newNode 后点的那个
 * @param {{x:number,y:number}} [at]
 */
function askMode(nodes, newNode, at) {
  closeChoice();
  ensureArmedStyle();

  const count = nodes.length;
  const nameNew = displayName(newNode);

  const root = document.createElement("div");
  root.id = CHOICE_ID;
  root.innerHTML = `
    <div class="cnr-choice-title">${fillTpl(tr("选中的 {N} 个节点，怎么换？"), { N: count })}</div>
    <button class="cnr-choice-btn" data-pick="merge">
      <span class="cnr-choice-main">${fillTpl(tr("合并成一个 · 用「{X}」顶掉这 {N} 个"), {
        X: escapeHtml(nameNew),
        N: count,
      })}</span>
    </button>
    <button class="cnr-choice-btn" data-pick="split">
      <span class="cnr-choice-main">${tr("分别替换 · 每个都换成同款")}</span>
    </button>
    <div class="cnr-choice-hint"><b>Enter</b> ${tr("第一项")}　·　<b>Esc</b> ${tr("取消")}</div>
  `;
  document.body.appendChild(root);

  /* ---- 定位：贴着鼠标，别出屏幕 ---- */
  placeNearMouse(root, at);
  
  const run = (which) => {
    closeChoice();
    if (which === "merge") mergeReplace(nodes, newNode);
    else batchReplace(nodes, newNode);
  };

  const onDown = (e) => {
    if (root.contains(e.target)) return;
    closeChoice(); // 点别处 = 放弃
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeChoice();
      return;
    }
    if (e.key === "Enter" || e.key === "NumpadEnter") {
      e.preventDefault();
      e.stopPropagation();
      run("merge");
    }
  };

  root.addEventListener("click", (e) => {
    const btn = e.target?.closest?.(".cnr-choice-btn");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    run(btn.dataset.pick);
  });

  document.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKey, true);

  choice = {
    root,
    onDown,
    onKey,
    timer: setTimeout(() => closeChoice(), CHOICE_TIMEOUT),
  };
}

/* ============================================================
 * 待替换节点的橙点标记（不写进工作流）
 * ------------------------------------------------------------
 * 那个橙点其实是 litegraph 的「标题框颜色点」：优先取 node.boxcolor，
 * 取不到才用主题默认色。v3.13.0 之前直接改 node.boxcolor ——
 * 但 boxcolor 是会被序列化进工作流的字段（保存 / 自动保存 / 导出都会带上），
 * 标记期间只要存过一次，橙点就永久留在节点上，连撤销都回不来。
 * 现在改成临时覆盖绘制方法：只影响画面，serialize 里不会出现任何痕迹。
 * ============================================================ */

const MARK_STATE = Symbol("cnr-mark");

function markNode(n) {
  if (!n || n[MARK_STATE]) return;
  const had = Object.prototype.hasOwnProperty.call(n, "onDrawTitleBox");
  const prev = n.onDrawTitleBox;
  n[MARK_STATE] = { had, prev };

  n.onDrawTitleBox = function (ctx, opts) {
    if (typeof prev === "function") {
      try {
        prev.call(this, ctx, opts);
      } catch (err) {
        /* ignore */
      }
    }
    const o = opts || {};
    const LGg = LG();
    const h =
      typeof o.title_height === "number"
        ? o.title_height
        : (LGg && LGg.NODE_TITLE_HEIGHT) || 30;
    const size = typeof o.box_size === "number" ? o.box_size : 10;
    try {
      ctx.beginPath();
      ctx.fillStyle = MARK_COLOR;
      ctx.arc(h * 0.5, h * -0.5, size * 0.5, 0, Math.PI * 2);
      ctx.fill();
    } catch (err) {
      /* ignore */
    }
  };

  n.setDirtyCanvas?.(true, true);
  return true;
}

function unmarkNode(n) {
  const st = n?.[MARK_STATE];
  if (!st) return false;
  try {
    if (st.had) n.onDrawTitleBox = st.prev;
    else delete n.onDrawTitleBox;
  } catch (err) {
    /* ignore */
  }
  delete n[MARK_STATE];
  n.setDirtyCanvas?.(true, true);
  return true;
}

/** 清掉老版本写进 node.boxcolor 的橙点（已被存进工作流的那些） */
function cleanBakedMarks(graph) {
  let count = 0;
  for (const n of graph?._nodes ?? []) {
    if (!n) continue;
    if (String(n.boxcolor ?? "").toLowerCase() === MARK_COLOR) {
      n.boxcolor = null;
      n.setDirtyCanvas?.(true, true);
      count++;
    }
  }
  return count;
}

function disarm() {
  if (!armed) return;
  const { oldNodes, handler, keyHandler, el } = armed;
  armed = null;
  closeChoice();

  if (el) {
    try {
      el.removeEventListener("pointerdown", handler, true);
      el.style.cursor = "";
    } catch (err) {
      /* ignore */
    }
  }
  if (keyHandler) window.removeEventListener("keydown", keyHandler, true);

  for (const n of oldNodes) {
    unmarkNode(n);
  }

  document.getElementById(BAR_ID)?.remove();
  app.canvas?.setDirty?.(true, true);
}

/** 进入替换模式：oldNodes 是即将被替换的节点集合 */
function arm(contextNode) {
  disarm(); // 保证单例
  closeChoice();

  const sel = selectedNodes();
  const selIds = new Set(sel.map((n) => n.id));

  let olds;
  if (contextNode && selIds.has(contextNode.id)) {
    // 右键的节点在选中集合里 → 整个选中集合都参与替换
    olds = sel;
  } else if (contextNode) {
    olds = [contextNode];
  } else {
    olds = sel;
  }

  olds = olds.filter(Boolean);
  if (!olds.length) {
    toast("info", "先选中要被替换的节点", "选中后再右键它。", 5000);
    return;
  }

  const el = canvasElement();
  if (!el) {
    toast("error", "找不到画布", "无法进入替换模式。");
    return;
  }

  /* ---- 高亮将被替换的节点（只画面，不写进工作流） ---- */
  cleanBakedMarks(app.graph);
  for (const n of olds) markNode(n);

  /* ---- 画布点击：选另一半 ---- */
  const handler = (e) => {
    if (e.button === 2) {
      disarm(); // 右键取消
      return;
    }
    if (e.button !== 0) return;

    const node = pickNodeAt(e, el);

    if (!node) {
      disarm(); // 点空白取消
      return;
    }

    // 点到的是已高亮的节点自身 → 忽略，继续等
    if (olds.some((o) => o.id === node.id)) {
      // 例外：正好框了两个一前一后的节点、又点了其中一个
      // → 这时只有「交换顺序」一种可能，直接做，不再弹面板问（v3.12）
      if (olds.length === 2 && orderPair(olds[0], olds[1], app.graph)) {
        const [x, y] = olds;
        disarm();
        swapOrder(x, y);
      }
      return;
    }

    const targets = [...olds];
    const at = { x: e.clientX, y: e.clientY };
    disarm();

    routeReplace(targets, node, at);
  };

  /* ---- Esc 取消 ---- */
  const keyHandler = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      disarm();
    }
  };

  el.addEventListener("pointerdown", handler, true);
  window.addEventListener("keydown", keyHandler, true);
  try {
    el.style.cursor = "crosshair";
  } catch (err) {
    /* ignore */
  }

  armed = { oldNodes: olds, handler, keyHandler, el };
  showArmedBar(olds);
  app.canvas?.setDirty?.(true, true);
}

/* ---- 方向判定：谁先谁后都行 ---- */

/**
 * 两次点选凑齐之后，按「谁身上有连线」决定谁被替换。
 *
 *   A = 先右键选中的，B = 后点的
 *   A 没线、B 有线  → 反过来：B 被替换，A 去顶替它
 *   A 有线、B 没线  → 正常：A 被替换，B 去顶替它
 *   两边都有线      → 一前一后就直接交换顺序（不弹面板）；
 *                     互不上下游才弹面板问「往哪边接」
 *   两边都没线      → 只互换位置
 *
 * @param {LGraphNode[]} olds 先选中的那批（已高亮）
 * @param {LGraphNode} clicked 后点的那个
 * @param {{x:number,y:number}} [at] 鼠标位置，给方向面板定位
 */
function routeReplace(olds, clicked, at) {
  if (!olds.length || !clicked) return false;

  /* ---- 多选：两种玩法 ---- */
  if (olds.length > 1) {
    const oldLinks = olds.reduce((sum, n) => sum + linkCountOf(n), 0);

    // (a) 选中的这批都没连线、点的那个有线 → 串成一条链顶替它
    if (oldLinks === 0 && linkCountOf(clicked) > 0) {
      return chainReplace(olds, clicked);
    }

    // (b) 选中的这批都没连线、点的那个也没线 → 没有线可以接管
    if (oldLinks === 0) {
      toast(
        "warn",
        "这批节点都没连线",
        "没有线可以接管。要么点一个有连线的节点让它串成链，"
          + "要么先框选要换掉的那批（它们得是有连线的）。",
        9000,
      );
      return false;
    }

    // (c) 这批有连线 → 问一句：合并成一个（一换多），还是每个各换一个同款
    askMode(olds, clicked, at);
    return true;
  }

  const a = olds[0];
  const b = clicked;
  if (a.id === b.id) return false;

  const linkA = linkCountOf(a);
  const linkB = linkCountOf(b);

  // 两边都没线：没什么可搬的，只换位置
  if (linkA === 0 && linkB === 0) {
    return replaceWithNode(a, b);
  }

  // 先选的那个没有线、后点的有线 → 自动反过来
  if (linkA === 0 && linkB > 0) {
    return replaceWithNode(b, a, "方向已自动反过来（有连线的一方才被接管）");
  }

  // 两边都有线
  if (linkA > 0 && linkB > 0) {
    // 一前一后（同一条链上）→ 只有「交换顺序」一种可能，直接做，不弹面板（v3.12）
    // 想真的用 B 顶替 A，只选一个节点再点另一个就行，那条路一直通。
    if (orderPair(a, b, app.graph)) {
      swapOrder(a, b);
      return true;
    }
    // 并行分支：两边的线各归各的，才真有「往哪边接」要问
    askDirection(a, b, at);
    return true;
  }

  // 常规：先选的被替换
  return replaceWithNode(a, b);
}

/* ---- 多选串联：几个没连线的节点串成一条链，整串顶替一个已连线的节点 ---- */

const CHAIN_GAP = 60;

/** 节点宽度，用来排位置 */
function widthOf(node) {
  const w = node?.size?.[0];
  return Number.isFinite(w) && w > 0 ? w : 240;
}

/** 在 node 上找一个「空着的、类型接得上」的槽位，返回下标或 -1 */
function findFreeSlot(node, isInput, type, used) {
  const slots = (isInput ? node.inputs : node.outputs) ?? [];
  for (let i = 0; i < slots.length; i++) {
    if (used?.has(i)) continue;
    const s = slots[i];
    if (!s) continue;
    const free = isInput ? s.link === null || s.link === undefined : (s.links?.length ?? 0) === 0;
    if (!free) continue;
    if (!compatible(s.type, type)) continue;
    return i;
  }
  return -1;
}

/* ============================================================
 * 补连：新节点上还空着的数据口，从「已经在给它供料的节点」补上
 * ============================================================ */

/* 参数类端口。这些是本地设置，自动接线只会添乱，一律不碰 */
const PARAM_TYPES = new Set(["FLOAT", "INT", "STRING", "BOOLEAN", "COMBO"]);

function isDataPort(slot) {
  if (!slot) return false;
  if (slot.widget) return false;
  return typeTokens(slot.type).every((x) => !PARAM_TYPES.has(String(x).toUpperCase()));
}

/**
 * 新节点的上游池，由近到远，只跟数据口走（参数口不算），最多 maxDepth 层。
 *
 * 为什么不能只看「直接给它供料的节点」：新节点要补的那个口常常不在第一层 ——
 * 直接上游压根没有这个类型的口，源头在它再上面一层。
 * 只看一层，这个口永远补不上。
 */
function upstreamPool(newNode, graph, maxDepth = 6) {
  const out = [];
  if (!newNode || !graph) return out;

  const seen = new Set([newNode.id]);
  let frontier = [newNode];

  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {
      for (const s of n.inputs ?? []) {
        if (!s || !isDataPort(s)) continue;
        const l = getLink(graph, s.link);
        if (!l) continue;
        const up = graph.getNodeById(l.origin_id);
        if (!up || seen.has(up.id)) continue;
        seen.add(up.id);
        out.push(up);
        next.push(up);
      }
    }
    frontier = next;
  }

  return out;
}

/**
 * 替换完成后调用：新节点上还空着、但能补的输入口，自动接上。
 *
 * 只从**当前已经在给它供料的节点**上取货 —— 也就是顺着已有的 upstream 走，
 * 比如 model 来自 #4，那 #4 的 CLIP 输出如果新节点吃得下、而且还没接，就补一条。
 * 不认识的节点一概不去碰，也不会去下游反向找。
 *
 * @returns {{added:number, pairs:Array<{from:string,to:string,type:string}>}}
 */
function topUpInputs(newNode, graph) {
  const res = { added: 0, pairs: [] };
  if (!newNode || !graph) return res;

  const slots = newNode.inputs ?? [];
  if (!slots.length) return res;

  // 上游池（含上上游）：clip 的源头往往不在直接上游那一层
  const sources = upstreamPool(newNode, graph, 6);
  if (!sources.length) return res;

  const taken = new Set();
  slots.forEach((s, i) => {
    if (s?.link !== null && s?.link !== undefined && s?.link !== -1) taken.add(i);
  });

  for (const src of sources) {
    (src.outputs ?? []).forEach((out, oi) => {
      if (!out?.type || !isDataPort(out)) return;

      // 这类数据在新节点上得能送出去，否则补进来是条死路（进来就断在里面）。
      // 注意：出口「有这个口但没接下游」也算能送 —— 先补上，之后在提示里
      // 点名它还没下游，比不补更实用（用户接上下游就通了）。
      const canOut = (newNode.outputs ?? []).some((s) => compatible(s?.type, out.type));
      if (!canOut) return;

      // 这个输出已经接到新节点上了？
      const ids = Array.isArray(out.links) ? out.links : [];
      const already = ids.some((id) => {
        const l = getLink(graph, id);
        return l && l.target_id === newNode.id;
      });
      if (already) return;

      const idx = slots.findIndex(
        (s, i) =>
          !taken.has(i)
          && (s?.link === null || s?.link === undefined || s?.link === -1)
          && isDataPort(s)
          && compatible(s?.type, out?.type),
      );
      if (idx < 0) return;

      taken.add(idx);
      try {
        src.connect(oi, newNode, idx);
        res.added++;
        res.pairs.push({
          from: `${displayName(src)}#${src.id}.out[${oi}]`,
          to: `${slots[idx].name}(in[${idx}])`,
          type: String(out.type),
        });
      } catch (err) {
        console.warn(LOG, "补连失败", srcId, oi, "→", newNode.id, idx, err);
      }
    });
  }

  return res;
}

/**
 * 替换后补连输出侧 —— `topUpInputs` 的对称动作。
 *
 * 为什么需要它：替换成「口子更多」的节点时，
 * 新节点多出来的那个输出在旧节点上根本没有对应的线可搬，
 * 于是它就一直空着，下游还停在上游那里。只补输入侧的话，
 * 这类数据会「进得来、出不去」，等于白补。
 *
 * 两种接法，都只碰旧节点的下游、只碰类型对得上的口：
 *   1. 下游那个输入口是空的        → 直接补上
 *   2. 下游那个输入口接的是「新节点的上游」 → 改接成从新节点出
 *      （等于把新节点串进这条数据路径；接的是别处就不动，那是别人的线）
 *
 * @param {LGraphNode} newNode 替换者
 * @param {{ins:Array, outs:Array}} snap 替换前旧节点的连线快照
 * @returns {{added:number, bridged:number, pairs:Array}}
 */
/**
 * 从一批起点往下的节点池，由近到远，只跟数据口走。
 *
 * 为什么下游也要走多层：新节点多出来的输出口，
 * 旧节点的直接下游可能压根没有这个类型的口，能接的那个在再下面一层。
 * 只看相邻一层，这个口照样空着，数据还是走原来的路。
 */
function downstreamPool(startIds, newNode, graph, maxDepth = 4) {
  const out = [];
  const seen = new Set([newNode?.id]);
  let frontier = [];

  for (const id of startIds ?? []) {
    if (seen.has(id)) continue;
    const n = graph.getNodeById(id);
    if (!n) continue;
    seen.add(id);
    out.push(n);
    frontier.push(n);
  }

  for (let d = 1; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {
      for (const o of n.outputs ?? []) {
        if (!isDataPort(o)) continue;
        for (const id of o?.links ?? []) {
          const l = getLink(graph, id);
          if (!l || seen.has(l.target_id)) continue;
          const t = graph.getNodeById(l.target_id);
          if (!t) continue;
          seen.add(t.id);
          out.push(t);
          next.push(t);
        }
      }
    }
    frontier = next;
  }

  return out;
}

function topUpOutputs(newNode, snap, graph) {
  const res = { added: 0, bridged: 0, pairs: [] };
  if (!newNode || !graph || !snap) return res;

  // 旧节点的下游（去重，排除自己）
  const directDown = [...new Set((snap.outs ?? []).map((o) => o.targetId))]
    .filter((id) => id !== newNode.id);
  if (!directDown.length) return res;

  // 再往下走几层：能接的那个口不一定紧挨着
  const downs = downstreamPool(directDown, newNode, graph, 4);

  // 新节点现在的上游（含上上游）。要在改接之前记下来：改接会动下游的输入，
  // 但上游这一侧在补连输入之前是稳定的。
  //
  // 必须包含上上游：下游那个口往往还是由更上面的源头直接喂着
  // （中间那层根本没有这类口，压根传不过来）。只认直接上游的话，
  // 这条线会被判成「不是我上游的东西」，于是不敢改接，下游就继续绕过新节点。
  const ups = new Set(upstreamPool(newNode, graph, 6).map((n) => n.id));

  // 能往哪里补：优先空着的输出口；都接上了的话，同类型口也能继续扇出
  // （同一个上游喂好几个下游，本来就是 ComfyUI 里最常见的接法）
  const freeOuts = [];
  (newNode.outputs ?? []).forEach((s, i) => {
    if (!s?.type || !isDataPort(s)) return;
    freeOuts.push({ i, type: s.type, used: Array.isArray(s.links) ? s.links.length : 0 });
  });
  freeOuts.sort((a, b) => a.used - b.used);
  if (!freeOuts.length) return res;

  for (const d of downs) {

    (d.inputs ?? []).forEach((slot, si) => {
      if (!isDataPort(slot)) return;
      const t = slot?.type;
      if (!t) return;

      const pick = freeOuts.find((o) => compatible(t, o.type));
      if (!pick) return;

      const cur = getLink(graph, slot?.link);

      /* ---- 2. 已经接着别人：只有接的是新节点上游，才改接过来 ---- */
      if (cur) {
        if (cur.origin_id === newNode.id || !ups.has(cur.origin_id)) return;

        const srcNode = graph.getNodeById(cur.origin_id);
        const srcSlot = cur.origin_slot;

        try {
          d.disconnectInput(si);
        } catch (err) {
          return;
        }
        try {
          newNode.connect(pick.i, d, si);
          res.bridged++;
          res.pairs.push({
            to: `${displayName(d)}#${d.id}.${slot.name}`,
            type: String(t),
            how: "改接",
          });
        } catch (err) {
          // 接不上就把原来那根线还回去，别把本来好的连接弄断
          try {
            srcNode?.connect(srcSlot, d, si);
          } catch (err2) {
            /* ignore */
          }
          console.warn(LOG, "下游改接失败，已还原", d.id, si, err);
        }
        return;
      }

      /* ---- 1. 空着：直接补 ---- */
      try {
        newNode.connect(pick.i, d, si);
        res.added++;
        res.pairs.push({
          to: `${displayName(d)}#${d.id}.${slot.name}`,
          type: String(t),
          how: "补空",
        });
      } catch (err) {
        console.warn(LOG, "下游补连失败", d.id, si, err);
      }
    });
  }

  return res;
}

/**
 * 把 chainNodes 按从左到右串成一条链，整串站到 oldNode 的位置上。
 *
 *   上游接线 → 第一个节点的输入
 *   最后一个节点的输出 → 下游接线
 *   中间按「数据类型」配对穿透（model + clip 并排走的线会整组穿过去）
 *   某一类口子（比如某个节点没有 CLIP 输入位）接不上时，这一类整条跳过、
 *   旧节点对应的线原样不动，其余类型照常接 —— 不硬接。
 *
 * @param {LGraphNode[]} chainNodes 选中的那批（要求都没连线）
 * @param {LGraphNode} oldNode 被顶替的节点（有线）
 * @returns {boolean}
 */
function chainReplace(chainNodes, oldNode) {
  const graph = app.graph;
  if (!graph || !oldNode) return false;

  const chain = [...chainNodes]
    .filter((n) => n && n.id !== oldNode.id)
    .sort((a, b) => a.pos[0] - b.pos[0] || a.pos[1] - b.pos[1]);

  if (!chain.length) return false;
  if (chain.length === 1) return replaceWithNode(oldNode, chain[0]);

  /* ---- 快照旧节点的连线 ---- */
  const inRecs = [];
  (oldNode.inputs ?? []).forEach((slot, i) => {
    const l = getLink(graph, slot?.link);
    if (!l) return;
    const type = l.type ?? slot?.type ?? "*";
    inRecs.push({
      slot: i,
      originId: l.origin_id,
      originSlot: l.origin_slot,
      type,
      key: typeTokens(type).sort().join(","),
    });
  });

  const outRecs = [];
  (oldNode.outputs ?? []).forEach((slot, i) => {
    for (const id of Array.isArray(slot?.links) ? slot.links : []) {
      const l = getLink(graph, id);
      if (!l) continue;
      const type = l.type ?? slot?.type ?? "*";
      outRecs.push({
        slot: i,
        targetId: l.target_id,
        targetSlot: l.target_slot,
        type,
        key: typeTokens(type).sort().join(","),
      });
    }
  });

  const keys = [...new Set([...inRecs, ...outRecs].map((r) => r.key))];
  if (!keys.length) {
    toast("info", "没有线可以接管", `${displayName(oldNode)} 身上没有连线。`, 4500);
    return false;
  }

  const last = chain.length - 1;
  const oldPos = [oldNode.pos[0], oldNode.pos[1]];
  const firstOldPos = [chain[0].pos[0], chain[0].pos[1]];

  const usedIn = new Map(chain.map((n) => [n.id, new Set()]));
  const usedOut = new Map(chain.map((n) => [n.id, new Set()]));

  // 动手前先留一份原始接线，报告里用来对比
  const beforeText = dumpText([...chain, oldNode], graph);

  let madeIn = 0;
  let madeOut = 0;
  let failIn = 0;
  let failOut = 0;
  const skipped = []; // 整类没接上（链上没人有这种口子）
  const detoured = []; // 某一类线跨过了链上某些节点（旁路）

  beginChange();

  try {
    /* ---- 1. 排位置：最后一个站到旧节点位，往左依次排开 ---- */
    let x = oldPos[0];
    for (let i = last; i >= 0; i--) {
      chain[i].pos = [x, oldPos[1]];
      x -= widthOf(chain[i]) + CHAIN_GAP;
    }
    oldNode.pos = firstOldPos; // 旧节点退到原来最左那个节点的位置

    /* ---- 2. 逐类型接线 ---- */
    for (const key of keys) {
      const ins = inRecs.filter((r) => r.key === key);
      const outs = outRecs.filter((r) => r.key === key);
      const type = ins[0]?.type ?? outs[0]?.type ?? "*";

      /* 规划这一类型的通路（carriers，按链序）。
         链上某个节点缺这类口子时不再整类放弃，而是把它「旁路」掉：
         链上有口子多的节点也有口子少的节点时，某一类从多的那个进出、
         跳过少的那个，下游照样拿得到，旧节点上的这类线也能一并搬干净。 */
      const planIn = new Array(chain.length).fill(-1);
      const planOut = new Array(chain.length).fill(-1);
      const carriers = [];

      for (let i = 0; i < chain.length; i++) {
        const n = chain[i];
        const needIn = i > 0 || ins.length > 0;
        const needOut = i < last || outs.length > 0;

        const ii = needIn ? findFreeSlot(n, true, type, usedIn.get(n.id)) : -1;
        const oi = findFreeSlot(n, false, type, usedOut.get(n.id));

        // 要进却进不来、要出却出不去 → 这个节点不参与这一类型，直接旁路
        if (needIn && ii < 0) continue;
        if (needOut && oi < 0) continue;

        planIn[i] = ii;
        planOut[i] = oi < 0 ? -1 : oi;
        carriers.push(i);
      }

      if (!carriers.length) {
        // 链上一个节点都接不了这一类 → 整类留在旧节点上，一根都不动
        skipped.push({ key, type: String(type), node: "链上没有这种口子" });
        continue;
      }

      if (carriers.length < chain.length) {
        detoured.push({
          type: String(type),
          nodes: chain.filter((_n, i) => !carriers.includes(i)).map(displayName),
        });
      }

      const head = carriers[0];
      const tail = carriers[carriers.length - 1];

      // 占用槽位
      for (const i of carriers) {
        if (planIn[i] >= 0) usedIn.get(chain[i].id).add(planIn[i]);
        if (planOut[i] >= 0) usedOut.get(chain[i].id).add(planOut[i]);
      }

      // 先把旧节点这一类型的线断开（不断开，下游输入位被占着接不进去）
      for (const r of ins) {
        if (r.originId === chain[head].id) continue;
        try {
          oldNode.disconnectInput(r.slot);
        } catch (err) {
          /* ignore */
        }
      }
      for (const r of outs) {
        if (r.targetId === chain[tail].id) continue;
        try {
          oldNode.disconnectOutput(r.slot);
        } catch (err) {
          /* ignore */
        }
      }

      // 上游 → 通路第一站
      for (const r of ins) {
        const src = graph.getNodeById(r.originId);
        if (!src) {
          failIn++;
          continue;
        }
        try {
          src.connect(r.originSlot, chain[head], planIn[head]);
          madeIn++;
        } catch (err) {
          console.warn(LOG, "串联：上游连接失败", r.type, err);
          failIn++;
        }
      }

      // 通路内相邻穿透（旁路掉的节点不在 carriers 里，自然被跨过去）
      for (let k = 1; k < carriers.length; k++) {
        const prev = carriers[k - 1];
        const cur = carriers[k];
        try {
          chain[prev].connect(planOut[prev], chain[cur], planIn[cur]);
        } catch (err) {
          console.warn(LOG, "串联：链内连接失败", prev, "→", cur, String(type), err);
        }
      }

      // 通路最后一站 → 下游
      for (const r of outs) {
        const tgt = graph.getNodeById(r.targetId);
        if (!tgt) {
          failOut++;
          continue;
        }
        try {
          chain[tail].connect(planOut[tail], tgt, r.targetSlot);
          madeOut++;
        } catch (err) {
          console.warn(LOG, "串联：下游连接失败", r.type, err);
          failOut++;
        }
      }
    }

    /* ---- 3. 收尾 ---- */
    // 留在旧节点上的那些线：出口本来就空着的，是死线，直接断掉别飘在画布上
    const cutDead = cutDanglingInputs(oldNode, graph, new Set(skipped.map((s) => s.key)));
    const skippedLive = skipped.filter((s) => !cutDead.some((c) => c.key === s.key));

    // 链上每个节点：还空着、但能从上游补上的数据口，顺手接上
    let topAdded = 0;
    const topPairs = [];
    for (const n of chain) {
      const t = topUpInputs(n, graph);
      topAdded += t.added;
      topPairs.push(...t.pairs);
    }

    for (const n of chain) n.setDirtyCanvas?.(true, true);
    oldNode.setDirtyCanvas?.(true, true);
    graph.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);

    try {
      app.canvas?.selectNode?.(chain[last], false);
    } catch (err) {
      try {
        if (app.canvas) app.canvas.selected_nodes = { [chain[last].id]: chain[last] };
      } catch (err2) {
        /* ignore */
      }
    }

    /* ---- 汇总提示 ---- */
    const names = chain.map(displayName);
    const flow = names.length <= 3 ? names.join(" → ") : `${names.slice(0, 2).join(" → ")} → … → ${names[last]}`;
    const parts = [`${flow}`, `接管 ${displayName(oldNode)} 的线：输入 ${madeIn}/${inRecs.length} · 输出 ${madeOut}/${outRecs.length}`];

    const reportCopied = publishReport(
      "串联替换",
      `链：${flow}　← 顶替 ${displayName(oldNode)}#${oldNode.id}`,
      [
        `结果：输入 ${madeIn}/${inRecs.length} · 输出 ${madeOut}/${outRecs.length}`,
        `跳过的类型：${skippedLive.length ? skippedLive.map((s) => `${s.type}(${s.node})`).join("、") : "无"}`,
        `跨过的节点：${detoured.length ? detoured.map((d) => `${d.type} 跳过 ${d.nodes.join("/")}`).join("、") : "无"}`,
        `断开的悬空线：${cutDead.length ? `${cutLabel(cutDead)}（${cutDead.length} 条）` : "无"}`,
        `失败条数：in ${failIn} · out ${failOut}`,
        "",
        "【替换前】",
        beforeText,
        "【替换后】",
        dumpText([...chain, oldNode], graph),
      ],
    );
    if (reportCopied) parts.push("连线报告已复制到剪贴板");
    if (topAdded) parts.push(`补连 ${topAdded} 条空口（${topPairs.map((p) => p.type).join("、")}）`);
    if (cutDead.length) parts.push(`断开了 ${cutDead.length} 条没下游的悬空线（${cutLabel(cutDead)}）`);

    if (skippedLive.length) {
      const uniq = [...new Set(skippedLive.map((s) => `${s.type}（${s.node}）`))];
      toast(
        "warn",
        `已串成 ${chain.length} 个节点的链，但有 ${skippedLive.length} 类线没接`,
        [...parts, `整类留在旧节点：${uniq.join("、")}`].join(" · "),
        11000,
      );
    } else if (failIn || failOut) {
      toast("warn", "串联完成，但部分连线没接上", [...parts, `没接上 ${failIn + failOut} 条`].join(" · "), 9000);
    } else {
      const byPass = detoured.length
        ? [`跨过：${detoured.map((d) => `${d.type} 跳过 ${d.nodes.join("/")}`).join("、")}`]
        : [];
      toast(
        "success",
        `已把 ${chain.length} 个节点串成一条链，顶替 ${displayName(oldNode)}`,
        [...parts, ...byPass].join(" · "),
        5500,
      );
    }

    console.log(LOG, "串联替换", { chain: names, old: displayName(oldNode), inRecs, outRecs, skipped });

    return true;
  } catch (err) {
    console.error(LOG, "串联替换出错", err);
    toast("error", "串联替换失败", String(err?.message ?? err));
    return false;
  } finally {
    endChange();
  }
}

/* ---- 一换多（合并）：这批节点整体被一个节点顶掉 ---- */

/**
 * 把 nodes 这一批合并成 newNode 一个：
 *   外部上游（跨出这批范围的线）→ newNode 的输入
 *   newNode 的输出 → 外部下游
 *   这批节点彼此之间的内部线直接作废（它们本来就要被一个节点替代）
 *   旧节点全部保留在画布上，只断线
 *
 * @param {LGraphNode[]} nodes 被合并的那批
 * @param {LGraphNode} newNode 用来顶替的那一个
 */
function mergeReplace(nodes, newNode) {
  const graph = app.graph;
  if (!graph || !newNode || !nodes?.length) return false;

  const list = nodes.filter((n) => n && n.id !== newNode.id);
  if (!list.length) return false;
  if (list.length === 1) return replaceWithNode(list[0], newNode);

  const set = new Set(list.map((n) => n.id));

  /* ---- 收集对外的线（跨出这批范围的） ---- */
  const extIns = [];
  const extOuts = [];
  for (const n of list) {
    (n.inputs ?? []).forEach((s, i) => {
      const l = getLink(graph, s?.link);
      if (!l || set.has(l.origin_id)) return;
      extIns.push({ originId: l.origin_id, originSlot: l.origin_slot, type: l.type ?? s?.type, name: s?.name });
    });
    (n.outputs ?? []).forEach((s, i) => {
      for (const id of Array.isArray(s?.links) ? s.links : []) {
        const l = getLink(graph, id);
        if (!l || set.has(l.target_id)) return;
        extOuts.push({ targetId: l.target_id, targetSlot: l.target_slot, type: l.type ?? s?.type, name: s?.name });
      }
    });
  }

  if (!extIns.length && !extOuts.length) {
    toast("warn", "这批节点没有对外的连线", "它们只和彼此连着，合并后没有线可接。图没有改动。", 9000);
    return false;
  }

  const beforeText = dumpText([...list, newNode], graph);

  // 新节点站到这批里最靠下游（最右）的那个位置；被挤掉的那个退到新节点的原位
  const right = [...list].sort((a, b) => (b.pos[0] + widthOf(b)) - (a.pos[0] + widthOf(a)))[0];
  const newPos = [right.pos[0], right.pos[1]];
  const rightOldPos = [newNode.pos[0], newNode.pos[1]];

  beginChange();
  try {
    newNode.pos = newPos;
    right.pos = rightOldPos;

    /* ---- 断开这批节点的所有连线（对外的已经快照过；内部线直接作废） ---- */
    for (const n of list) {
      (n.inputs ?? []).forEach((s, i) => {
        if (s?.link === null || s?.link === undefined) return;
        try {
          n.disconnectInput(i);
        } catch (err) {
          /* ignore */
        }
      });
      (n.outputs ?? []).forEach((s, i) => {
        if (!Array.isArray(s?.links) || !s.links.length) return;
        try {
          n.disconnectOutput(i);
        } catch (err) {
          /* ignore */
        }
      });
    }

    /* ---- 外部上游 → 新节点 ---- */
    let inDone = 0;
    let outDone = 0;
    let fail = 0;
    const usedIn = new Set();
    const seenIn = new Set();

    for (const r of extIns) {
      if (!r.type) {
        fail++;
        continue;
      }
      const key = `${r.originId}:${r.originSlot}:${typeKeyOf(r.type)}`;
      if (seenIn.has(key)) continue; // 同一条上游线只接一次
      seenIn.add(key);

      const src = graph.getNodeById(r.originId);
      if (!src) {
        fail++;
        continue;
      }

      const idx = (newNode.inputs ?? []).findIndex((s, i) => !usedIn.has(i) && compatible(s?.type, r.type));
      if (idx < 0) {
        fail++;
        continue;
      }
      usedIn.add(idx);

      try {
        const existing = newNode.inputs?.[idx]?.link;
        if (existing !== null && existing !== undefined) newNode.disconnectInput(idx);
      } catch (err) {
        /* ignore */
      }

      try {
        src.connect(r.originSlot, newNode, idx);
        inDone++;
      } catch (err) {
        console.warn(LOG, "合并：上游连接失败", r, err);
        fail++;
      }
    }

    /* ---- 新节点 → 外部下游（同一类型共用同一个输出口） ---- */
    const outSlotByKey = new Map();

    for (const r of extOuts) {
      if (!r.type) {
        fail++;
        continue;
      }
      const key = typeKeyOf(r.type);
      let idx = outSlotByKey.get(key);
      if (idx === undefined) {
        idx = (newNode.outputs ?? []).findIndex((s) => compatible(s?.type, r.type));
        outSlotByKey.set(key, idx);
      }
      if (idx < 0) {
        fail++;
        continue;
      }

      const tgt = graph.getNodeById(r.targetId);
      if (!tgt) {
        fail++;
        continue;
      }

      try {
        newNode.connect(idx, tgt, r.targetSlot);
        outDone++;
      } catch (err) {
        console.warn(LOG, "合并：下游连接失败", r, err);
        fail++;
      }
    }

    /* ---- 补连空着的数据口 ---- */
    const top = topUpInputs(newNode, graph);

    for (const n of [newNode, ...list]) n.setDirtyCanvas?.(true, true);
    graph.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);

    try {
      app.canvas?.selectNode?.(newNode, false);
    } catch (err) {
      /* ignore */
    }

    /* ---- 汇总 ---- */
    const names = list.map(displayName);
    const flow = names.length <= 3 ? names.join(" + ") : `${names.slice(0, 2).join(" + ")} 等 ${names.length} 个`;
    const parts = [
      `${flow} → ${displayName(newNode)}`,
      `外部连线 输入 ${inDone}/${extIns.length} · 输出 ${outDone}/${extOuts.length}`,
    ];
    if (top.added) parts.push(`补连 ${top.added} 条（${top.pairs.map((p) => p.type).join("、")}）`);

    const reportCopied = publishReport(
      "合并替换",
      `${flow} → ${displayName(newNode)}#${newNode.id}`,
      [
        `结果：外部输入 ${inDone}/${extIns.length} · 外部输出 ${outDone}/${extOuts.length}`,
        `没接上的条数：${fail}`,
        `补连：${top.added ? top.pairs.map((p) => `${p.from} → ${p.to}`).join("、") : "无"}`,
        "",
        "【替换前】",
        beforeText,
        "【替换后】",
        dumpText([newNode, ...list], graph),
      ],
    );
    if (reportCopied) parts.push("连线报告已复制到剪贴板");

    if (fail) {
      toast("warn", "合并完成，但部分连线没接上", [...parts, `没接上 ${fail} 条`].join(" · "), 10000);
    } else {
      toast("success", `已用 1 个节点合并顶替 ${list.length} 个`, parts.join(" · "), 7000);
    }

    console.log(LOG, "合并替换", { merged: names, into: displayName(newNode), extIns, extOuts, topUp: top });
    return true;
  } catch (err) {
    console.error(LOG, "合并替换出错", err);
    toast("error", "合并替换失败", String(err?.message ?? err));
    return false;
  } finally {
    endChange();
  }
}

/* ============================================================
 * 换顺序：把「一前一后」两个节点在链上的次序对调
 *
 *      上游U → [A] → X → Y → [B] → 下游D
 *                ↓
 *      上游U → [B] → X → Y → [A] → 下游D
 *
 * 不是「搬线」，而是**对调上下游**：
 *   · A 的外来上游 → B，B 的外来上游 → A
 *   · A 的外来下游 ← B，B 的外来下游 ← A
 *   · 两者之间直接连着的那一段，方向反过来
 *
 * 一类一类地换：某一类只有一边有口子，这一整类
 * 就留在原节点上，绝不搬一半把线弄断。
 * ============================================================ */

/** upper 是不是 lower 的上游（顺着输入一路往上找） */
function isUpstreamOf(upper, lower, graph) {
  if (!upper || !lower || !graph || upper.id === lower.id) return false;

  const seen = new Set([lower.id]);
  const stack = [lower];
  let guard = 0;

  while (stack.length && guard++ < 4000) {
    const n = stack.pop();
    for (const s of n?.inputs ?? []) {
      const l = getLink(graph, s?.link);
      if (!l) continue;
      if (l.origin_id === upper.id) return true;
      if (seen.has(l.origin_id)) continue;
      seen.add(l.origin_id);
      const prev = graph.getNodeById(l.origin_id);
      if (prev) stack.push(prev);
    }
  }
  return false;
}

/** 排成 [上游, 下游]；两者不在一前一后这条关系上 → null */
function orderPair(a, b, graph) {
  const g = graph ?? app.graph;
  if (isUpstreamOf(a, b, g)) return [a, b];
  if (isUpstreamOf(b, a, g)) return [b, a];
  return null;
}

/** 记下节点身上「跨出这对节点」的线（两者之间的内部线由 internalLinks 单独收） */
function swapSideRecords(node, graph, pairIds) {
  const ins = [];
  const outs = [];

  (node.inputs ?? []).forEach((s, i) => {
    const l = getLink(graph, s?.link);
    if (!l || pairIds.has(l.origin_id)) return;
    ins.push({
      slot: i,
      name: s?.name,
      type: s?.type ?? l.type,
      originId: l.origin_id,
      originSlot: l.origin_slot,
    });
  });

  (node.outputs ?? []).forEach((s, i) => {
    for (const id of Array.isArray(s?.links) ? s.links : []) {
      const l = getLink(graph, id);
      if (!l || pairIds.has(l.target_id)) continue;
      outs.push({
        slot: i,
        name: s?.name,
        type: s?.type ?? l.type,
        targetId: l.target_id,
        targetSlot: l.target_slot,
      });
    }
  });

  return { ins, outs };
}

/** early 直接连到 late 的那几根（相邻时要反向重连） */
function internalLinks(early, late, graph) {
  const out = [];
  (early.outputs ?? []).forEach((s, i) => {
    for (const id of Array.isArray(s?.links) ? s.links : []) {
      const l = getLink(graph, id);
      if (!l || l.target_id !== late.id) continue;
      out.push({
        slot: i,
        name: s?.name,
        // late 那一侧收到的口叫什么。反接回去时，early 的入口该按这个名字挑：
        // 同一个数据流在两头叫法常常不一样（一边叫 xxx，另一边叫 upstream_xxx），
        // 照搬出口名字会挑到另一个同类型的口（比如同名的参数输入框）。
        targetName: late.inputs?.[l.target_slot]?.name,
        type: s?.type ?? l.type,
        targetSlot: l.target_slot,
      });
    }
  });
  return out;
}

/**
 * 名字对得上的排前面。
 * @param {string|string[]} preferName 一个名字，或「按优先级排好的一组名字」
 * @returns {number} 0 = 第一个名字对得上，1 = 第二个，2 = 都没对上
 */
function nameRank(slotName, preferName) {
  if (!preferName) return 2;
  const list = Array.isArray(preferName) ? preferName : [preferName];
  const n = normName(slotName);
  for (let k = 0; k < list.length; k++) {
    if (list[k] && normName(list[k]) === n) return k;
  }
  return 2;
}

/**
 * 挑一个类型接得上的槽位。名字对得上的优先，`*` 通配口排最后。
 * @param {Set<string>} used 已占用的槽位（`i0` / `o0` 这种）
 */
function pickSlot(node, isInput, type, used, preferName) {
  const graph = app.graph;
  const slots = (isInput ? node.inputs : node.outputs) ?? [];
  const cands = [];

  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s) continue;
    if (used?.has(`${isInput ? "i" : "o"}${i}`)) continue;
    if (!compatible(s.type, type)) continue;

    // 已经接着别的东西时：接的是同类（马上要断开重连）无所谓，
    // 接的是别的类型就别抢 —— 那条线不归这次交换管。
    let stolen = 0;
    if (isInput && s.link !== null && s.link !== undefined) {
      const l = getLink(graph, s.link);
      if (l && !compatible(l.type, type)) stolen = 1000;
    }

    const wildcard = typeTokens(s.type).includes("*");
    cands.push({ i, score: stolen + (wildcard ? 10 : 0) + nameRank(s.name, preferName) });
  }

  if (!cands.length) return -1;
  cands.sort((x, y) => x.score - y.score || x.i - y.i);
  return cands[0].i;
}

/** 按条分配输入槽位；分配不到就返回原因。`nameOf` 可自定义「按什么名字挑」 */
function allocSlots(node, isInput, type, recs, used, label, nameOf) {
  const slots = [];
  for (const r of recs) {
    const s = pickSlot(node, isInput, type, used, nameOf ? nameOf(r) : r.name);
    if (s < 0) return { slots: [], bad: `${displayName(node)} 没有 ${type} ${label}` };
    used.add(`${isInput ? "i" : "o"}${s}`);
    slots.push(s);
  }
  return { slots, bad: "" };
}

/**
 * 某一类整组被跳过（一侧没这个口子）之后，检查 late 那一路是不是「倒流」了，是就摆正。
 *
 * 实际拓扑（v3.13 遇到过）：
 *
 *   A → B → C → D → E              ← 主线（MODEL / STRING 走这条）
 *   A ─X────────→ C ─X→ D ─X→ E    ← X 绕过 B（B 没有 X 口）
 *
 *   交换 B ⇄ D 后，D 站到 B 的位置（A 之后），
 *   可它的 X 输入还接在 C 上 —— C 现在是它的**下游**，X 从下游往上游流，成了环。
 *
 * 正确结果是让 X 也跟着新顺序走：
 *
 *   A ─X→ D ─X→ C ─X→ E
 *
 * 做法：在 late 和「它这类输入的源 S」之间，对这一类单独对调一次。
 * S 就是被这次交换跨过去的那个中间节点（early 的直接下游）。
 *
 * 只在条件全都满足时动手，任何一条不满足就原样留着并写进提示 ——
 * 再往外扩就不是「换顺序」，而是重排整张图了：
 *
 *   1. 这类输入只有 1 条，源是 S
 *   2. S 曾是 early 的直接下游（被跨过的就是它）—— 用**交换前的快照**判断：
 *      交换完成后 early 的下游已经被 late 接管，现场已经看不到 `early → S` 了
 *   3. S 这个输出口只喂 late 一个（有别的下游就挪不动）
 *   4. late 有这类输出、只挂在一个口上、且至少 1 条下游（否则接上去就是环）
 *   5. S 这类输入有源头（自己产出这类数据的，插不进去）
 *
 * @param {Set<number>} earlyDownIds 交换前 early 的出线目标（快照）
 * @returns {{fixed:Array<{type:string, viaId:number}>, left:Array<{type:string, why:string}>}}
 */
function bridgeSkipped(late, early, skippedKeys, graph, earlyDownIds) {
  const res = { fixed: [], left: [] };
  if (!skippedKeys?.length) return res;

  const skipSet = new Set(skippedKeys);

  /* ---- late 上的输入，按类型分组 ---- */
  const groups = new Map();
  (late.inputs ?? []).forEach((s, i) => {
    const l = getLink(graph, s?.link);
    if (!l) return;
    const key = typeKeyOf(s?.type ?? l.type);
    const g = groups.get(key) ?? { key, type: s?.type ?? l.type, recs: [] };
    g.recs.push({ slot: i, link: l });
    groups.set(key, g);
  });

  for (const g of groups.values()) {
    if (!skipSet.has(g.key)) continue;

    if (g.recs.length !== 1) {
      res.left.push({ type: String(g.type), why: `这类输入有 ${g.recs.length} 条，不知道该拿哪条` });
      continue;
    }

    const rec = g.recs[0];
    const S = graph.getNodeById(rec.link.origin_id);
    if (!S || S.id === early.id || S.id === late.id) {
      res.left.push({ type: String(g.type), why: "上游不是被跨过的那个节点" });
      continue;
    }

    // S 得是 early 交换前的直接下游（被这次交换跨过的就是它）
    if (!earlyDownIds?.has(S.id)) {
      res.left.push({ type: String(g.type), why: `${displayName(S)} 不是 ${displayName(early)} 的直接下游` });
      continue;
    }

    // S 这个出口只喂 late 一个，否则挪走会连累别的分支
    const sOut = S.outputs?.[rec.link.origin_slot];
    const sOutLinks = (Array.isArray(sOut?.links) ? sOut.links : []).filter((id) => getLink(graph, id));
    if (sOutLinks.length !== 1) {
      res.left.push({ type: String(g.type), why: `${displayName(S)} 的 ${String(g.type)} 还喂着别的节点` });
      continue;
    }

    // late 这类输出：必须存在、只挂一个槽、且至少 1 条下游
    const outSlots = [];
    (late.outputs ?? []).forEach((s, i) => {
      if (typeKeyOf(s?.type) !== g.key) return;
      const ids = (Array.isArray(s?.links) ? s.links : []).filter((id) => getLink(graph, id));
      if (ids.length) outSlots.push({ i, ids });
    });
    if (outSlots.length !== 1) {
      res.left.push({
        type: String(g.type),
        why: outSlots.length ? "这类输出分散在好几个口子上" : "这一侧没有这类输出，插不上去",
      });
      continue;
    }
    const outRec = outSlots[0];

    // S 这类输入的源头（late 要顶到这个位置）
    const sInLink = getLink(graph, S.inputs?.[rec.link.target_slot]?.link);
    if (!sInLink) {
      res.left.push({ type: String(g.type), why: `${displayName(S)} 的这类输入是空的（数据由它自己产出）` });
      continue;
    }

    /* ---- 动手：late 与 S 在这一类上对调 ---- */
    const targets = outRec.ids.map((id) => getLink(graph, id)).filter(Boolean);
    try {
      late.disconnectInput(rec.slot);
      late.disconnectOutput(outRec.i);
      S.disconnectInput(rec.link.target_slot);

      const x = graph.getNodeById(sInLink.origin_id);
      if (x) x.connect(sInLink.origin_slot, late, rec.slot);
      late.connect(outRec.i, S, rec.link.target_slot);
      for (const t of targets) {
        const tgt = graph.getNodeById(t.target_id);
        if (tgt) S.connect(rec.link.origin_slot, tgt, t.target_slot);
      }
      res.fixed.push({ type: String(g.type), viaId: S.id });
    } catch (err) {
      console.warn(LOG, "换顺序：跳过类型摆正失败", g.type, err);
      res.left.push({ type: String(g.type), why: "重接时出错，保持原样" });
    }
  }

  return res;
}

/**
 * 把两个一前一后的节点在链上的次序对调。
 * 谁前谁后由连线决定，和你先点哪个无关。
 */
function swapOrder(a, b) {
  const graph = app.graph;
  if (!graph || !a || !b) return false;

  if (a === b || a.id === b.id) {
    toast("warn", "不能自己换自己", "请选两个不同的节点。", 3500);
    return false;
  }

  closeChoice();

  const pair = orderPair(a, b, graph);
  if (!pair) {
    toast(
      "warn",
      "这两个节点不是一前一后",
      `${displayName(a)} 和 ${displayName(b)} 之间没有上下游通路，交换顺序没有意义。图没有改动。`,
      9000,
    );
    return false;
  }

  const [early, late] = pair;
  const pairIds = new Set([early.id, late.id]);
  const eRec = swapSideRecords(early, graph, pairIds);
  const lRec = swapSideRecords(late, graph, pairIds);
  const inner = internalLinks(early, late, graph);

  const all = [...eRec.ins, ...eRec.outs, ...lRec.ins, ...lRec.outs, ...inner];
  if (!all.length) {
    toast(
      "info",
      "这两个节点都没有连线",
      "没有上下游可以对调，只换了位置也没什么意义。图没有改动。",
      7000,
    );
    return false;
  }

  /* ---- 按数据类型分组，一类一类判断能不能换 ---- */
  const keys = [];
  const seenKey = new Set();
  for (const r of all) {
    const k = typeKeyOf(r.type);
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    keys.push(k);
  }

  const plan = [];
  const skipped = [];
  const used = { eIn: new Set(), eOut: new Set(), lIn: new Set(), lOut: new Set() };

  for (const key of keys) {
    const eIn = eRec.ins.filter((r) => typeKeyOf(r.type) === key);
    const eOut = eRec.outs.filter((r) => typeKeyOf(r.type) === key);
    const lIn = lRec.ins.filter((r) => typeKeyOf(r.type) === key);
    const lOut = lRec.outs.filter((r) => typeKeyOf(r.type) === key);
    const inn = inner.filter((r) => typeKeyOf(r.type) === key);
    const type = (eIn[0] ?? eOut[0] ?? lIn[0] ?? lOut[0] ?? inn[0])?.type ?? "*";

    // 试占一套，失败了整套丢掉，不影响别的类型
    const t = {
      eIn: new Set(used.eIn),
      eOut: new Set(used.eOut),
      lIn: new Set(used.lIn),
      lOut: new Set(used.lOut),
    };

    const lateIn = allocSlots(late, true, type, eIn, t.lIn, "输入口");
    const earlyIn = allocSlots(early, true, type, lIn, t.eIn, "输入口");
    const lateOut = eOut.length || inn.length
      ? allocSlots(late, false, type, [eOut[0] ?? inn[0]], t.lOut, "输出口")
      : { slots: [], bad: "" };
    const earlyOut = lOut.length
      ? allocSlots(early, false, type, [lOut[0]], t.eOut, "输出口")
      : { slots: [], bad: "" };
    const innerIn = inn.length
      // 两者直连的那一段要反着接：late 的输出接回 early 的输入。
      // 挑 early 的哪个输入口，看 late 那个口叫什么（它俩收的是同一个数据流），
      // 其次才看 early 自己的出口名 —— 两头叫法不一样时，光看出口名会挑错
      // （出口叫 xxx，对侧的入口其实叫 upstream_xxx，
      //   节点上另有一个同名的参数输入框，照名字直配就会接进去）
      ? allocSlots(early, true, type, [inn[0]], t.eIn, "输入口", (r) => [r.targetName, r.name])
      : { slots: [], bad: "" };

    const bad = lateIn.bad || earlyIn.bad || lateOut.bad || earlyOut.bad || innerIn.bad;
    if (bad) {
      skipped.push({ key, type: String(type), reason: bad });
      continue;
    }

    used.eIn = t.eIn;
    used.eOut = t.eOut;
    used.lIn = t.lIn;
    used.lOut = t.lOut;

    plan.push({
      type,
      eIn,
      eOut,
      lIn,
      lOut,
      inn,
      lateInSlots: lateIn.slots,
      earlyInSlots: earlyIn.slots,
      lateOutSlot: lateOut.slots[0] ?? -1,
      earlyOutSlot: earlyOut.slots[0] ?? -1,
      innerEarlyIn: innerIn.slots[0] ?? -1,
    });
  }

  if (!plan.length) {
    toast(
      "warn",
      "口子对不上，没有可以对调的线",
      `${skipped.map((s) => `${s.type}：${s.reason}`).join("；")}。图没有改动。`,
      11000,
    );
    return false;
  }

  /* ---- 动手 ---- */
  const earlyPos = [early.pos[0], early.pos[1]];
  const latePos = [late.pos[0], late.pos[1]];
  const beforeText = dumpText([early, late], graph);

  const cutEIn = new Set();
  const cutEOut = new Set();
  const cutLIn = new Set();
  const cutLOut = new Set();
  for (const p of plan) {
    for (const r of p.eIn) cutEIn.add(r.slot);
    for (const r of p.eOut) cutEOut.add(r.slot);
    for (const r of p.lIn) cutLIn.add(r.slot);
    for (const r of p.lOut) cutLOut.add(r.slot);
    for (const r of p.inn) {
      cutEOut.add(r.slot);
      cutLIn.add(r.targetSlot);
    }
  }

  beginChange();

  try {
    /* 1. 先断开参与交换的那些槽位（线已快照） */
    for (const i of cutEIn) {
      try {
        early.disconnectInput(i);
      } catch (err) {
        /* ignore */
      }
    }
    for (const i of cutEOut) {
      try {
        early.disconnectOutput(i);
      } catch (err) {
        /* ignore */
      }
    }
    for (const i of cutLIn) {
      try {
        late.disconnectInput(i);
      } catch (err) {
        /* ignore */
      }
    }
    for (const i of cutLOut) {
      try {
        late.disconnectOutput(i);
      } catch (err) {
        /* ignore */
      }
    }

    /* 2. 位置也对调，视觉上还是从左到右 */
    early.pos = latePos;
    late.pos = earlyPos;

    /* 3. 重新接线 */
    let madeIn = 0;
    let madeOut = 0;
    let failIn = 0;
    let failOut = 0;

    for (const p of plan) {
      for (let i = 0; i < p.eIn.length; i++) {
        const r = p.eIn[i];
        const src = graph.getNodeById(r.originId);
        const to = p.lateInSlots[i];
        if (!src || to === undefined || to < 0) {
          failIn++;
          continue;
        }
        try {
          src.connect(r.originSlot, late, to);
          madeIn++;
        } catch (err) {
          console.warn(LOG, "换顺序：上游→后者 失败", r, err);
          failIn++;
        }
      }

      for (let i = 0; i < p.lIn.length; i++) {
        const r = p.lIn[i];
        const src = graph.getNodeById(r.originId);
        const to = p.earlyInSlots[i];
        if (!src || to === undefined || to < 0) {
          failIn++;
          continue;
        }
        try {
          src.connect(r.originSlot, early, to);
          madeIn++;
        } catch (err) {
          console.warn(LOG, "换顺序：上游→前者 失败", r, err);
          failIn++;
        }
      }

      for (const r of p.eOut) {
        const tgt = graph.getNodeById(r.targetId);
        if (!tgt || p.lateOutSlot < 0) {
          failOut++;
          continue;
        }
        try {
          late.connect(p.lateOutSlot, tgt, r.targetSlot);
          madeOut++;
        } catch (err) {
          console.warn(LOG, "换顺序：后者→下游 失败", r, err);
          failOut++;
        }
      }

      for (const r of p.lOut) {
        const tgt = graph.getNodeById(r.targetId);
        if (!tgt || p.earlyOutSlot < 0) {
          failOut++;
          continue;
        }
        try {
          early.connect(p.earlyOutSlot, tgt, r.targetSlot);
          madeOut++;
        } catch (err) {
          console.warn(LOG, "换顺序：前者→下游 失败", r, err);
          failOut++;
        }
      }

      // 两者直接连着的那一段：方向反过来
      if (p.inn.length) {
        if (p.lateOutSlot < 0 || p.innerEarlyIn < 0) {
          failIn++;
        } else {
          try {
            late.connect(p.lateOutSlot, early, p.innerEarlyIn);
            madeIn++;
          } catch (err) {
            console.warn(LOG, "换顺序：反向重连失败", p.type, err);
            failIn++;
          }
        }
      }
    }

    for (const n of [early, late]) n.setDirtyCanvas?.(true, true);
    graph.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);

    // 整类被跳过的那些：late 可能因此「倒流」（输入还挂在现在已经是它下游的节点上），
    // 能摆正就摆正（见 bridgeSkipped 注释里的拓扑）
    const bridged = bridgeSkipped(
      late,
      early,
      skipped.map((s) => s.key),
      graph,
      new Set(eRec.outs.map((r) => r.targetId)),
    );

    // 没对调成功的那几类：如果某一边的出口本来就空着，那条输入是死线，断掉
    const skipKeys = new Set(skipped.map((s) => s.key));
    const cutDead = [...cutDanglingInputs(early, graph, skipKeys), ...cutDanglingInputs(late, graph, skipKeys)];

    try {
      app.canvas?.selectNode?.(early, false);
    } catch (err) {
      /* ignore */
    }

    const typeNames = plan.map((p) => String(p.type)).join("、");
    const parts = [
      `${displayName(early)} ⇄ ${displayName(late)}`,
      `对调 ${plan.length} 类（${typeNames}）：上游 ${madeIn} 条 · 下游 ${madeOut} 条`,
    ];
    // 摆正过的那几类不算「留在原节点」
    const bridgedKeys = new Set(bridged.fixed.map((f) => typeKeyOf(f.type)));
    const skippedLive = skipped.filter(
      (s) => !cutDead.some((c) => c.key === s.key) && !bridgedKeys.has(s.key),
    );
    if (bridged.fixed.length) {
      parts.push(
        `摆正了跳过类型：${bridged.fixed
          .map((f) => `${f.type} 也换到了 ${displayName(graph.getNodeById(f.viaId))} 之前`)
          .join("、")}`,
      );
    }
    if (skippedLive.length) {
      parts.push(`留在原节点：${skippedLive.map((s) => `${s.type}（${s.reason}）`).join("、")}`);
    }
    if (bridged.left.length) {
      parts.push(`没能摆正：${bridged.left.map((l) => `${l.type}（${l.why}）`).join("、")}`);
    }
    if (cutDead.length) parts.push(`断开了 ${cutDead.length} 条没下游的悬空线（${cutLabel(cutDead)}）`);

    const reportCopied = publishReport(
      "交换顺序",
      `${displayName(early)}#${early.id} ⇄ ${displayName(late)}#${late.id}　（原来 ${displayName(early)} 在前）`,
      [
        `对调的类型：${typeNames}`,
        `结果：上游 ${madeIn} 条 · 下游 ${madeOut} 条 · 没接上 ${failIn + failOut} 条`,
        `没动的类型：${skippedLive.length ? skippedLive.map((s) => `${s.type}（${s.reason}）`).join("、") : "无"}`,
        `摆正的跳过类型：${bridged.fixed.length
          ? bridged.fixed.map((f) => `${f.type}（也换到了 ${displayName(graph.getNodeById(f.viaId))}#${f.viaId} 之前）`).join("、")
          : "无"}`,
        `没能摆正：${bridged.left.length ? bridged.left.map((l) => `${l.type}（${l.why}）`).join("、") : "无"}`,
        `断开的悬空线：${cutDead.length ? `${cutLabel(cutDead)}（${cutDead.length} 条）` : "无"}`,
        "",
        "【交换前】",
        beforeText,
        "【交换后】",
        dumpText([early, late], graph),
      ],
    );
    if (reportCopied) parts.push("连线报告已复制到剪贴板");

    if (failIn || failOut) {
      toast("warn", "顺序换了，但有线没接上", parts.join(" · "), 11000);
    } else {
      toast("success", "顺序已对调", parts.join(" · "), 7000);
    }

    console.log(LOG, "交换顺序", { early: displayName(early), late: displayName(late), plan, skipped });
    return true;
  } catch (err) {
    console.error(LOG, "交换顺序出错", err);
    toast("error", "交换顺序失败", String(err?.message ?? err));
    return false;
  } finally {
    endChange();
  }
}

/* ---- 多选旧节点时的批量替换：第一个用原节点，其余克隆 ---- */

function cloneNode(src) {
  try {
    if (typeof src.clone !== "function") return null;
    const c = src.clone();
    if (!c) return null;
    app.graph.add(c);
    return c;
  } catch (err) {
    console.warn(LOG, "克隆节点失败", err);
    return null;
  }
}

function batchReplace(oldNodes, protoNode) {
  let ok = 0;
  let bad = 0;

  oldNodes.forEach((old, idx) => {
    if (idx === 0) {
      if (replaceWithNode(old, protoNode)) ok++;
      else bad++;
      return;
    }
    const c = cloneNode(protoNode);
    if (!c) {
      bad++;
      return;
    }
    if (replaceWithNode(old, c)) ok++;
    else bad++;
  });

  if (bad > 0) {
    toast("warn", "批量替换未全部成功", `成功 ${ok} 个，失败 ${bad} 个`, 8000);
  } else if (oldNodes.length > 1) {
    toast("success", `已替换 ${ok} 个节点`, "其余为克隆副本，参数与原型一致", 5000);
  }
}

/* ============================================================
 * 五、菜单挂载
 * ============================================================ */

let newMenuApiUsed = false;

/* ---- 菜单项位置：挪到「刷新节点」下面 ----
 * 官方 getNodeMenuItems 没有位置参数，返回值只会被追加到菜单末尾，
 * 所以这里等菜单渲染出来后，在 DOM 层把我们的那一项移动到目标位置。
 * 移动的是现成的条目节点，样式和点击回调都跟着走，不会失真。
 */

/* 注意：ComfyUI 的节点右键菜单不是 <ul>/<li>，而是 LiteGraph 自己建的
 *    <div class="litecontextmenu">   ← 菜单根
 *      <div class="litemenu-entry">  ← 每一项（分隔线是 .separator）
 * 前端核心自己也是用 `.litemenu-entry` 去操作菜单的，这里保持一致。
 */
/* ---------- 菜单文字：跟随 ComfyUI 的 Locale 设置（设置 → Comfy → Locale） ----------
 *  只翻译菜单项本身，日志和 toast 提示仍是中文。
 *  取文字时现读语言，用户中途改设置也能跟上，不用刷新。
 *  这段与 nodeInserter.js 里的同名部分保持一字不差，将来抽共享文件时直接搬。
 */
const MENU_I18N = {
  zh: { replace: "替换节点" },
  en: { replace: "Replace node" },
};

function menuLang() {
  let v = "";
  try {
    v = app?.ui?.settings?.getSettingValue?.("Comfy.Locale") || "";
  } catch (err) {
    v = "";
  }
  if (!v) {
    try {
      v = document?.documentElement?.lang || "";
    } catch (err) {
      v = "";
    }
  }
  if (!v) {
    try {
      v = navigator?.language || "";
    } catch (err) {
      v = "";
    }
  }
  return String(v).toLowerCase().startsWith("zh") ? "zh" : "en";
}

function menuText() {
  return MENU_I18N[menuLang()].replace;
}

/* ---------- 提示文案：中文 → 英文 ----------
 *  英文界面下，toast 和顶部提示条里的中文在这里换成英文；中文界面原样返回。
 *  三种匹配按顺序试：
 *    1. 整句精确匹配（EN_TEXT）
 *    2. 用「·」拼起来的复合串，切开逐段匹配
 *    3. 正则模板（EN_RULES），处理带节点名 / 数字的句子
 *  都没命中就返回原句 —— 英文界面下会看到中文，但不会出错，之后按需补表。
 *  这段与 nodeInserter.js 里的同名部分保持一字不差，将来抽共享文件时直接搬。
 */
const EN_TEXT = {
  /* 顶部提示条 */
  "左键点一下要插入的那条线": "Left-click the link to insert into",
  "左键点另一个节点，立即替换": "Left-click another node to replace it",
  "插入：": "Insert: ",
  "串联插入：": "Chained insert: ",
  "已选：": "Selected: ",
  "取消：": "Cancel: ",
  "右键 / 点空白": "right-click / click empty canvas",
  "　·　兄弟线会整组一起串": "　·　sibling links are chained as a group",
  "　·　多个节点将按从左到右串成一条链": "　·　multiple nodes are chained left to right",

  /* 通用 */
  "选中后再右键它。": "Select it, then right-click.",
  "连线报告已复制到剪贴板": "Wiring report copied to clipboard",
  "连线报告已写入控制台（F12）": "Wiring report printed to the console (F12)",
  "找不到画布": "Canvas not found",
  "图没有改动。": "Graph unchanged.",

  /* 插入 */
  "先选中要插入的节点": "Select the node to insert first",
  "无法进入插入模式。": "Cannot enter insert mode.",
  "这条线接不到两端节点": "This link does not reach both of its nodes",
  "可能指向子图的输入 / 输出，或连线已经失效，暂不支持插入。":
    "It may point at a subgraph port, or the link is stale. Inserting is not supported here.",
  "不能插在自己所在的那条线上": "Cannot insert into a link that touches this node",
  "换一个节点或者换一条线。": "Pick another node, or another link.",
  "上游没接上，已还原原来的连线": "Upstream failed — the original link was restored",
  "这条线的类型可能不被这个节点接受。": "This node may not accept this link type.",
  "下游没接上": "Downstream not connected",
  "为了不破坏别的连线，这次没有插入。": "Nothing was inserted, to keep other links intact.",
  "插入失败": "Insert failed",
  "这里不是线": "This is not a link",
  "点在线上，或点下游节点的输入口。": "Click a link, or a downstream node's input.",
  "已退出插入": "Insert cancelled",
  "已经串进这条线。": "Chained into this link.",
  "剩下那几条先按原样留着，需要的话手动补一下。":
    "The rest were left as they were — patch them by hand if needed.",

  /* 分离 */
  "先选中要分离的节点": "Select the node to detach first",
  "它身上没有任何连线。": "It has no links at all.",
  "这些节点都没有连线": "None of these nodes has links",
  "选中的节点本来就是独立的。": "The selected nodes are already standalone.",
  "一个都没分离": "Nothing was detached",
  "那几条的下游现在是断的，麻烦手动补一下。":
    "Their downstream is disconnected now — please patch them by hand.",

  /* 替换 */
  "先选中要被替换的节点": "Select the node to be replaced first",
  "无法进入替换模式。": "Cannot enter replace mode.",
  "不能自己替换自己": "A node cannot replace itself",
  "请选中另外两个节点。": "Select two different nodes.",
  "不能自己换自己": "A node cannot be swapped with itself",
  "请选两个不同的节点。": "Pick two different nodes.",
  "只互换了位置": "Only the positions were swapped",
  "替换完成，但部分连线没接上": "Replaced, but some links were not connected",
  "替换失败": "Replace failed",
  "串联完成，但部分连线没接上": "Chained, but some links were not connected",
  "串联替换失败": "Chain replace failed",
  "这批节点都没连线": "None of these nodes has links",
  "没有线可以接管。要么点一个有连线的节点让它串成链，要么先框选要换掉的那批（它们得是有连线的）。":
    "There are no links to take over. Click a node that has links so the chain forms there, or select the nodes to replace first (they must have links).",
  "没有线可以接管": "No links to take over",
  "这批节点没有对外的连线": "These nodes have no links to the outside",
  "它们只和彼此连着，合并后没有线可接。图没有改动。":
    "They only connect to each other, so there is nothing to reconnect after merging. Graph unchanged.",
  "合并完成，但部分连线没接上": "Merged, but some links were not connected",
  "合并替换失败": "Merge replace failed",
  "这两个节点不是一前一后": "These two nodes are not in a single chain",
  "这两个节点都没有连线": "Neither node has links",
  "没有上下游可以对调，只换了位置也没什么意义。图没有改动。":
    "There is nothing upstream or downstream to swap — moving them would achieve nothing. Graph unchanged.",
  "口子对不上，没有可以对调的线": "Ports do not match — nothing to swap",
  "顺序换了，但有线没接上": "Order swapped, but some links were not connected",
  "顺序已对调": "Order swapped",
  "交换顺序失败": "Swap failed",
  "批量替换未全部成功": "Batch replace did not fully succeed",
  "其余为克隆副本，参数与原型一致": "The rest are clones with identical settings",

  /* 报告的段落标题 */
  "【插入前】": "【Before insert】",
  "【插入后】": "【After insert】",
  "【分离前】": "【Before detach】",
  "【分离后】": "【After detach】",
  "【替换前】": "【Before replace】",
  "【替换后】": "【After replace】",
  "【交换前】": "【Before swap】",
  "【交换后】": "【After swap】",
  "【顺路一起接上】": "【Also connected】",
  "【往上找料补的空口】": "【Empty ports filled from upstream】",
  "【改接到新节点后面的下游】": "【Downstream rerouted to the new node】",
  "【没能接出去】": "【Could not be connected】",
  "【新节点仍然空着的口】": "【Ports still empty on the new node】",
  "【跳过：新节点没有对应的空口】": "【Skipped: no matching port on the new node】",
  "【等你确认的兄弟线】": "【Sibling links awaiting confirmation】",
  "【直连回去的线】": "【Links reconnected directly】",

  /* 报告的标题词与零散词 */
  "插入": "Insert",
  "串联插入": "Chained insert",
  "分离": "Detach",
  "替换": "Replace",
  "合并替换": "Merge replace",
  "交换顺序": "Swap order",
  "无": "none",
  "(节点不存在)": "(node not found)",

  /* 确认条与选择面板 */
  "不用（Esc）": "No (Esc)",
  "一起接上（Enter）": "Connect them (Enter)",
  "第一项": "first option",
  "取消": "cancel",
  "两个节点都有连线，往哪边接？": "Both nodes have links — which way?",
  "用「{B}」替换「{A}」": "Replace 「{A}」 with 「{B}」",
  "用「{A}」替换「{B}」": "Replace 「{B}」 with 「{A}」",
  "{A}（{NA} 根线）全交给 {B}（{NB} 根线），{A} 留在画布上":
    "{A} ({NA} links) hands everything to {B} ({NB} links); {A} stays on the canvas",
  "{B}（{NB} 根线）全交给 {A}（{NA} 根线），{B} 留在画布上":
    "{B} ({NB} links) hands everything to {A} ({NA} links); {B} stays on the canvas",
  "选中的 {N} 个节点，怎么换？": "Selected {N} nodes — how to replace them?",
  "合并成一个 · 用「{X}」顶掉这 {N} 个": "Merge into one · 「{X}」 replaces all {N}",
  "分别替换 · 每个都换成同款": "Replace separately · each becomes its own copy",
};

const EN_RULES = [
  /* 插入 */
  [/^已插入 (.+)$/, "Inserted $1"],
  [/^已一起接上 1 条线$/, "Connected 1 link"],
  [/^已一起接上 (\d+) 条线$/, "Connected $1 links"],
  [/^接上了 (\d+) \/ (\d+) 条$/, "Connected $1 / $2 links"],
  [/^已串联插入 (\d+) 个节点$/, "Inserted $1 nodes as a chain"],
  [/^串联插入到 (\d+) \/ (\d+) 个$/, "Chained $1 / $2 nodes"],
  [/^(.+) 接不上这条线的上游$/, "$1 has no port for the upstream side"],
  [/^(.+) 接不上这条线的下游$/, "$1 has no port for the downstream side"],
  [/^(.+) 的类型对不上这条线$/, "$1 has no matching port type for this link"],
  [/^(.+) 的 (.+) 位已经被占用$/, "Port $2 of $1 is already in use"],
  [/^它没有能接收 (.+) 类型的输入位。$/, "It has no input port that accepts $1."],
  [/^它没有能输出 (.+) 类型的输出位。$/, "It has no output port that provides $1."],
  [/^已把 (.+) 接到 (.+)，剩下的请手动补一根线。$/, "Connected $1 to $2 — wire the rest by hand."],

  /* 分离 */
  [/^已把 (.+) 从连线中分离$/, "Detached $1"],
  [/^已把 (.+) 摘下来$/, "Detached $1"],
  [/^已分离 (\d+) 个节点$/, "Detached $1 nodes"],
  [/^(\d+) 个节点已摘下$/, "$1 nodes detached"],
  [/^(\d+) 条线直连回去$/, "$1 links reconnected"],
  [/^(\d+) 条没接回$/, "$1 not reconnected"],
  [/^(\d+) 个跳过（本来就没线）$/, "$1 skipped (no links)"],
  [/^(\d+) 个跳过（接不回去）$/, "$1 skipped (cannot reconnect)"],
  [/^(.+) 本来就是独立的$/, "$1 is already standalone"],
  [/^(.+) 已分离，但有 (\d+) 条没接回去$/, "$1 detached, but $2 links were not reconnected"],
  [/^(.+) 没法干净地分离$/, "$1 cannot be detached cleanly"],
  [/^(.+) 找不到同类型的上游接回去，拆掉会断线，所以这次没动。$/,
    "No matching upstream for $1 — detaching would break the chain, so nothing was changed."],
  [/^(\d+) 条线直连回去了，节点留在画布上$/, "$1 links reconnected directly; the node stays on the canvas"],
  [/^(\d+) 条线已断开，节点还在画布上。$/, "$1 links removed; the node stays on the canvas."],
  [/^(.+) 的 (.+) 找不到同类型上游。$/, "No matching upstream for $2 of $1."],

  /* 替换 */
  [/^已用 (.+) 替换$/, "Replaced with $1"],
  [/^已替换 (\d+) 个节点$/, "Replaced $1 nodes"],
  [/^已用 1 个节点合并顶替 (\d+) 个$/, "Merged $1 nodes into one"],
  [/^已把 (\d+) 个节点串成一条链，顶替 (.+)$/, "Chained $1 nodes, replacing $2"],
  [/^已串成 (\d+) 个节点的链，但有 (\d+) 类线没接$/, "Chained $1 nodes, but $2 link types were left unconnected"],
  [/^没接上 (\d+) 条$/, "$1 not connected"],
  [/^补连 (\d+) 条空口（(.+)）$/, "Filled $1 empty ports ($2)"],
  [/^断开(?:了)? (\d+) 条没下游的悬空线（(.+)）$/, "Removed $1 dangling links ($2)"],
  [/^(\d+) 处为近似匹配，请复核$/, "$1 approximate matches — please double-check"],
  [/^整类留在旧节点：(.+)$/, "Left on the old node: $1"],
  [/^跨过：(.+)$/, "Bypassed: $1"],
  [/^成功 (\d+) 个，失败 (\d+) 个$/, "$1 succeeded, $2 failed"],
  [/^(.+) 和 (.+) 之间没有上下游通路，交换顺序没有意义。图没有改动。$/,
    "$1 and $2 have no path between them; swapping would mean nothing. Graph unchanged."],
  [/^(.+) 身上没有连线。$/, "$1 has no links."],

  /* 明细片段：toast 后半段那些「·」隔开的小句 */
  [/^覆盖了替换者原有 (\d+) 条输入线$/, "Overwrote $1 input links of the replacement"],
  [/^(.+) 改成了上游直连下游（旧节点不在这条线上了）$/,
    "$1 now runs straight from upstream to downstream (the old node is off this link)"],
  [/^没动的：(.+)$/, "Left untouched: $1"],
  [/^下游补连 (\d+) 条（(.+)）$/, "Filled $1 downstream ports ($2)"],
  [/^改接 (\d+) 条到新节点（(.+)，原先直接绕过它的）$/,
    "Rerouted $1 links to the new node ($2, they used to bypass it)"],
  [/^(.+) 出口还没接下游，要手动接$/, "$1 outputs have no downstream — connect them by hand"],
  [/^旧节点已保留，位置互换完成$/, "Old node kept, positions swapped"],
  [/^两边都没有连线，只互换了位置$/, "Neither had links — only the positions were swapped"],
  [/^补连 (\d+) 条（(.+)）$/, "Filled $1 ports ($2)"],
  [/^留在原节点：(.+)$/, "Left on the old node: $1"],
  [/^没能摆正：(.+)$/, "Not rearranged: $1"],
  [/^对调 (\d+) 类（(.+)）：上游 (\d+) 条$/, "Swapped $1 link types ($2): $3 upstream"],
  [/^下游 (\d+) 条$/, "$1 downstream"],
  [/^顺路接上 (\d+) 条线$/, "Also connected $1 links along the way"],
  [/^另有 (\d+) 条兄弟线等你确认$/, "$1 sibling links waiting for your confirmation"],
  [/^另有 (\d+) 条等你确认$/, "$1 more waiting for your confirmation"],
  [/^(\d+) 条接不上$/, "$1 could not be connected"],
  [/^补上 (\d+) 个空口（(.+)）$/, "Filled $1 empty ports ($2)"],
  [/^改接 (\d+) 条下游$/, "Rerouted $1 downstream links"],
  [/^(\d+) 条没槽位 \/ 类型对不上，没接$/, "$1 had no port or a wrong type — not connected"],
  [/^(.+) 和后面那些留在原位$/, "$1 and the ones after it stayed in place"],

  /* 报告正文 */
  [/^没动的类型：无$/, "Types left untouched: none"],
  [/^断开的悬空线：无$/, "Dangling links removed: none"],
  [/^摆正的跳过类型：无$/, "Skipped types that were rearranged: none"],
  [/^分离：(.+)　断开 (\d+) 条$/, "Detach: $1 — $2 links removed"],
  [/^直连回去 (\d+) 条$/, "$1 reconnected directly"],
  [/^失败 (\d+) 条$/, "$1 failed"],
  [/^(.+) 插进 (.+) → (.+) 之间$/, "$1 inserted between $2 → $3"],
  [/^(\d+) 个节点串进 (.+) → (.+)$/, "$1 nodes chained into $2 → $3"],
  [/^(.+)　（原来 (.+) 在前）$/, "$1　(originally $2 came first)"],
  [/^对调的类型：(.+)$/, "Swapped types: $1"],
  [/^结果：上游 (\d+) 条$/, "Result: $1 upstream"],
  [/^没动的类型：(.+)$/, "Types left untouched: $1"],
  [/^摆正的跳过类型：(.+)$/, "Skipped types that were rearranged: $1"],
  [/^摆正了跳过类型：(.+)$/, "Rearranged skipped types: $1"],
  [/^断开的悬空线：(.+)$/, "Dangling links removed: $1"],
  [/^(  out .+) 已失效$/, "$1 (stale)"],

  /* 确认条 */
  [/^还有 1 条线可以顺路穿过去$/, "1 more link could be routed through"],
  [/^还有 (\d+) 条线可以顺路穿过去$/, "There are $1 more links that could be routed through"],
  [
    /^接上之后这几条线会多绕一道 (.+)，原来的图不会断。$/,
    "If connected, these links would detour through $1 — nothing else in the graph breaks.",
  ],
  [/^接上了 (\d+) \/ (\d+) 条$/, "Connected $1 of $2"],
];

/** 整份报告逐行过一遍 tr：段落标题和技术行都靠这一层 */
function trBlock(text) {
  if (menuLang() === "zh") return text;
  return String(text ?? "")
    .split("\n")
    .map((line) => tr(line))
    .join("\n");
}

function tr(text) {
  if (menuLang() === "zh") return text;

  const s = String(text ?? "");
  if (!s) return s;

  if (Object.prototype.hasOwnProperty.call(EN_TEXT, s)) return EN_TEXT[s];

  // 「A · B · C」这种拼起来的串，切开逐段翻，节点名翻不了就原样留着
  if (s.includes("·")) {
    const segs = s.split(/\s*·\s*/);
    if (segs.length > 1) return segs.map((x) => tr(x)).join(" · ");
  }

  for (const [re, to] of EN_RULES) {
    // 列表里的顿号顺手换成英文逗号，别让英文句子里蹦出个「、」
    if (re.test(s)) return s.replace(re, to).replace(/、/g, ", ");
  }
  return s;
}

const ANCHOR_RE = /刷新节点|重新加载节点|Reload\s*Node|Refresh\s*Node/i;

/** 把译文里的 {A}/{B}/{N} 占位符换成真实内容（只换第一层，不做二次解析） */
function fillTpl(tpl, map) {
  return String(tpl).replace(/\{([A-Za-z]+)\}/g, (m, k) => (map[k] ?? m));
}

function entryText(el) {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** 当前弹出的菜单根节点（取最后一个，避免命中没清干净的旧菜单） */
function currentMenuRoot() {
  const label = menuText();
  const roots = [...document.querySelectorAll(".litecontextmenu")];
  let hit = null;
  for (const root of roots) {
    const entries = [...root.querySelectorAll(".litemenu-entry")];
    if (entries.some((el) => entryText(el).includes(label))) hit = root;
  }
  return hit;
}

/** @returns {boolean} true = 已处理完毕，可以停止轮询 */
function moveNearAnchor() {
  const root = currentMenuRoot();
  if (!root) return false; // 菜单还没建出来，继续等

  const label = menuText();
  const entries = [...root.querySelectorAll(".litemenu-entry")];
  const ours = entries.find((el) => entryText(el).includes(label));
  if (!ours) return true;

  const parent = ours.parentElement;
  if (!parent) return true;

  // 锚点：菜单里的「刷新节点 / Refresh Node」
  const anchor = [...parent.children].find(
    (el) =>
      el !== ours &&
      !el.classList.contains("separator") &&
      ANCHOR_RE.test(entryText(el))
  );

  const target = anchor ? anchor.nextElementSibling : parent.firstElementChild;
  if (target === ours) return true; // 已经就位

  try {
    if (anchor) {
      parent.insertBefore(ours, anchor.nextElementSibling); // 紧跟锚点之后
    } else {
      // 找不到锚点（对方插件没装/改名了）：退而放到菜单最顶上
      parent.insertBefore(ours, parent.firstElementChild);
    }
  } catch (err) {
    console.warn(LOG, "调整菜单项位置失败", err);
  }
  return true;
}

function scheduleMenuReposition() {
  let tries = 0;
  const tick = () => {
    if (moveNearAnchor() || ++tries > 120) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** 调试用：打印当前菜单的全部条目文字 */
function dumpMenu() {
  const root = currentMenuRoot() || document.querySelector(".litecontextmenu");
  if (!root) return console.log(LOG, "当前没有打开的右键菜单");
  const list = [...root.querySelectorAll(".litemenu-entry")].map((el, i) => `${i}. ${entryText(el)}`);
  console.log(`${LOG} 菜单条目：\n` + list.join("\n"));
  return list;
}

function buildMenuItem(contextNode) {
  const sel = selectedNodes();
  const selIds = new Set(sel.map((n) => n.id));
  const count = contextNode && !selIds.has(contextNode.id) ? 1 : sel.length;

  let content = `🔄 ${menuText()}…`;
  if (count > 1) {
    content += menuLang() === "zh" ? `（将替换 ${count} 个）` : ` (replacing ${count} nodes)`;
  }

  return {
    content,
    callback: () => arm(contextNode),
  };
}

/** 旧版前端兜底：包装 LGraphCanvas.prototype.getNodeMenuOptions */
function patchLegacyMenu() {
  let proto = null;
  try {
    proto = app.canvas?.constructor?.prototype ?? LG()?.LGraphCanvas?.prototype ?? null;
  } catch (err) {
    proto = null;
  }
  if (!proto || typeof proto.getNodeMenuOptions !== "function") return false;
  if (proto.__cnrPatched) return true;

  const original = proto.getNodeMenuOptions;
  proto.getNodeMenuOptions = function (node) {
    const options = original.apply(this, arguments) || [];
    if (!newMenuApiUsed && node) {
      options.push(null);
      options.push(buildMenuItem(node));
      scheduleMenuReposition();
    }
    return options;
  };
  proto.__cnrPatched = true;
  return true;
}

app.registerExtension({
  name: EXT_NAME,

  async setup() {
    patchLegacyMenu();
    // 排查用：F12 里执行 cnr.dumpMenu() 可打印当前节点菜单的全部条目
    window.cnr = {
      dumpMenu,
      moveNearAnchor,
      linkCountOf,
      // 排查用：cnr.links() 打印当前选中节点的连线数，判断方向会怎么走
      links() {
        return selectedNodes().map((n) => ({ id: n.id, name: displayName(n), links: linkCountOf(n) }));
      },
      // 排查用：cnr.dump() 导出连线报告（选中了节点就只导选中的，否则导全图）
      // 结果会同时写进 console 并复制到剪贴板
      dump() {
        const g = app.graph;
        const nodes = selectedNodes();
        const list = nodes.length ? nodes : (g?._nodes ?? []);
        const text = dumpText(list, g);
        lastReport = text;
        console.log(`${LOG} 连线报告\n${text}`);
        try {
          globalThis.navigator?.clipboard?.writeText(text);
        } catch (err) {
          /* ignore */
        }
        return `已导出 ${list.length} 个节点，并复制到剪贴板`;
      },
      // 排查用：cnr.last() 取回上一次替换的完整报告（替换后也会自动复制到剪贴板）
      last() {
        return lastReport ?? "还没有执行过替换。";
      },
      // 排查用：cnr.copy() 把上一次的报告重新复制到剪贴板
      copy() {
        if (!lastReport) return "还没有执行过替换。";
        try {
          globalThis.navigator?.clipboard?.writeText(lastReport);
          return "已复制";
        } catch (err) {
          return String(err);
        }
      },
      // 排查用：cnr.swap(前, 后) 直接对调两个节点的次序；cnr.pair(a, b) 看它们是不是一前一后
      swap(a, b) {
        return swapOrder(a, b);
      },
      pair(a, b) {
        const p = orderPair(a, b, app.graph);
        return p ? `一前一后：${displayName(p[0])} → ${displayName(p[1])}` : "没有上下游通路";
      },
      get version() {
        return VERSION;
      },
    };
    // 老版本把橙点写进了 node.boxcolor（会被存进工作流），顺手清掉
    const cleanedMarks = cleanBakedMarks(app.graph);
    if (cleanedMarks) {
      console.log(`${LOG} 清掉 ${cleanedMarks} 个残留的橙色标记（v3.13.0 及更早写进工作流的）`);
    }

    console.log(
      `${LOG} v${VERSION} 已加载 — 右键节点 → 替换节点…，然后左键点另一个节点`
        + `（多选后再点：弹面板选「合并成一个」或「分别替换」；两个一前一后：可「交换顺序」）`,
    );
  },

  /** 工作流加载时顺手清掉老版本写死在节点上的橙点 */
  loadedGraphNode(node) {
    if (node && String(node.boxcolor ?? "").toLowerCase() === MARK_COLOR) {
      node.boxcolor = null;
      node.setDirtyCanvas?.(true, true);
    }
  },

  /** 新版前端的节点右键菜单扩展点 */
  getNodeMenuItems(node) {
    newMenuApiUsed = true;
    if (!node) return [];
    scheduleMenuReposition();
    return [buildMenuItem(node)];
  },

  /** 兜底入口：选中若干节点后，画布空白处右键也能进入替换模式 */
  getCanvasMenuItems() {
    if (!selectedNodes().length) return [];
    return [buildMenuItem(null)];
  },
});
