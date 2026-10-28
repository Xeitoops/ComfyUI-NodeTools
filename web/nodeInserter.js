/**
 * ============================================================
 *  ComfyUI-NodeInserter  v1.10
 *  把节点塞进画布上已有的那条线里（不用手动拆线重连），也能反过来摘出来
 * ============================================================
 *
 *  用法一：插入（鼠标流）
 *    左键点选准备好的节点（可多选，多选会按从左到右串联进去）
 *    → 右键它 → 「➕ 插入到连线…」
 *    → 左键点一下要插入的那条线 → 立即完成
 *    （Esc / 右键 / 点空白 取消；鼠标划过连线会高亮，确认打中的是哪条）
 *
 *  ★ v1.5 命中判定重写（「点了线没反应」的根因）
 *    以前按「控制点水平偏移 max(30, 距离*0.25)」估算线在哪，但 1.5x 前端画线
 *    改成了按插槽的 dir 偏移控制点、取不到方向时不偏移（≈直线），
 *    还有 Straight / Linear 两种渲染模式。估算和实际画出来的对不上，
 *    点击坐标就落在容差外 —— 而且以前点空是**静默退出**，看着就是「没连上」。
 *    现在按每种可能的走法各算一份、取最近的一份命中；没点中一定会给话。
 *
 *  ★ v1.7 补料要找「这条上游原本喂给谁」，不是只找插入位置的终点
 *    CLIP 这类线常常不跟主线走同一个节点（主线进 Stack.in[0]，CLIP 进 Stack.in[1]，
 *    甚至甩到画布另一头）。以前把上游接进新节点之后，改接下游时只认「插入那条线的
 *    终点」和「新节点已有的下游」——两头都碰不上时，就是上游进来了、新节点出口空着、
 *    下游照旧吃原来的上游，看起来像新节点被绕过。
 *    现在按「上游这个输出口的全部下游」改接，扇出几条就改几条。
 *
 *  ★ v1.9 两件事
 *    ①「同下游、不同上游」的兄弟线不再弹确认条，直接穿过新节点。
 *      把端口更多的节点插到某节点前面时，多出来的口等的就是这一步；
 *      弹条不点 = 没插（新节点端口空着，原线还绕过它走）。
 *      只剩「同上游扇出去的支线」才问。
 *    ②插完自动把文字报告复制到剪贴板：插入前后每个口的连线快照、
 *      哪条接了、哪条没接、哪些口还空着。截图看不出「线是谁连的」，
 *      以后直接粘文字。
 *
 *  ★ v1.10 补输入口不再被「出口有没有空位」挡住
 *    以前补一个空输入口之前，先要求新节点上有**空着**的同类型输出口，
 *    没有就整条 continue —— 结果是输入口也不补，图上直接缺一条线。
 *    出口占着不奇怪：同一份数据扇给多个下游是正常接法，而且兄弟线那一步
 *    也可能已经先占了一个。现在两件事拆开：输入照补，出口优先挑空的、
 *    都在用就接着用；真的没有这个类型的出口，才在报告里写明「进得来出不去」。
 *
 *  用法二：分离（插入的逆操作）
 *    右键节点 → 「✂ 从连线中分离」→ 上游直连回下游，节点留下但没线了
 *
 *  行为：
 *    · 上游 → 新节点 → 下游，两段线自动接上，原连线断开
 *    · 一对节点之间有多根线（model/clip）时，类型对得上的一起改道
 *    · 新节点按点击位置摆放（输入槽对齐鼠标），必要时下游节点自动右移让位
 *    · 槽位按「类型兼容 + 精确同型优先 + 空槽优先」挑选，类型不兼容绝不硬接
 *    · 每次操作在 workflow.changeTracker 里留一个撤销点，Ctrl+Z 可整体还原
 * ============================================================
 */

import { app } from "../../scripts/app.js";

const EXT_NAME = "ComfyUI.NodeInserter";
const VERSION = "1.0.0";
const LOG = "[NodeInserter]";

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

/** graph.links 在新旧版本里可能是普通对象，也可能是 Map */
function getLink(graph, id) {
  if (!graph || id === null || id === undefined) return null;
  const links = graph.links ?? graph._links;
  if (!links) return null;
  if (typeof links.get === "function") return links.get(id) ?? null;
  return links[id] ?? null;
}

function eachLink(graph, fn) {
  const links = graph?.links ?? graph?._links;
  if (!links) return;
  if (typeof links.forEach === "function" && typeof links.get === "function") {
    links.forEach((l, k) => fn(l, k));
    return;
  }
  for (const k of Object.keys(links)) fn(links[k], k);
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

/* ============================================================
 * 撤销：ComfyUI 的机制是「操作结束后拍一张快照」
 * ------------------------------------------------------------
 * 前端把整个工作流序列化成 JSON 存在 workflow.changeTracker.activeState 里，
 * 每次操作结束调用 captureCanvasState()，它会跟当前画布比一比，
 * 不一样就把「变化前的那份」压进 undoQueue。Ctrl+Z 就是弹出它重新 loadGraphData。
 *
 * 问题在于：这个 tracker 只挂在 activeWorkflow 上，没有对外 API。
 * 老的 graph.beforeChange() 在这个版本里不会转发到 tracker（会调
 * canvas.onBeforeChange，而这个回调没人注册），所以指望它记撤销是空的。
 *
 * 三条路按顺序试：
 *   1. 从 pinia 里拿到 workflow store → activeWorkflow.changeTracker
 *   2. 官方的 litegraph:canvas 事件（canvas.emitBeforeChange / emitAfterChange）
 *   3. 实在拿不到，就模拟一次 window 上的 mouseup —— 前端自己就是拿它当
 *      「一次操作结束了」的兜底信号（ChangeTracker.init 里的监听）
 * ============================================================ */

let changeDepth = 0;
let piniaCache = null;
let warnedCount = false;

function piniaOf() {
  if (piniaCache) return piniaCache;
  try {
    // Vue 3 会在挂载元素上留一个 __vue_app__
    const el =
      document.getElementById("vue-app") ||
      document.querySelector("#vue-app") ||
      document.body?.firstElementChild;
    const vueApp = el?.__vue_app__;
    const p = vueApp?.config?.globalProperties?.$pinia;
    if (p?._s?.get) piniaCache = p;
  } catch (err) {
    /* ignore */
  }
  return piniaCache;
}

/** 当前工作流的 ChangeTracker（拿不到返回 null） */
function changeTracker() {
  try {
    const direct =
      app.extensionManager?.workflow?.activeWorkflow ??
      app.workflowManager?.activeWorkflow ??
      null;
    if (direct?.changeTracker) return direct.changeTracker;

    const store = piniaOf()?._s?.get?.("workflow");
    return store?.activeWorkflow?.changeTracker ?? null;
  } catch (err) {
    return null;
  }
}

function beginChange() {
  changeDepth++;
  if (changeDepth > 1) return;

  // 老接口，有的版本靠它；不吃亏
  try {
    app.graph?.beforeChange?.();
  } catch (err) {
    /* ignore */
  }
  // 官方事件接口
  try {
    app.canvas?.emitBeforeChange?.();
  } catch (err) {
    /* ignore */
  }
  // 直接开事务（和上面重复计数也没关系，afterChange 会一减一）
  try {
    changeTracker()?.beforeChange?.();
  } catch (err) {
    /* ignore */
  }
}

function endChange() {
  if (changeDepth === 0) return;
  changeDepth--;
  if (changeDepth > 0) return;

  try {
    app.graph?.afterChange?.();
  } catch (err) {
    /* ignore */
  }
  try {
    app.canvas?.emitAfterChange?.();
  } catch (err) {
    /* ignore */
  }

  const t = changeTracker();
  if (t) {
    // 正常情况：计数归零 → 自动拍快照
    try {
      t.afterChange?.();
    } catch (err) {
      /* ignore */
    }
    // 万一别的地方漏了个 beforeChange，把计数带歪了，
    // 这里兜一下，不然撤销会永久失效（captureCanvasState 见到计数非 0 直接返回）
    if (t.changeCount !== 0) {
      if (!warnedCount) {
        warnedCount = true;
        console.warn(LOG, "撤销事务计数没归零，已修正", t.changeCount);
      }
      t.changeCount = 0;
    }
    try {
      t.captureCanvasState?.();
    } catch (err) {
      /* ignore */
    }
  } else {
    // 拿不到 tracker：用前端自己的 mouseup 兜底
    try {
      window.dispatchEvent(new MouseEvent("mouseup"));
    } catch (err) {
      /* ignore */
    }
  }
}

/** 没开事务、改完想单独记一个撤销点时用这个 */
function commitUndo() {
  const t = changeTracker();
  if (t?.captureCanvasState) {
    // 计数被别处带歪的话，这里直接拍快照会静默失败
    if (t.changeCount > 0) t.changeCount = 0;
    try {
      t.captureCanvasState();
      return true;
    } catch (err) {
      /* ignore */
    }
  }
  try {
    window.dispatchEvent(new MouseEvent("mouseup"));
  } catch (err) {
    /* ignore */
  }
  return false;
}

function nodeName(n) {
  return n?.title || n?.type || "节点";
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
  if (sel) for (const n of Object.values(sel)) add(n);

  if (!out.length && Array.isArray(app.graph?._nodes)) {
    for (const n of app.graph._nodes) if (n?.selected) add(n);
  }
  return out;
}

/* ============================================================
 * 二、连线几何：把每条线的走线采样成折线，用于命中判断
 * ============================================================ */

/** 画布元素 */
function canvasElement() {
  try {
    return app.canvas?.canvas ?? app.canvasEl ?? null;
  } catch (err) {
    return null;
  }
}

/** 屏幕坐标 → 图坐标（考虑画布缩放 / 平移） */
function eventToGraph(e) {
  const cnv = app.canvas;
  const el = canvasElement();
  if (!cnv || !el) return null;
  const rect = el.getBoundingClientRect();
  const ds = cnv.ds ?? { scale: 1, offset: [0, 0] };
  const scale = ds.scale || 1;
  return {
    x: (e.clientX - rect.left) / scale - (ds.offset?.[0] ?? 0),
    y: (e.clientY - rect.top) / scale - (ds.offset?.[1] ?? 0),
    scale,
    el,
  };
}

/** 某个插槽中心在图坐标里的位置 */
function slotPos(node, index, isInput) {
  try {
    // getSlotPosition 会自己处理「Vue 节点模式」等特殊排版
    if (typeof node.getSlotPosition === "function") {
      const p = node.getSlotPosition(index, isInput);
      if (p && isFinite(p[0]) && isFinite(p[1])) return [p[0], p[1]];
    }
  } catch (err) {
    /* ignore */
  }
  try {
    const p = isInput ? node.getInputPos?.(index) : node.getOutputPos?.(index);
    if (p && isFinite(p[0]) && isFinite(p[1])) return [p[0], p[1]];
  } catch (err) {
    /* ignore */
  }
  // 兜底：大概位置
  const w = node.size?.[0] ?? 200;
  const h = node.size?.[1] ?? 100;
  return isInput ? [node.pos[0], node.pos[1] + h * 0.5] : [node.pos[0] + w, node.pos[1] + h * 0.5];
}

/** 这条线经过的中转点（Reroute）坐标，按 上游→下游 排序 */
function rerouteChain(graph, link) {
  const out = [];
  const store = graph?.reroutes;
  if (!store) return out;

  let pid = link?.parentId;
  let guard = 0;
  while (pid !== null && pid !== undefined && guard++ < 200) {
    const r = typeof store.get === "function" ? store.get(pid) : store[pid];
    if (!r) break;
    out.unshift([r.pos[0], r.pos[1]]);
    pid = r.parentId;
  }
  return out;
}

function bezier(p0, c1, c2, p1, u) {
  const v = 1 - u;
  const a = v * v * v;
  const b = 3 * v * v * u;
  const c = 3 * v * u * u;
  const d = u * u * u;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1],
  ];
}

/**
 * 把一条线的走线采样成折线。
 *
 * 形状必须和前端**真正画出来的**一致，否则点在线上的坐标会落在容差外面，
 * 表现就是「点了线，什么也没发生」（v1.5 修的正是这个）。
 *
 * 前端（1.5x）的规则：
 *   · 有个全局设置 `Comfy.LinkRenderMode`：0=Straight / 1=Linear / 2=Spline，
 *     它会同步到 `canvas.links_render_mode`。
 *   · Spline 的控制点 = 端点 ± max(30, 两端直线距离*0.25)，
 *     偏移方向取插槽自己的 `dir`（left/right/up/down）；**取不到方向时偏移是 0**，
 *     也就是退化成一条直线 —— 老版本这里是固定往右偏，两者差别很大。
 *   · 有线经过中转点（Reroute）时，按中转点分段。
 *
 * 所以这里按「每种可能的走法」各算一份，命中判断时取最近的那份（见 linkVariants）。
 *
 * @param {"spline"|"splineClassic"|"straight"|"linear"|"chord"} kind
 */
function buildPolyline(graph, link, kind) {
  const a = graph.getNodeById(link.origin_id);
  const b = graph.getNodeById(link.target_id);
  if (!a || !b) return null;

  const start = link.origin_slot === -1
    ? [a.pos[0] + 10, a.pos[1] + 10]
    : slotPos(a, link.origin_slot, false);
  const end = link.target_slot === -1
    ? [b.pos[0] + 10, b.pos[1] + 10]
    : slotPos(b, link.target_slot, true);

  const sDir = slotDirOf(a.outputs?.[link.origin_slot]) ?? (kind === "splineClassic" ? "right" : null);
  const eDir = slotDirOf(b.inputs?.[link.target_slot]) ?? (kind === "splineClassic" ? "left" : null);

  const mids = rerouteChain(graph, link);
  const stops = [start, ...mids, end];
  const pts = [];

  for (let i = 0; i < stops.length - 1; i++) {
    const s = stops[i];
    const t = stops[i + 1];
    const dist = Math.hypot(t[0] - s[0], t[1] - s[1]);
    const off = Math.max(30, dist * 0.25);

    if (kind === "chord") {
      pts.push(s, t);
      continue;
    }

    if (kind === "linear") {
      const o1 = sDir ? dirVec(sDir, 15) : [0, 0];
      const o2 = eDir ? dirVec(eDir, 15) : [0, 0];
      pts.push(s, [s[0] + o1[0], s[1] + o1[1]], [t[0] + o2[0], t[1] + o2[1]], t);
      continue;
    }

    if (kind === "straight") {
      const o1 = sDir ? dirVec(sDir, 10) : [0, 0];
      const o2 = eDir ? dirVec(eDir, 10) : [0, 0];
      const p1 = [s[0] + o1[0], s[1] + o1[1]];
      const p2 = [t[0] + o2[0], t[1] + o2[1]];
      const mx = (p1[0] + p2[0]) / 2;
      pts.push(s, p1, [mx, p1[1]], [mx, p2[1]], p2, t);
      continue;
    }

    // spline：控制点按方向偏移；方向缺失时偏移为 0（前端就是这么退化的）
    const o1 = sDir ? dirVec(sDir, off) : [0, 0];
    const o2 = eDir ? dirVec(eDir, off) : [0, 0];
    const c1 = [s[0] + o1[0], s[1] + o1[1]];
    const c2 = [t[0] + o2[0], t[1] + o2[1]];
    const steps = 16;
    for (let k = 0; k <= steps; k++) pts.push(bezier(s, c1, c2, t, k / steps));
  }
  return pts;
}

/** 插槽自己声明的朝向；没有就返回 null（前端此时不偏移控制点） */
function slotDirOf(slot) {
  const d = slot?.dir;
  if (d === "left" || d === "right" || d === "up" || d === "down") return d;
  return null;
}

function dirVec(dir, len) {
  switch (dir) {
    case "left": return [-len, 0];
    case "right": return [len, 0];
    case "up": return [0, -len];
    case "down": return [0, len];
    default: return [0, 0];
  }
}

/** 画布现在用的是哪种画线方式（0 Straight / 1 Linear / 2 Spline） */
function linkRenderMode() {
  const m = app.canvas?.links_render_mode;
  if (m === 0 || m === "0") return 0;
  if (m === 1 || m === "1") return 1;
  return 2;
}

/**
 * 一条线的候选取线：第一个是「当前渲染模式 + 插槽方向」算出的那份（满容差），
 * 第二个只在 Spline 模式下补一份「老版本固定往右偏」的（容差打折），
 * 兼顾旧前端，又不会因为幻影路径插到别的线上。
 */
function linkVariants(graph, link) {
  const mode = linkRenderMode();
  const kind = mode === 0 ? "straight" : mode === 1 ? "linear" : "spline";

  const out = [];
  const primary = buildPolyline(graph, link, kind);
  if (primary && primary.length >= 2) out.push({ kind, pts: primary });

  if (kind === "spline") {
    const legacy = buildPolyline(graph, link, "splineClassic");
    if (legacy && legacy.length >= 2) out.push({ kind: "splineClassic", pts: legacy });
  }
  return out;
}

function distToSegment(px, py, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(px - a[0], py - a[1]);
  let t = ((px - a[0]) * vx + (py - a[1]) * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
}

function distToPolyline(px, py, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSegment(px, py, pts[i], pts[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

/** 鼠标位置下面是节点还是线？节点优先（避免双击节点标题时误判到身后的线） */
function nodeAt(graph, x, y) {
  try {
    return graph.getNodeOnPos?.(x, y, graph._nodes, 0) ?? null;
  } catch (err) {
    return null;
  }
}

/**
 * 鼠标位置命中的那条线。
 * @param {number} tol 容差（图坐标，屏幕像素除以缩放）
 */
function findLinkAt(x, y, tol) {
  const graph = app.graph;
  if (!graph) return null;

  // 点在节点上：先看是不是正对某个「输入插槽」，是就直接用那条进来的线
  const onNode = nodeAt(graph, x, y);
  if (onNode) {
    const viaSlot = inputSlotLinkAt(graph, onNode, x, y);
    if (viaSlot) return viaSlot;
    // 没点中插槽也不能就此放弃：线经常从节点上方 / 旁边穿过去，
    // 点在那段线上时鼠标底下偏偏是个节点（v1.5 之前这里直接返回 null，
    // 表现就是「点了线没反应」）。
  }

  let best = null;
  let bestD = Infinity;
  eachLink(graph, (link) => {
    if (!link || link.origin_id === undefined || link.target_id === undefined) return;
    const variants = linkVariants(graph, link);
    for (let i = 0; i < variants.length; i++) {
      const lim = i === 0 ? tol : tol * 0.7; // 非当前渲染方式的那几份，容差打折
      const d = distToPolyline(x, y, variants[i].pts);
      if (d <= lim && d < bestD) {
        bestD = d;
        best = link;
      }
    }
  });
  return best;
}

/** 离鼠标最近的那条线有多远（只在没命中时打日志用，排查「点不动」） */
function nearestLinkInfo(x, y) {
  const graph = app.graph;
  if (!graph) return null;
  let info = null;
  eachLink(graph, (link) => {
    if (!link || link.origin_id === undefined || link.target_id === undefined) return;
    for (const v of linkVariants(graph, link)) {
      const d = distToPolyline(x, y, v.pts);
      if (!info || d < info.dist) {
        const a = graph.getNodeById(link.origin_id);
        const b = graph.getNodeById(link.target_id);
        info = {
          dist: Math.round(d * 10) / 10,
          kind: v.kind,
          link: `${nodeName(a)}.out[${link.origin_slot}] → ${nodeName(b)}.in[${link.target_slot}]`,
        };
      }
    }
  });
  return info;
}

/**
 * 点在节点身上时，判断是不是点在某个「输入插槽」上。
 * 这条路径不受曲线近似误差影响，是点线之外的第二个取线入口。
 */
function inputSlotLinkAt(graph, node, x, y) {
  try {
    const hit = node.getSlotInPosition?.(x, y);
    if (hit) {
      if (hit.input && hit.input.link !== null && hit.input.link !== undefined) {
        return getLink(graph, hit.input.link);
      }
      return null; // 点到输出口 / 空输入口 → 不算
    }
  } catch (err) {
    /* ignore */
  }

  let best = null;
  let bestD = 16;
  (node.inputs ?? []).forEach((s, i) => {
    if (s?.link === null || s?.link === undefined) return;
    const p = slotPos(node, i, true);
    if (!p) return;
    const d = Math.hypot(x - p[0], y - p[1]);
    if (d < bestD) {
      bestD = d;
      best = getLink(graph, s.link);
    }
  });
  return best;
}

/* ============================================================
 * 三、槽位挑选
 * ============================================================ */

function slotIsFree(slot, isInput) {
  // 空输入的 link 可能是 null / undefined，老版 litegraph 也有用 -1 的，
  // 只认 null 会把它当成「已被占用」，白白错过一个能接的口
  if (isInput) {
    const v = slot?.link;
    return v === null || v === undefined || v === -1;
  }
  return (slot?.links?.length ?? 0) === 0;
}

/**
 * 在节点上找一个能用的插槽。
 *
 * @param {LGraphNode} node
 * @param {boolean} isInput true = 输入位（要吃进 dataType），false = 输出位（要送出 dataType）
 * @param {string} dataType 这条线上流动的数据类型
 * @returns {number} 槽位下标，-1 表示没找到
 *
 * 打分：精确同类型 > 通配类型；空槽优先；下标靠前的优先。
 * 输入位已被占用的一律不用（绝不为了插入而拆掉别的连线）。
 */
function pickSlot(node, isInput, dataType, opts = {}) {
  const slots = (isInput ? node.inputs : node.outputs) ?? [];
  const want = typeTokens(dataType);
  const used = opts.used ?? null;
  const onlyFree = opts.onlyFree === true;

  let best = -1;
  let bestScore = -Infinity;

  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s) continue;
    if (used && used.has(i)) continue;                 // 这一轮已经许给别人了
    if (onlyFree && !slotIsFree(s, isInput)) continue;  // 只挑空着的

    // 输入位：槽位类型要能收下 dataType；输出位：下游要能收下槽位类型
    const ok = isInput ? compatible(s.type, dataType) : compatible(dataType, s.type);
    if (!ok) continue;

    const st = typeTokens(s.type);
    let score = 0;
    if (!st.includes("*") && st.some((t) => want.includes(t))) score += 100;
    if (st.includes("*") || want.includes("*")) score -= 25;

    const free = slotIsFree(s, isInput);
    if (free) score += 30;
    else if (isInput) score -= 500; // 输入位已有线：基本不用

    // 同样类型的口有好几个时，优先挑「本来就带插槽」的那个。
    // 带 widget 的是参数框（能接线，但接上去等于把本地填的值顶掉），
    // 专门用来接上游的那个入口通常不带框，而同类型的参数输入只是
    // 刚好也写着 STRING，别抢了它的位置。
    if (isInput && s.widget) score -= 40;

    score += Math.max(0, 12 - i) * 0.5;

    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/* ============================================================
 * 四、位置与让位
 * ============================================================ */

function ensureSize(node) {
  try {
    if (!node.size || node.size[0] < 10 || node.size[1] < 10) {
      const sz = node.computeSize?.();
      if (Array.isArray(sz) && sz[0] > 0) node.size = [sz[0], sz[1]];
    }
  } catch (err) {
    /* ignore */
  }
}

/** 把 start 及其所有下游节点整体右移 dx，给新节点腾位置 */
function shiftDownstream(graph, start, dx) {
  if (!start || !dx) return 0;
  const seen = new Set([start.id]);
  const queue = [start];
  let moved = 0;

  while (queue.length) {
    const n = queue.shift();
    try {
      n.pos[0] += dx;
      n.setDirtyCanvas?.(true, true);
      moved++;
    } catch (err) {
      /* ignore */
    }
    for (const out of n.outputs ?? []) {
      for (const lid of out.links ?? []) {
        const l = getLink(graph, lid);
        if (!l) continue;
        const nxt = graph.getNodeById(l.target_id);
        if (!nxt || seen.has(nxt.id)) continue;
        seen.add(nxt.id);
        queue.push(nxt);
      }
    }
  }
  return moved;
}

/**
 * 给新节点安排位置：优先摆在上下游之间的空隙里，
 * 输入槽对齐鼠标点的高度；放不下就把下游右移。
 */
function placeNode(node, origin, target, gx, gy, inIdx, fromNode) {
  ensureSize(node);
  const W = node.size?.[0] ?? 200;
  const H = node.size?.[1] ?? 100;

  // 串联插入时紧挨着上一个节点往右排，不然几个节点会叠在同一个点上
  const anchor = fromNode ?? origin;
  const aRight = anchor.pos[0] + (anchor.size?.[0] ?? 0);
  const bLeft = target.pos[0];
  const gap = bLeft - aRight;
  const pad = 34;

  let x;
  if (fromNode) {
    x = aRight + pad;
  } else if (gap >= W + pad * 2) {
    x = aRight + pad + (gap - W - pad * 2) / 2;
  } else {
    x = bLeft - W - pad;
  }

  node.pos[0] = x;

  // 先给个大概的 y，再按输入槽对齐鼠标
  const baseY = (typeof gy === "number" ? gy : target.pos[1]) - H / 2;
  node.pos[1] = baseY;
  const p = slotPos(node, inIdx, true);
  if (p && isFinite(p[1])) node.pos[1] += (typeof gy === "number" ? gy : p[1]) - p[1];

  // 别把节点摆到画布左上角外面去
  if (node.pos[1] < -2000) node.pos[1] = -2000;

  // 压到下游了就整体右移
  const need = node.pos[0] + W + 30 - target.pos[0];
  if (need > 1) shiftDownstream(app.graph, target, need);

  node.setDirtyCanvas?.(true, true);
}

/* ============================================================
 * 五、核心：把节点插进一条连线
 * ============================================================ */

/** 上一次插入生成的「新节点 → 下游」那条线的 id（多选串联时接着它往下插） */
let lastInsertOutLinkId = null;
/** 上一次插入顺路接上的平行线数量（串联时汇总用） */
let lastInsertAutoCount = 0;

function safeConnect(fromNode, fromSlot, toNode, toSlot, rerouteId) {
  if (rerouteId !== null && rerouteId !== undefined) {
    try {
      const l = fromNode.connect(fromSlot, toNode, toSlot, rerouteId);
      if (l) return l;
    } catch (err) {
      console.warn(LOG, "带中转点连接失败，改用普通连接", err);
    }
  }
  try {
    return fromNode.connect(fromSlot, toNode, toSlot) ?? null;
  } catch (err) {
    console.warn(LOG, "连接失败", err);
    return null;
  }
}

/* ============================================================
 * 五-0、操作报告（自动复制到剪贴板）
 * ------------------------------------------------------------
 * 截图看不出「这根线到底是谁连的」，出问题只能靠文字复现。
 * 每次插入 / 分离结束后打一份快照：相关节点每个口连到哪儿，
 * 这次想接什么、接上了什么、哪条没接、为什么没接。
 *
 * 格式和替换插件（NodeReplacer）保持一致，两边可以对着看。
 * ============================================================ */

let lastReport = null;

function nodeTag(n) {
  return n ? `${nodeName(n)}#${n.id}` : "?";
}

function dumpNodeLines(node, graph) {
  if (!node) return ["(节点不存在)"];
  const rows = [];

  rows.push(
    `── ${nodeTag(node)}  [type=${node.type}]  `
      + `pos ${Math.round(node.pos?.[0] ?? 0)},${Math.round(node.pos?.[1] ?? 0)}`,
  );

  (node.inputs ?? []).forEach((s, i) => {
    const l = getLink(graph, s?.link);
    rows.push(
      l
        ? `  in  [${i}] ${s.name} (${s.type})  ←  ${nodeTag(graph.getNodeById(l.origin_id))}.out[${l.origin_slot}]  link.type=${l.type}`
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
          ? `  out [${i}] ${s.name} (${s.type})  →  ${nodeTag(graph.getNodeById(l.target_id))}.in[${l.target_slot}]  link.type=${l.type}`
          : `  out [${i}] ${s.name} (${s.type})  →  link#${id} 已失效`,
      );
    }
  });

  return rows;
}

function dumpText(nodes, graph) {
  const g = graph ?? app.graph;
  return (nodes ?? [])
    .filter(Boolean)
    .flatMap((n) => [...dumpNodeLines(n, g), ""])
    .join("\n")
    .trimEnd();
}

/** 这个节点 + 跟它直接相连的那些节点（导出报告用，图太大时不至于刷屏） */
function aroundNodes(node, graph) {
  const g = graph ?? app.graph;
  const out = [];
  const seen = new Set();
  const add = (n) => {
    if (n && n.id !== undefined && !seen.has(n.id)) {
      seen.add(n.id);
      out.push(n);
    }
  };
  add(node);
  for (const s of node?.inputs ?? []) {
    const l = getLink(g, s?.link);
    if (l) add(g.getNodeById(l.origin_id));
  }
  for (const s of node?.outputs ?? []) {
    for (const id of s?.links ?? []) {
      const l = getLink(g, id);
      if (l) add(g.getNodeById(l.target_id));
    }
  }
  return out;
}

/** 打个报告：存一份、尽量复制到剪贴板、再写进 console */
function publishReport(kind, headline, sections) {
  const text = trBlock([
    `ComfyUI-NodeInserter v${VERSION} — ${tr(kind)}`,
    ...(headline ? [headline] : []),
    "",
    ...(sections ?? []),
  ].join("\n"));
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

/**
 * @param {LGraphNode} node 要插进去的节点（画布上已有的，或刚创建还没连的）
 * @param {object} link 目标连线
 * @param {{gx?:number, gy?:number}} opts 鼠标位置（用来摆放节点）
 * @returns {boolean}
 */
function insertNodeIntoLink(node, link, opts = {}) {
  const graph = app.graph;
  if (!graph || !node || !link) return false;

  const origin = graph.getNodeById(link.origin_id);
  const target = graph.getNodeById(link.target_id);

  if (!origin || !target) {
    toast(
      "error",
      "这条线接不到两端节点",
      "可能指向子图的输入 / 输出，或连线已经失效，暂不支持插入。",
      7000
    );
    return false;
  }
  if (node === origin || node === target) {
    toast("warn", "不能插在自己所在的那条线上", "换一个节点或者换一条线。", 5000);
    return false;
  }

  /* ---- 这条线上流的是什么类型 ---- */
  const inType =
    origin.outputs?.[link.origin_slot]?.type ??
    link.type ??
    target.inputs?.[link.target_slot]?.type ??
    "*";
  const outType =
    target.inputs?.[link.target_slot]?.type ??
    link.type ??
    inType;

  const inIdx = pickSlot(node, true, inType);
  const outIdx = pickSlot(node, false, outType);

  if (inIdx < 0) {
    toast(
      "error",
      `${nodeName(node)} 接不上这条线的上游`,
      `它没有能接收 ${inType} 类型的输入位。`,
      8000
    );
    return false;
  }
  if (outIdx < 0) {
    toast(
      "error",
      `${nodeName(node)} 接不上这条线的下游`,
      `它没有能输出 ${outType} 类型的输出位。`,
      8000
    );
    return false;
  }
  if (!slotIsFree(node.inputs?.[inIdx], true)) {
    toast(
      "warn",
      `${nodeName(node)} 的 ${node.inputs[inIdx]?.name ?? "输入"} 位已经被占用`,
      "为了不破坏别的连线，这次没有插入。",
      8000
    );
    return false;
  }

  /* ---- 接线之前先用前端自己的规则验一遍，避免拆了线才发现接不上 ---- */
  const L = LG();
  if (typeof L?.isValidConnection === "function") {
    const slotIn = typeTokens(node.inputs?.[inIdx]?.type);
    const slotOut = typeTokens(node.outputs?.[outIdx]?.type);
    const okIn = L.isValidConnection(inType, node.inputs?.[inIdx]?.type ?? inType);
    const okOut = L.isValidConnection(node.outputs?.[outIdx]?.type ?? outType, outType);
    if (!okIn || !okOut) {
      toast(
        "error",
        `${nodeName(node)} 的类型对不上这条线`,
        `${inType} → [${slotIn.join("/")} … ${slotOut.join("/")}] → ${outType}`,
        9000
      );
      return false;
    }
  }

  const rerouteId = link.parentId ?? null;
  const linkId = link.id;

  // 动手之前先拍一张：出问题时能对比「本来是什么样、被我改成什么样」
  const beforeText = dumpText([origin, node, target], graph);

  beginChange();
  try {
    /* ---- 1. 断开原来那条线 ---- */
    let removed = false;
    try {
      if (typeof graph.removeLink === "function") {
        graph.removeLink(linkId);
        removed = true;
      }
    } catch (err) {
      console.warn(LOG, "removeLink 失败，改用 disconnectInput", err);
    }
    if (!removed) {
      try {
        target.disconnectInput(link.target_slot);
      } catch (err) {
        /* ignore */
      }
    }

    /* ---- 2. 上游 → 新节点 ---- */
    const l1 = safeConnect(origin, link.origin_slot, node, inIdx, rerouteId);
    if (!l1) {
      // 接不上就把原来的线接回去，别留下一个断掉的图
      safeConnect(origin, link.origin_slot, target, link.target_slot, rerouteId);
      toast("error", "上游没接上，已还原原来的连线", "这条线的类型可能不被这个节点接受。", 9000);
      return false;
    }

    /* ---- 3. 新节点 → 下游 ---- */
    const l2 = safeConnect(node, outIdx, target, link.target_slot, null);
    if (!l2) {
      toast(
        "error",
        "下游没接上",
        `已把 ${nodeName(origin)} 接到 ${nodeName(node)}，剩下的请手动补一根线。`,
        9000
      );
      return false;
    }

    /* ---- 3.5 记下「新节点 → 下游」这条线，多选串联时要用 ---- */
    lastInsertOutLinkId = l2?.id ?? null;
    lastInsertAutoCount = 0;

    /* ---- 4. 摆位置 + 让位 ---- */
    placeNode(node, origin, target, opts.gx, opts.gy, inIdx, opts.placeFrom);

    /* ---- 5. 顺路把兄弟线接上 ---- */
    // 三类：
    //   · 平行线（同上游同下游，比如 model + clip 并排）→ 直接接
    //   · 同下游、不同上游（本来就是喂给被插入那个节点的）→ 也直接接，
    //     插到它前面，它自然该从新节点取料。这类最容易被漏掉：
    //     新节点端口比下游多的时候，多出来的口就等这一步。
    //   · 同上游、不同下游（一根输出扇出去的支线）→ 先问一句，
    //     接上去等于让支线也绕一圈，这个得你点头
    let extraInfo = null;
    if (!opts.noExtras) {
      try {
        const { plan, skipped } = planExtraLinks(node, link, outIdx, inIdx);
        const auto = plan.filter((x) => x.parallel || x.intoTarget);
        const ask = plan.filter((x) => !x.parallel && !x.intoTarget);

        const autoOk = applyExtras(node, auto);
        lastInsertAutoCount = autoOk;

        // 串联插入时先不弹「还有几条」确认条：后面那几个节点还没摆好，
        // 槽位占用情况还会变，等整组插完由调用方统一规划、统一问一次。
        if (opts.collect) {
          // 收集的是「线」本身：整组插完后槽位会变，那时的计划要重算。
          // 这一步因为「这个节点没这种口子」被跳过的也要收进来 ——
          // 组里后面那个节点说不定有，得让整组规划再判一次。
          for (const it of [...ask, ...skipped]) opts.collect.push(it.link);
        }
        extraInfo = {
          autoOk,
          autoList: auto.map((x) => ({
            type: String(x.type),
            from: x.from,
            to: x.to,
            kind: x.parallel ? "平行" : "同下游",
            inName: x.inName,
            outName: x.outName,
          })),
          ask: opts.collect ? [] : ask,
          askList: ask.map((x) => ({ type: String(x.type), from: x.from, to: x.to })),
          skipped: skipped.length,
          skippedList: skipped.map((x) => ({
            type: String(x.type),
            from: `${nodeName(x.origin)}.${slotLabel(x.origin, x.link.origin_slot, false)}`,
            to: `${nodeName(x.target)}.${slotLabel(x.target, x.link.target_slot, true)}`,
          })),
        };
      } catch (err) {
        console.warn(LOG, "补兄弟线时出错", err);
      }
    }

    /* ---- 5.5 新节点上还空着的口：顺着数据链往上找料补上 ---- */
    // 兄弟线只认「同上游 / 同下游」，可很多口子的源头在**上游的上游**
    // （新节点多出来的那个类型就是这样：直接上游没有这个口，再往上一层才有）。
    // 这里沿输入线往上溯三层，补上空的输入口，并把原本绕过新节点的直连改接过来。
    let feedInfo = null;
    if (!opts.noFeed) {
      try {
        feedInfo = feedEmptyInputs(node, graph, { target });
      } catch (err) {
        console.warn(LOG, "补空口时出错", err);
      }
    }

    /* ---- 6. 收尾 ---- */
    node.setDirtyCanvas?.(true, true);
    origin.setDirtyCanvas?.(true, true);
    target.setDirtyCanvas?.(true, true);
    graph.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);

    try {
      app.canvas?.selectNode?.(node, false);
    } catch (err) {
      try {
        if (app.canvas) app.canvas.selected_nodes = { [node.id]: node };
      } catch (err2) {
        /* ignore */
      }
    }

    const bits = [];
    if (extraInfo?.autoOk) bits.push(`顺路接上 ${extraInfo.autoOk} 条线`);
    if (extraInfo?.ask?.length) bits.push(`另有 ${extraInfo.ask.length} 条等你确认`);
    if (extraInfo?.skipped) bits.push(`${extraInfo.skipped} 条接不上`);
    if (feedInfo?.added) {
      const types = [...new Set(feedInfo.pairs.map((p) => p.type))].join("/");
      bits.push(`补上 ${feedInfo.added} 个空口（${types}）`);
    }
    if (feedInfo?.rewired) bits.push(`改接 ${feedInfo.rewired} 条下游`);

    /* ---- 7. 报告：这次到底动了哪些线 ---- */
    // 只报个数没用。把「新节点上仍然空着的口」逐条列出来，
    // 才能一眼看出是哪一类口没接上、是不是本该接。
    const emptyLeft = [];
    (node.inputs ?? []).forEach((s, i) => {
      if (!isAutoPort(s) || !slotIsFree(s, true)) return;
      emptyLeft.push(`in [${i}] ${s.name} (${s.type})`);
    });
    (node.outputs ?? []).forEach((s, i) => {
      if (!isAutoPort(s) || !slotIsFree(s, false)) return;
      emptyLeft.push(`out[${i}] ${s.name} (${s.type})`);
    });

    const sec = [
      `插入：${nodeTag(origin)}.out[${link.origin_slot}] → ${nodeTag(target)}.in[${link.target_slot}]（${inType}）`,
      `新节点：${nodeTag(node)}　进 in[${inIdx}] ${slotLabel(node, inIdx, true)} · 出 out[${outIdx}] ${slotLabel(node, outIdx, false)}`,
      `结果：主线 1 · 顺路 ${extraInfo?.autoOk ?? 0} · 补空口 ${feedInfo?.added ?? 0}`
        + ` · 改接下游 ${feedInfo?.rewired ?? 0} · 待确认 ${extraInfo?.ask?.length ?? 0}`
        + ` · 跳过 ${extraInfo?.skipped ?? 0}`,
      "",
    ];

    if (extraInfo?.autoList?.length) {
      sec.push("【顺路一起接上】");
      for (const it of extraInfo.autoList) {
        sec.push(`  ${it.type}（${it.kind}） ${it.from} → ${it.to}　走 [${it.inName}] → [${it.outName}]`);
      }
      sec.push("");
    }
    if (feedInfo?.pairs?.length) {
      sec.push("【往上找料补的空口】");
      for (const p of feedInfo.pairs) sec.push(`  ${p.type}  ${p.from} → [${p.to}]`);
      sec.push("");
    }
    if (feedInfo?.rewirePairs?.length) {
      sec.push("【改接到新节点后面的下游】");
      for (const p of feedInfo.rewirePairs) sec.push(`  ${p.type}  → ${p.to}`);
      sec.push("");
    }
    if (feedInfo?.left?.length) {
      sec.push("【没能接出去】");
      for (const p of feedInfo.left) sec.push(`  ${p.type}  ${p.why}`);
      sec.push("");
    }
    if (emptyLeft.length) {
      sec.push("【新节点仍然空着的口】");
      for (const s of emptyLeft) sec.push(`  ${s}`);
      sec.push("");
    }
    if (extraInfo?.skippedList?.length) {
      sec.push("【跳过：新节点没有对应的空口】");
      for (const it of extraInfo.skippedList) sec.push(`  ${it.type}  ${it.from} → ${it.to}`);
      sec.push("");
    }
    if (extraInfo?.askList?.length) {
      sec.push("【等你确认的兄弟线】");
      for (const it of extraInfo.askList) sec.push(`  ${it.type}  ${it.from} → ${it.to}`);
      sec.push("");
    }

    // 顺便把下游节点的直接上游也 dump 出来：很多问题就出在
    // 「这条口本来是别人喂的」，只看三个节点会漏掉那个「别人」
    const seenId = new Set([origin.id, node.id, target.id]);
    const around = [origin, node, target];
    for (const s of target.inputs ?? []) {
      const l = getLink(graph, s?.link);
      const n = l ? graph.getNodeById(l.origin_id) : null;
      if (n && !seenId.has(n.id)) {
        seenId.add(n.id);
        around.push(n);
      }
    }

    sec.push("【插入前】", beforeText, "");
    sec.push("【插入后】", dumpText(around, graph));

    // 串联插入时每个节点都是静默跑的，报告由整组那边统一出一份，
    // 不然会连着刷 N 份半成品
    if (!opts.silent) {
      const copied = publishReport(
        "插入",
        `${nodeName(node)} 插进 ${nodeName(origin)} → ${nodeName(target)} 之间`,
        sec,
      );
      toast(
        "success",
        `已插入 ${nodeName(node)}`,
        [
          `${nodeName(origin)} → ${nodeName(node)} → ${nodeName(target)}`,
          ...bits,
          copied ? "连线报告已复制到剪贴板" : "连线报告已写入控制台（F12）",
        ].join("　·　"),
        5200
      );
    }

    console.log(LOG, "插入完成", {
      node: nodeName(node),
      from: nodeName(origin),
      to: nodeName(target),
      inIdx,
      outIdx,
      extras: extraInfo,
      补空口: feedInfo,
    });

    // 等这次插入彻底落地（撤销记录关闭）之后再问，避免打断画布状态
    if (extraInfo?.ask?.length && !opts.silent) {
      const waiting = extraInfo.ask;
      setTimeout(() => askConnectExtras(node, waiting), 80);
    }

    return true;
  } catch (err) {
    console.error(LOG, "插入过程中出错", err);
    toast("error", "插入失败", String(err?.message ?? err));
    return false;
  } finally {
    endChange();
    app.canvas?.setDirty?.(true, true);
  }
}

/* ============================================================
 * 五-2、顺路把「兄弟线」一起接上
 * ------------------------------------------------------------
 * 节点之间常常不止一根线：同一个上游的两种类型会同时接到同一个下游，
 * 下游的几个输入也常常来自不同上游。
 * 一次只会点其中一根，剩下那几根如果不跟着改道，新节点的其它
 * 输入口就空着，图还是断的。
 *
 * 三条规则：
 *   · 同一上游 + 同一下游的平行线（model/clip 并排那种）→ 直接一起接
 *   · 只有一头相邻（同上游不同下游 / 同下游不同上游）→ 弹一句问再接
 *   · 找不到类型对得上又空着的输入/输出位 → 跳过，并在提示里说明
 * ============================================================ */

/** 兼容 link 的两种存法：对象（新前端）/ 数组（老 litegraph） */
function linkParts(l) {
  if (Array.isArray(l)) {
    return {
      id: l[0],
      origin_id: l[1],
      origin_slot: l[2],
      target_id: l[3],
      target_slot: l[4],
      type: l[5],
      parentId: l[6] ?? null,
    };
  }
  return l ?? null;
}

/**
 * 这条线到底是什么类型。
 *
 * 优先信**线自己记的类型**（`link.type`）。槽位上那个 `*` 只是「这个口什么都收」，
 * 不等于「类型未知」—— 透传节点（Reroute、各种 anything 转接）的槽位就是 `*`，
 * 但数据从上游过来时线记的是 `MODEL`，那它就是 MODEL 线。
 *
 * 以前这里优先取起点槽位的声明类型，于是 `*` 盖住了真实的 MODEL：
 * 给新节点挑口时 `*` 跟谁都「兼容」，挑中第一个空口就算数 ——
 * 把 MODEL 线接进了 STRING 的口子，出口再接回下游时被类型挡回来，
 * 留下「进得去出不来」的半截（输入插上了、输出还空着，上游还扇出两条）。
 */
function linkTypeOf(l) {
  const p = linkParts(l);
  const graph = app.graph;
  const o = graph?.getNodeById?.(p.origin_id);
  const t = graph?.getNodeById?.(p.target_id);

  const concrete = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const ts = typeTokens(v);
    return ts.length && !ts.includes("*") ? v : null;
  };

  return (
    concrete(p.type) ??
    concrete(o?.outputs?.[p.origin_slot]?.type) ??
    concrete(t?.inputs?.[p.target_slot]?.type) ??
    p.type ??
    o?.outputs?.[p.origin_slot]?.type ??
    "*"
  );
}

function slotLabel(node, idx, isInput) {
  const s = (isInput ? node.inputs : node.outputs)?.[idx];
  return s?.name ?? (isInput ? "输入" : "输出");
}

/**
 * 算出「这条主线之外，还有哪些线能顺路穿过新节点」。
 * @param {LGraphNode} node
 * @param {object} primaryLink 刚插进去的那条线
 * @param {number} primaryOutIdx 主线用的输出位（同类型的兄弟线直接复用它）
 * @param {number} primaryInIdx 主线用的输入位
 * @returns {{plan:Array, skipped:Array}}
 */
function planExtraLinks(node, primaryLink, primaryOutIdx = -1, primaryInIdx = -1) {
  const graph = app.graph;
  const prim = linkParts(primaryLink);
  if (!graph || !prim) return { plan: [], skipped: [] };

  // 已经被主线占掉的插槽先记账（新节点如果是画布上已有的，也一并算进来）
  const usedIn = new Set();
  const usedOut = new Set();
  (node.inputs ?? []).forEach((s, i) => {
    if (!slotIsFree(s, true)) usedIn.add(i);
  });
  (node.outputs ?? []).forEach((s, i) => {
    if (!slotIsFree(s, false)) usedOut.add(i);
  });

  const plan = [];
  const skipped = [];
  const seen = new Set([prim.id]);
  // 这次插入所属的那条线：插入点原本的下游往下的那一串（含它自己）。
  // 兄弟线必须落在这条线上才算数。
  const line = lineBelow(graph, graph.getNodeById(prim.target_id));

  eachLink(graph, (raw) => {
    const l = linkParts(raw);
    if (!l || l.id === undefined || l.id === null) return;
    if (seen.has(l.id)) return;
    if (l.origin_id === undefined || l.origin_id === null) return;
    if (l.target_id === undefined || l.target_id === null) return;
    // 新节点自己身上的线绝对不碰
    if (l.origin_id === node.id || l.target_id === node.id) return;

    const sameOrigin = l.origin_id === prim.origin_id;
    const sameTarget = l.target_id === prim.target_id;
    if (!sameOrigin && !sameTarget) return;

    // 兄弟线也得落在**这条线**上。同一个上游节点扇到别的线（同一个输出
    // 顺另一路跑、同时喂两路采样）不算兄弟，拉进来
    // 就等于凭空给另那条线换了个走向。旁边那条线原来怎么接，就让它怎么接。
    if (line.size && !line.has(l.target_id)) return;

    seen.add(l.id);

    const origin = graph.getNodeById(l.origin_id);
    const target = graph.getNodeById(l.target_id);
    if (!origin || !target) return;
    if (origin === node || target === node) return;

    const type = linkTypeOf(l);

    // 同一个输出的不同分支：值本来就一模一样，上游那半段已经接好了，
    // 只需要把这些分支的「下游端」挪到新节点的输出上，不用再找一个输入口。
    const reuseInput =
      l.origin_id === prim.origin_id && l.origin_slot === prim.origin_slot;

    const inIdx = reuseInput
      ? primaryInIdx
      : pickSlot(node, true, type, { used: usedIn, onlyFree: true });

    // 输出位：同类型的兄弟线优先复用主线那个输出口（一根输出带多个下游是允许的），
    // 类型不同才另找一个空输出位。
    let outIdx = -1;
    if (
      primaryOutIdx >= 0 &&
      node.outputs?.[primaryOutIdx] &&
      compatible(type, node.outputs[primaryOutIdx].type)
    ) {
      outIdx = primaryOutIdx;
    } else {
      outIdx = pickSlot(node, false, type, { used: usedOut, onlyFree: true });
    }

    if (inIdx < 0 || outIdx < 0) {
      skipped.push({ link: l, type, origin, target });
      return;
    }

    usedIn.add(inIdx);
    usedOut.add(outIdx);
    plan.push({
      link: l,
      inIdx,
      outIdx,
      type,
      reuseInput,
      parallel: sameOrigin && sameTarget,
      // 同下游、不同上游：这条线本来就是喂给「被插入的那个节点」的。
      // 把新节点插到它前面，它当然也该从新节点取料 —— 和「平行线」一样直接接，
      // 不再问一句（问了也只有一个合理答案，多端口节点插上去就等这一下）。
      intoTarget: sameTarget && !sameOrigin,
      origin,
      target,
      // 显示用：上游.输出 → 下游.输入
      from: `${nodeName(origin)}.${slotLabel(origin, l.origin_slot, false)}`,
      to: `${nodeName(target)}.${slotLabel(target, l.target_slot, true)}`,
      inName: slotLabel(node, inIdx, true),
      outName: slotLabel(node, outIdx, false),
    });
  });

  // 平行的先做，视觉上更符合直觉
  plan.sort((a, b) => Number(b.parallel) - Number(a.parallel));
  return { plan, skipped };
}

/** 把某条线改成 origin → node → target（reuseInput 时上游那半段已经在了，只挪下游端） */
function rerouteThroughNode(node, item) {
  const graph = app.graph;
  const { link, inIdx, outIdx } = item;
  const origin = graph.getNodeById(link.origin_id);
  const target = graph.getNodeById(link.target_id);
  if (!origin || !target) return false;

  try {
    if (typeof graph.removeLink === "function") graph.removeLink(link.id);
    else target.disconnectInput(link.target_slot);
  } catch (err) {
    console.warn(LOG, "断开补线失败", err);
    try {
      target.disconnectInput(link.target_slot);
    } catch (err2) {
      return false;
    }
  }

  if (!item.reuseInput) {
    const l1 = safeConnect(origin, link.origin_slot, node, inIdx, link.parentId ?? null);
    if (!l1) {
      // 接不上就还原，别拆散原来的图
      safeConnect(origin, link.origin_slot, target, link.target_slot, link.parentId ?? null);
      return false;
    }
  }
  const l2 = safeConnect(node, outIdx, target, link.target_slot, null);
  if (!l2) {
    // 下游接不上：把刚接上的输入也拆掉，再把原来那条直连放回去。
    // 只还原下游会留下半截 —— 上游接进了新节点、出口却空着，上游还平白多扇出一条，
    // 图上看着就是「多了一根不知道干什么的线，该接的地方没接线」。
    if (!item.reuseInput) {
      try {
        node.disconnectInput(inIdx);
      } catch (err) {
        /* ignore */
      }
    }
    safeConnect(origin, link.origin_slot, target, link.target_slot, link.parentId ?? null);
    return false;
  }

  node.setDirtyCanvas?.(true, true);
  origin.setDirtyCanvas?.(true, true);
  target.setDirtyCanvas?.(true, true);
  return true;
}

function applyExtras(node, items) {
  if (!items?.length) return 0;
  let ok = 0;
  beginChange();
  try {
    for (const it of items) {
      try {
        if (rerouteThroughNode(node, it)) ok++;
      } catch (err) {
        console.warn(LOG, "补线出错", err);
      }
    }
  } finally {
    endChange();
  }
  app.graph?.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);
  return ok;
}

/* ============================================================
 * 五-2-a2、给新节点空着的输入口补料（沿数据链往上溯，不只看直接上游）
 * ------------------------------------------------------------
 * 插入时点中的只有一根线，可节点上往往还有别的数据口。典型：
 * 新节点比直接上游多一个同类型的口 —— 这个口的源头在直接上游身上没有，
 * 再往上一层（上游的上游）才有：
 *
 *     A ─X──────────┐
 *                    └→ 新节点.X          ← 补这一条
 *     A ─Y→ B ─Y→ 新节点
 *
 * 补完再把「原本绕过新节点直连下游」的那条改接过来
 * （A.X → 下游 变成 A → 新节点.X → 下游），让数据真正穿过新节点，
 * 而不是从旁边绕过去。
 *
 * 三条安全线：
 *   · 只补「可以接线」的口：带 widget 的参数框一律不碰（那是你本地调好的值），
 *     下拉（COMBO）和通配（*）也不猜
 *   · 类型必须完全一致，不拿 * 去凑
 *   · 不接成环：源在目标节点下游的一律不要
 * ============================================================ */

/** 这些类型不去自动接线：下拉/枚举是本地选的，猜了只会错 */
const AUTO_SKIP_TYPES = new Set(["COMBO"]);

/**
 * 这个口适不适合自动接线。
 * 输入：带 widget 的参数框不算（用户本地填的值，接了线等于把值顶掉）；
 * 输出：没有 widget 概念，只看类型。
 */
function isAutoPort(slot) {
  if (!slot) return false;
  if (slot.widget) return false;
  const ts = typeTokens(slot.type);
  if (!ts.length || ts.includes("*")) return false; // 通配口猜不准，不碰
  return ts.every((x) => !AUTO_SKIP_TYPES.has(String(x).toUpperCase()));
}

/**
 * 这个口能不能「顺着走」（找源头 / 找下游时用）。
 *
 * 和 isAutoPort 的唯一区别：**通配口 `*` 允许走**。
 *
 * 为什么必须分开：中间夹一个透传节点（Reroute、各种 `anything` 转接）时，
 * 那条线的槽位写着 `*`。拿 isAutoPort 去拦，上游搜索会直接断在这类节点上
 * —— 于是真正的源头明明就在再往上一层，却永远找不到，输入口一直空着。
 * 常见的拓扑是 `源 ─*→ 透传 ─Y→ 中间节点`，这个口就卡在这里。
 *
 * 走归走，**接不接另说**：真正接线仍然走 isAutoPort + sameType，
 * `*` 不会拿去凑任何类型。
 */
function isTraversable(slot) {
  if (!slot) return false;
  if (slot.widget) return false;
  const ts = typeTokens(slot.type);
  if (!ts.length) return false;
  return ts.every((x) => !AUTO_SKIP_TYPES.has(String(x).toUpperCase()));
}

/** 类型指纹：类型完全一致才算同一个，顺序无关 */
function typeKeyOf(t) {
  return typeTokens(t)
    .map((x) => String(x).toUpperCase())
    .sort()
    .join("|");
}

function sameType(a, b) {
  const ka = typeKeyOf(a);
  const kb = typeKeyOf(b);
  return !!ka && ka !== "*" && ka === kb;
}

/**
 * 沿输入线往上走的源节点（BFS，离得近的排在前面）。
 * 只跟数据线，参数线不跟 —— 免得顺着一个 seed 跑到十万八千里外。
 * 中间夹着 `*` 的透传节点也要能穿过去（见 isTraversable）。
 */
function upstreamSources(node, graph, maxDepth = 6) {
  const out = [];
  const seen = new Set([node.id]);
  let frontier = [node];

  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {
      for (const s of n.inputs ?? []) {
        if (!s) continue;
        const l = getLink(graph, s.link);
        if (!l) continue;
        if (!isTraversable(s)) continue;
        const src = graph.getNodeById(l.origin_id);
        if (!src || seen.has(src.id)) continue;
        seen.add(src.id);
        out.push(src);
        next.push(src);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * 从某个节点往下，**同一根线**上的所有后继（含起点），只跟数据口走。
 *
 * 为什么非要这条限制：一根输出常常同时扇给几条互不相干的线
 * （同一个输出同时喂正面、负面，或同时喂两路采样），
 * 甚至跟这次插入一点关系都没有。判断「新节点的出口该接谁」只能沿着
 * 插入那条线的下游走 —— 一旦离开这条链，就都是别人的地盘，碰一下就是
 * 悄悄改了别人那条线的数据来源。
 *
 * 插入点下游是 2 号 → 3 号，那就只看 2 号、3 号……找最近的空口；
 * 隔壁 4 号属于另一条线，它原来怎么接就怎么接，不归这里管。
 */
function lineBelow(graph, start, maxDepth = 6) {
  const ids = new Set();
  if (!graph || !start) return ids;
  ids.add(start.id);

  let frontier = [start];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {
      for (const o of n.outputs ?? []) {
        if (!isTraversable(o)) continue;
        for (const id of o?.links ?? []) {
          const l = getLink(graph, id);
          if (!l) continue;
          const t = graph.getNodeById(l.target_id);
          if (!t || ids.has(t.id)) continue;
          ids.add(t.id);
          next.push(t);
        }
      }
    }
    frontier = next;
  }

  return ids;
}

/** src 是否在 node 的下游（补线前挡一下环） */
function isDownstreamOf(graph, src, node, maxDepth = 6) {
  const seen = new Set([node.id]);
  let frontier = [node];

  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {
      for (const o of n.outputs ?? []) {
        for (const id of o?.links ?? []) {
          const l = getLink(graph, id);
          if (!l) continue;
          if (l.target_id === src.id) return true;
          const t = graph.getNodeById(l.target_id);
          if (!t || seen.has(t.id)) continue;
          seen.add(t.id);
          next.push(t);
        }
      }
    }
    frontier = next;
  }
  return false;
}

/**
 * 候选下游，按优先级排。前提：**只在这条线的下游里挑**。
 *   ① 这个上游输出原本就喂着、而且落在这条线上的下游（改接用）
 *   ② 插入时那条线的下游
 *   ③ 新节点已经接上的下游
 *
 * 这里以前把「这个输出口喂着的**所有**下游」一股脑排第一优先，
 * 于是 checkpoint 的 CLIP 顺带喂着旁边那条线的节点时，就会先改接旁边那个，
 * 而插入这条线上真正空着口、该接的那个反而轮不到 —— 报告看着接上了，
 * 图上却还是差一条。
 */
function downstreamCandidates(graph, node, preferred, src, oi, chain) {
  const out = [];
  const seen = new Set([node.id]);
  const line = chain ?? lineBelow(graph, preferred);
  const push = (n) => {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    out.push(n);
  };

  if (src) {
    for (const id of src.outputs?.[oi]?.links ?? []) {
      const l = getLink(graph, id);
      const t = l && graph.getNodeById(l.target_id);
      // 只收本线上的：别的支线原来怎么接就怎么接，不归这里管
      if (t && (line.has(t.id) || t.id === preferred?.id)) push(t);
    }
  }
  push(preferred);
  for (const o of node.outputs ?? []) {
    for (const id of o?.links ?? []) {
      const l = getLink(graph, id);
      if (l) push(graph.getNodeById(l.target_id));
    }
  }
  return out;
}

/**
 * 新节点的这个输出口没有现成的下游线可改接时，往下走几层找落点。
 *
 * 为什么需要：紧挨着它的那个节点可能压根没有这个类型的口。
 * 下游第一个节点没有、再下面一层才有，这很常见 ——
 * 只看相邻一层，这个出口就永远空着。
 *
 * 「再下面一层」没有硬上限那么死：2 号没有就看 3 号，3 号没有就继续往后，
 * 一路只走**这条线**（就是 start 往下的这一条），走到 6 层还没落点才作罢。
 * 隔壁那条线的节点一律不看。
 *
 * 只接**第一个**空的同类型输入口（最近的），接上就停。
 */
function fillDownstream(node, outIdx, type, graph, start, maxDepth = 6) {
  if (!start) return { ok: false, to: "" };

  const seen = new Set([node.id]);
  let frontier = [];
  if (!seen.has(start.id)) {
    seen.add(start.id);
    frontier.push(start);
  }

  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {
      // 只补**空着**的同类型输入口。
      // 已经接着线的口一律不碰 —— 哪怕它接的也是新节点的上游，
      // 因为「上游」可能有 A、B 两个，下游吃的是 B 的，改接到 A 身上
      // 等于悄悄换了数据来源。那种改接交给 downstreamCandidates：
      // 它只认「这个输出口原本喂的下游」，语义是确定的。
      const idx = (n.inputs ?? []).findIndex(
        (s) => isAutoPort(s) && sameType(s.type, type) && slotIsFree(s, true),
      );
      if (idx >= 0) {
        const l = safeConnect(node, outIdx, n, idx, null);
        if (l) return { ok: true, to: `${nodeName(n)}.${slotLabel(n, idx, true)}` };
      }

      for (const o of n.outputs ?? []) {
        for (const id of o?.links ?? []) {
          const l = getLink(graph, id);
          if (!l) continue;
          const t = graph.getNodeById(l.target_id);
          if (!t || seen.has(t.id)) continue;
          seen.add(t.id);
          next.push(t);
        }
      }
    }
    frontier = next;
  }

  return { ok: false, to: "" };
}

/**
 * @param {LGraphNode} node 刚插进去的节点
 * @param {object} opts { target } 插入时那条线的下游
 * @returns {{added:number, pairs:Array, rewired:number, rewirePairs:Array, left:Array}}
 */
function feedEmptyInputs(node, graph, opts = {}) {
  const res = { added: 0, pairs: [], rewired: 0, rewirePairs: [], left: [] };
  if (!node || !graph) return res;

  const sources = upstreamSources(node, graph, 6);
  if (!sources.length) return res;

  const MAX_ADD = 8;

  for (const src of sources) {
    if (res.added >= MAX_ADD) break;
    if (src === node) continue;
    if (isDownstreamOf(graph, src, node)) continue;

    const outs = src.outputs ?? [];
    for (let oi = 0; oi < outs.length; oi++) {
      if (res.added >= MAX_ADD) break;
      const out = outs[oi];
      if (!isAutoPort(out)) continue;

      // 新节点上：同类型、空着、能接线的输入口
      const inIdx = (node.inputs ?? []).findIndex(
        (s) => isAutoPort(s) && sameType(s.type, out.type) && slotIsFree(s, true),
      );
      if (inIdx < 0) continue;

      // 出口：优先挑空着的；都占着也能用 —— 同一份数据扇给多个下游是正常接法。
      // 这里以前要求「必须空着」，找不到就 continue，**连输入口也一起不补**，
      // 于是图上直接缺一条线（报告说接上了、图上还是少，就是这个）。
      // 补输入和找出口是两件事，不能因为出口不空就把输入也放弃。
      const outsAll = node.outputs ?? [];
      let outIdx = outsAll.findIndex(
        (s) => isAutoPort(s) && sameType(s.type, out.type) && slotIsFree(s, false),
      );
      if (outIdx < 0) {
        outIdx = outsAll.findIndex((s) => isAutoPort(s) && sameType(s.type, out.type));
      }

      // 这个上游输出已经喂给新节点了，别重复接
      const already = (out.links ?? []).some((id) => {
        const l = getLink(graph, id);
        return l && l.target_id === node.id;
      });
      if (already) continue;

      const l1 = safeConnect(src, oi, node, inIdx, null);
      if (!l1) continue;

      res.added++;
      res.pairs.push({
        type: String(out.type),
        from: `${nodeName(src)}.${slotLabel(src, oi, false)}`,
        to: slotLabel(node, inIdx, true),
      });

      /* ---- 出口：先沿这条线就近找空口，再谈改接 ---- */
      // 顺序有讲究：先按由近到远找**空着的**同类型输入口 ——
      // 下游第一个节点没有这个口，就接着往后找，不在这里收工。
      // 接上就完事 —— 这是最不动原图的做法。
      // 只有整条线都满了（口子都被占着）才考虑改接，而且只改
      // 「原本就是由这个上游输出喂着」的那条，数据来源不变，只是让它穿过新节点。
      let rewired = 0;
      const taken = new Set();

      // 新节点压根没有这个类型的出口 → 输入照补，出口的事如实写进报告
      if (outIdx < 0) {
        res.left.push({
          type: String(out.type),
          why: "输入补上了，但新节点没有这个类型的出口，数据进来出不去",
        });
        continue;
      }

      // 这条线：插入点原本的下游往下的那一串（含它自己）
      const chain = lineBelow(graph, opts.target);

      const filled = fillDownstream(node, outIdx, out.type, graph, opts.target);
      if (filled.ok) {
        rewired = 1;
        res.rewired++;
        res.rewirePairs.push({ type: String(out.type), to: filled.to });
      }

      /* ---- 线上没有空口：把「原本绕过新节点、直连下游」的那条改接过来 ---- */
      if (!rewired) {
        for (const t of downstreamCandidates(graph, node, opts.target, src, oi, chain)) {
          const ti = (t.inputs ?? []).findIndex((s, si) => {
            if (taken.has(`${t.id}:${si}`)) return false;
            const l = getLink(graph, s?.link);
            return (
              l &&
              l.origin_id === src.id &&
              l.origin_slot === oi &&
              sameType(s.type, out.type)
            );
          });
          if (ti < 0) continue;

          const back = { node: t, slot: ti };
          try {
            t.disconnectInput(ti);
          } catch (err) {
            /* ignore */
          }
          const l2 = safeConnect(node, outIdx, t, ti, null);
          if (l2) {
            rewired++;
            taken.add(`${t.id}:${ti}`);
            res.rewirePairs.push({
              type: String(out.type),
              to: `${nodeName(t)}.${slotLabel(t, ti, true)}`,
            });
          } else {
            // 接不上就把原来那条直连放回去，别留下断的线
            safeConnect(src, oi, back.node, back.slot, null);
          }
        }
        res.rewired += rewired;
      }

      if (!rewired) {
        res.left.push({
          type: String(out.type),
          why: "这条线往下没有能吃这个类型的口，数据到新节点就停在这里",
        });
      }
    }
  }

  return res;
}

/* ============================================================
 * 五-2-b、多选串联：让兄弟线整组穿过去
 * ------------------------------------------------------------
 * 串联插入时，一条线变成 A → n1 → n2 → … → B，兄弟线不会自己跟上，
 * 因为每插一个节点，主线的两端都变了。所以整组插完之后统一规划一次：
 *
 *   · 和主线同一个上游输出口的（纯扇出）→ 值本来就是同一份，
 *     只需要把下游端挪到最后一个节点的对应输出上（reuse）
 *   · 其余一头相邻的 → 必须整组逐节点穿过（pass），
 *     每个节点都要有一个空的同类型输入位 + 输出位
 *
 * 槽位在规划阶段就模拟占用，所以两条同类型的兄弟线不会抢同一个口。
 * ============================================================ */

/** 规划一条「穿过整组节点」的路线；槽位不够返回 null，并且不留下副作用 */
function tryChainPass(nodes, type, state) {
  const { usedIn, usedOut } = state;
  const backup = new Map();
  const save = (m) => {
    for (const [k, v] of m) {
      if (!backup.has(m)) backup.set(m, new Map());
      backup.get(m).set(k, new Set(v));
    }
  };
  save(usedIn);
  save(usedOut);
  const restore = () => {
    for (const [m, snap] of backup) {
      m.clear();
      for (const [k, v] of snap) m.set(k, new Set(v));
    }
  };

  const steps = [];
  for (const nd of nodes) {
    const inIdx = pickSlot(nd, true, type, { used: getSet(usedIn, nd), onlyFree: true });
    if (inIdx < 0) {
      restore();
      return { ok: false, node: nd, why: "no-in" };
    }
    getSet(usedIn, nd).add(inIdx);

    const outIdx = pickSlot(nd, false, type, { used: getSet(usedOut, nd), onlyFree: true });
    if (outIdx < 0) {
      restore();
      return { ok: false, node: nd, why: "no-out" };
    }
    getSet(usedOut, nd).add(outIdx);
    steps.push({ node: nd, inIdx, outIdx });
  }
  return { ok: true, steps, exitOut: steps[steps.length - 1].outIdx };
}

function getSet(m, n) {
  if (!m.has(n.id)) m.set(n.id, new Set());
  return m.get(n.id);
}

/**
 * 整组插完之后，算「哪些兄弟线还能接上」。
 * @param {LGraphNode[]} chainNodes 已经串进主线的节点（按插入顺序）
 * @param {object} primaryLink 用户点的那条线（原始状态）
 * @param {object} exitLink 最后一个节点接出来的那条线
 * @param {object[]} candidates 各步骤收集到的「只有一头相邻」候选
 * @returns {{items:Array, skipped:Array}}
 */
function planChainExtras(chainNodes, primaryLink, exitLink, candidates) {
  const graph = app.graph;
  const nodes = (chainNodes ?? []).filter(Boolean);
  const items = [];
  const skipped = [];
  if (!graph || !nodes.length) return { items, skipped };

  const prim = linkParts(primaryLink);
  const exit = exitLink ? linkParts(exitLink) : null;
  const last = nodes[nodes.length - 1];
  if (!prim || !exit) return { items, skipped };

  // 每个节点上已经被真实连线占掉的槽位
  const usedIn = new Map();
  const usedOut = new Map();
  const state = { usedIn, usedOut };
  for (const nd of nodes) {
    (nd.inputs ?? []).forEach((s, i) => {
      if (!slotIsFree(s, true)) getSet(usedIn, nd).add(i);
    });
    (nd.outputs ?? []).forEach((s, i) => {
      if (!slotIsFree(s, false)) getSet(usedOut, nd).add(i);
    });
  }

  // 同一个上游输出口喂出来的线，共享同一条通路：记下「最后那个节点的出口槽位」
  const fedBy = new Map();
  fedBy.set(`${prim.origin_id}:${prim.origin_slot}`, exit.origin_slot);

  const seen = new Set([prim.id]);

  for (const raw of candidates ?? []) {
    const l = linkParts(raw);
    if (!l || l.id === undefined || l.id === null) continue;
    if (seen.has(l.id)) continue;
    seen.add(l.id);

    // 线还在不在（理论上一直在，保险起见）
    const live = getLink(graph, l.id);
    if (!live) continue;

    const origin = graph.getNodeById(l.origin_id);
    const target = graph.getNodeById(l.target_id);
    if (!origin || !target) continue;
    if (nodes.includes(target) || nodes.includes(origin)) continue;

    const type = linkTypeOf(l);
    const key = `${l.origin_id}:${l.origin_slot}`;
    const from = `${nodeName(origin)}.${slotLabel(origin, l.origin_slot, false)}`;
    const to = `${nodeName(target)}.${slotLabel(target, l.target_slot, true)}`;

    // 1) 同一个输出口扇出来的：上游那半段是同一份值，直接复用主线通路
    if (fedBy.has(key)) {
      items.push({
        kind: "reuse",
        link: l,
        outIdx: fedBy.get(key),
        last,
        type,
        from,
        to,
      });
      continue;
    }

    // 2) 整组穿过去
    const pass = tryChainPass(nodes, type, state);
    if (pass.ok) {
      fedBy.set(key, pass.exitOut);
      items.push({ kind: "pass", link: l, steps: pass.steps, type, from, to });
    } else {
      skipped.push({ link: l, type, node: pass.node, why: pass.why, from, to });
    }
  }

  return { items, skipped };
}

/** 执行 planChainExtras 的结果 */
function applyChainExtras(items) {
  const graph = app.graph;
  if (!items?.length) return 0;
  let ok = 0;

  beginChange();
  try {
    for (const it of items) {
      try {
        if (it.kind === "reuse") {
          const l = linkParts(it.link);
          const target = graph.getNodeById(l.target_id);
          const origin = graph.getNodeById(l.origin_id);
          if (!target || !it.last) continue;
          try {
            if (typeof graph.removeLink === "function") graph.removeLink(l.id);
            else target.disconnectInput(l.target_slot);
          } catch (err) {
            /* ignore */
          }
          const nl = safeConnect(it.last, it.outIdx, target, l.target_slot, null);
          if (nl) ok++;
          else if (origin) safeConnect(origin, l.origin_slot, target, l.target_slot, null);
          continue;
        }

        // kind === "pass"：逐节点穿过去，每穿一个都要拿到新的「节点 → 下游」那条线
        let cur = linkParts(getLink(graph, it.link.id) ?? it.link);
        if (!cur) continue;
        let good = true;

        for (const st of it.steps) {
          if (!rerouteThroughNode(st.node, { link: cur, inIdx: st.inIdx, outIdx: st.outIdx })) {
            good = false;
            break;
          }
          const next = findOutLink(st.node, st.outIdx, cur.target_id, cur.target_slot);
          if (!next) {
            good = false;
            break;
          }
          cur = linkParts(next);
        }
        if (good) ok++;
      } catch (err) {
        console.warn(LOG, "串联补线出错", err);
      }
    }
  } finally {
    endChange();
  }

  graph?.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);
  return ok;
}

/** 在某个输出槽里找指向 (targetId, targetSlot) 的那条线 */
function findOutLink(node, outIdx, targetId, targetSlot) {
  const graph = app.graph;
  for (const id of node?.outputs?.[outIdx]?.links ?? []) {
    const l = linkParts(getLink(graph, id));
    if (l && l.target_id === targetId && l.target_slot === targetSlot) return l;
  }
  return null;
}

/* ---------- 「还有几条线，要一起接吗」确认条 ---------- */

const ASK_ID = "nri-ask";
let askBar = null; // { root, onKey, onOutside }

function closeAsk() {
  if (!askBar) return;
  const { root, onKey, onOutside } = askBar;
  askBar = null;
  try {
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onOutside, true);
  } catch (err) {
    /* ignore */
  }
  try {
    root?.remove();
  } catch (err) {
    /* ignore */
  }
}

/**
 * 「还有几条线，要一起接吗」的确认条。
 * @param {LGraphNode} node 主线插入的那个节点（用来取名字做说明）
 * @param {object[]} items 待接的线（from / to / type）
 * @param {{apply?:Function, avoidText?:string}} opts
 *        apply：确认后怎么接（默认插单个节点那套）；avoidText：绕过哪些节点
 */
function askConnectExtras(node, items, opts = {}) {
  if (!items?.length) return;
  closeAsk();
  ensureStyle();

  const apply = typeof opts.apply === "function" ? opts.apply : (its) => applyExtras(node, its);
  const avoidText = opts.avoidText ?? escapeHtml(nodeName(node));

  const rows = items
    .map(
      (it) => `
      <div class="nri-ask-row">
        <span class="nri-tag">${escapeHtml(it.type)}</span>
        <span class="nri-path">${escapeHtml(it.from)} <span class="nri-arrow">→</span> ${escapeHtml(it.to)}</span>
      </div>`
    )
    .join("");

  // 文案统一过 tr()：中文环境原样返回，英文环境查表 / 走模板规则
  const head = tr(`还有 ${items.length} 条线可以顺路穿过去`);
  const sub = tr(`接上之后这几条线会多绕一道 ${avoidText}，原来的图不会断。`);
  const keyBtn = (label, key, act, cls = "") =>
    `<button type="button" class="nri-btn${cls}" data-act="${act}">${tr(label).replace(
      key,
      `<span class="nri-key">${key}</span>`
    )}</button>`;

  const root = document.createElement("div");
  root.id = ASK_ID;
  root.innerHTML = `
    <div class="nri-ask-head">${head}</div>
    <div class="nri-ask-sub">${sub}</div>
    <div class="nri-ask-list">${rows}</div>
    <div class="nri-ask-btns">
      ${keyBtn("不用（Esc）", "Esc", "no")}
      ${keyBtn("一起接上（Enter）", "Enter", "yes", " pri")}
    </div>
  `;
  document.body.appendChild(root);

  const done = (yes) => {
    closeAsk();
    if (!yes) return;
    const ok = apply(items);
    if (ok === items.length) {
      toast("success", `已一起接上 ${ok} 条线`, `${items.map((i) => i.from).join("、")}`, 5000);
    } else {
      toast(
        "warn",
        `接上了 ${ok} / ${items.length} 条`,
        "剩下那几条先按原样留着，需要的话手动补一下。",
        8000
      );
    }
  };

  const onKey = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      done(false);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      done(true);
    }
  };
  const onOutside = (ev) => {
    if (root.contains(ev.target)) return;
    done(false);
  };

  root.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  root.addEventListener("click", (ev) => {
    const btn = ev.target?.closest?.("button[data-act]");
    if (!btn) return;
    done(btn.dataset.act === "yes");
  });

  window.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onOutside, true);
  askBar = { root, onKey, onOutside };
}

/* ============================================================
 * 五-3、把节点从连线里摘出来（插入的逆操作）
 * ------------------------------------------------------------
 * 插入是 A → [新] → B；分离就是把它摘掉，让 A 直接回到 B，
 * 节点本身留在画布上不删，只是没有连线了。
 *
 * 多线的情况按类型配对：进线 model → 出线 model，
 * 进线 clip → 出线 clip，各自直连回去，一根都不许断。
 * ============================================================ */

/**
 * 真正干活的部分：不弹提示、不开撤销事务，好坏结果都返回给调用方。
 * @returns {{ok:boolean, why?:string, detail?:string, made:number, failed:number, total:number}}
 */
function separateCore(node) {
  const graph = app.graph;
  const res = { ok: false, made: 0, failed: 0, total: 0, lines: [] };
  if (!graph || !node) return res;

  /* ---- 1. 收集它身上的所有线 ---- */
  const inLinks = [];
  const outLinks = [];

  (node.inputs ?? []).forEach((s, i) => {
    const id = s?.link;
    if (id === null || id === undefined) return;
    const l = getLink(graph, id);
    if (l) inLinks.push({ slot: i, link: linkParts(l), type: linkTypeOf(l) });
  });
  (node.outputs ?? []).forEach((s, i) => {
    for (const id of s?.links ?? []) {
      const l = getLink(graph, id);
      if (l) outLinks.push({ slot: i, link: linkParts(l), type: linkTypeOf(l) });
    }
  });

  res.total = inLinks.length + outLinks.length;
  if (!res.total) {
    res.why = "empty";
    return res;
  }

  /* ---- 2. 给每条出线配一条类型对得上的进线 ---- */
  // 先找还没被用过的进线；都配完了还多出来的（扇出），复用已配过的同类型进线
  const used = [];
  const pairs = [];
  const unmatched = [];

  for (const out of outLinks) {
    const target = graph.getNodeById(out.link.target_id);
    if (!target) continue; // 下游都没了，这条线本来就没意义

    // 上游得是个真实节点才接得回去（子图端口这种虚拟节点接不了）
    const usable = (x) => compatible(out.type, x.type) && !!graph.getNodeById(x.link.origin_id);

    let src = inLinks.find((x) => !used.includes(x) && usable(x));
    if (!src) src = used.find((x) => usable(x));
    if (!src) {
      unmatched.push({ out, target });
      continue;
    }
    if (!used.includes(src)) used.push(src);
    pairs.push({ src, sink: out, target });
  }

  if (unmatched.length) {
    res.why = "unmatched";
    res.detail = unmatched
      .map((u) => `${slotLabel(node, u.out.slot, false)} → ${nodeName(u.target)}`)
      .join("、");
    return res;
  }

  /* ---- 3. 拆线 + 直连回去 ---- */
  const allLinks = [...inLinks.map((x) => x.link), ...outLinks.map((x) => x.link)];

  for (const l of allLinks) {
    try {
      if (typeof graph.removeLink === "function") graph.removeLink(l.id);
      else graph.getNodeById(l.target_id)?.disconnectInput(l.target_slot);
    } catch (err) {
      console.warn(LOG, "分离时断线失败", err);
    }
  }

  for (const p of pairs) {
    const origin = graph.getNodeById(p.src.link.origin_id);
    if (!origin) {
      res.failed++;
      continue;
    }
    // 这里不用 rerouteId：直连回去比绕中转点更干净
    const l = safeConnect(origin, p.src.link.origin_slot, p.target, p.sink.link.target_slot, null);
    if (l) {
      res.made++;
      res.lines.push(
        `${p.src.type}  ${nodeTag(origin)}.out[${p.src.link.origin_slot}] → ${nodeTag(p.target)}.in[${p.sink.link.target_slot}]`,
      );
    } else {
      res.failed++;
    }
  }

  // 节点原地不动：分离只负责断线和把上下游接回去。
  // （以前这里会把节点往下推 h+60 躲开恢复出来的线，结果打乱了用户排好的版，
  //   尤其是多选分离时每选一次就整体挪一格。位置是用户的事，插件不该动。）
  node.setDirtyCanvas?.(true, true);
  graph.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);

  res.ok = true;
  return res;
}

/** 分离一个节点（自带事务 + 提示） */
function separateNode(node) {
  if (!node) return false;

  const around = aroundNodes(node, app.graph);
  const beforeText = dumpText(around, app.graph);

  const res = separateCore(node);
  if (!res.ok) {
    if (res.why === "empty") {
      toast("warn", `${nodeName(node)} 本来就是独立的`, "它身上没有任何连线。", 5000);
    } else if (res.why === "unmatched") {
      toast(
        "error",
        `${nodeName(node)} 没法干净地分离`,
        `${res.detail} 找不到同类型的上游接回去，拆掉会断线，所以这次没动。`,
        9000
      );
    }
    return false;
  }

  commitUndo();

  try {
    app.canvas?.selectNode?.(node, false);
  } catch (err) {
    /* ignore */
  }

  if (res.failed) {
    toast(
      "warn",
      `${nodeName(node)} 已分离，但有 ${res.failed} 条没接回去`,
      "那几条的下游现在是断的，麻烦手动补一下。",
      9000
    );
  } else if (res.made) {
    toast(
      "success",
      `已把 ${nodeName(node)} 从连线中分离`,
      `${res.made} 条线直连回去了，节点留在画布上`,
      4500
    );
  } else {
    toast("success", `已把 ${nodeName(node)} 摘下来`, `${res.total} 条线已断开，节点还在画布上。`, 4500);
  }

  console.log(LOG, "分离完成", { node: nodeName(node), bridged: res.made, failed: res.failed });

  const sec = [
    `分离：${nodeTag(node)}　断开 ${res.total} 条 · 直连回去 ${res.made} 条 · 失败 ${res.failed} 条`,
    "",
  ];
  if (res.lines.length) {
    sec.push("【直连回去的线】");
    for (const s of res.lines) sec.push(`  ${s}`);
    sec.push("");
  }
  sec.push("【分离前】", beforeText, "");
  sec.push("【分离后】", dumpText(around, app.graph));
  publishReport("分离", `${nodeName(node)} 从连线中摘出`, sec);

  return true;
}

/** 一次分离多个节点：一个撤销事务，一条汇总提示 */
function separateNodes(nodes) {
  const list = (nodes ?? []).filter(Boolean);
  if (!list.length) return false;
  if (list.length === 1) return separateNode(list[0]);

  const doneList = [];
  const skipped = [];

  beginChange();
  try {
    for (const n of list) {
      const res = separateCore(n);
      if (res.ok) doneList.push({ node: n, res });
      else skipped.push({ node: n, res });
    }
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
  } finally {
    endChange();
  }

  if (!doneList.length) {
    const first = skipped[0];
    if (first?.res.why === "unmatched") {
      toast("error", "一个都没分离", `${nodeName(first.node)} 的 ${first.res.detail} 找不到同类型上游。`, 9000);
    } else {
      toast("warn", "这些节点都没有连线", "选中的节点本来就是独立的。", 6000);
    }
    return false;
  }

  const bridged = doneList.reduce((a, x) => a + x.res.made, 0);
  const bad = doneList.reduce((a, x) => a + x.res.failed, 0);
  const bits = [`${doneList.length} 个节点已摘下`, `${bridged} 条线直连回去`];
  if (bad) bits.push(`${bad} 条没接回`);
  if (skipped.length) bits.push(`${skipped.length} 个跳过（${skipped[0].res.why === "empty" ? "本来就没线" : "接不回去"}）`);

  toast(bad || skipped.length ? "warn" : "success", `已分离 ${doneList.length} 个节点`, bits.join("　·　"), 6000);

  console.log(LOG, "批量分离完成", {
    done: doneList.map((x) => nodeName(x.node)),
    skipped: skipped.map((x) => nodeName(x.node)),
    bridged,
    bad,
  });
  return true;
}

/* ============================================================
 * 六、连线高亮（确认鼠标打中的是哪条线）
 * ============================================================ */

let highlighted = null;

function setLinkHighlight(link) {
  const cnv = app.canvas;
  if (!cnv) return;
  const id = link ? link.id : null;
  if (highlighted === id) return;
  highlighted = id;
  try {
    cnv.highlighted_links = id === null ? {} : { [id]: true };
    cnv.setDirty?.(true, true);
  } catch (err) {
    /* ignore */
  }
}

/* ============================================================
 * 七、交互一：armed 模式（右键节点 → 点线插入）
 * ============================================================ */

const BAR_ID = "nri-armed-bar";
const STYLE_ID = "nri-style";

const CSS = `
#nri-armed-bar {
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
  border: 1px solid #22c55e;
  background: var(--comfy-menu-bg, #1f1f23);
  color: var(--input-text, #eaeaea);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12.5px;
  box-shadow: 0 8px 26px rgba(0,0,0,0.45), 0 0 0 3px rgba(34,197,94,0.14);
  pointer-events: none;
  user-select: none;
  animation: nri-in 0.14s ease-out;
}
@keyframes nri-in {
  from { opacity: 0; transform: translateX(-50%) translateY(-6px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
#nri-armed-bar .nri-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 0 rgba(34,197,94,0.7);
  animation: nri-pulse 1.1s infinite;
  flex: none;
}
@keyframes nri-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(34,197,94,0.65); }
  70%  { box-shadow: 0 0 0 7px rgba(34,197,94,0); }
  100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
}
#nri-armed-bar .nri-msg { font-size: 13px; font-weight: 600; }
#nri-armed-bar .nri-body { display: flex; flex-direction: column; gap: 3px; }
#nri-armed-bar .nri-sub {
  font-size: 11px;
  opacity: 0.62;
  max-width: 56vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#nri-armed-bar .nri-key {
  display: inline-block;
  padding: 0 4px;
  margin: 0 1px;
  border: 1px solid rgba(140,140,140,0.45);
  border-radius: 3px;
  font-size: 10px;
  line-height: 14px;
}


/* ---------- 「还有几条线，一起接?」确认条 ---------- */
#nri-ask {
  position: fixed;
  left: 50%;
  bottom: 34px;
  transform: translateX(-50%);
  z-index: 100001;
  width: 400px;
  max-width: 88vw;
  border-radius: 10px;
  border: 1px solid rgba(34,197,94,0.55);
  background: var(--comfy-menu-bg, #202024);
  color: var(--input-text, #eaeaea);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12.5px;
  box-shadow: 0 14px 38px rgba(0,0,0,0.5);
  overflow: hidden;
  animation: nri-in3 0.14s ease-out;
}
@keyframes nri-in3 {
  from { opacity: 0; transform: translateX(-50%) translateY(8px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
#nri-ask .nri-ask-head {
  padding: 10px 13px 4px;
  font-size: 13px;
  font-weight: 600;
  color: #4ade80;
}
#nri-ask .nri-ask-sub {
  padding: 0 13px 8px;
  font-size: 11px;
  line-height: 1.5;
  opacity: 0.62;
}
#nri-ask .nri-ask-list {
  max-height: 26vh;
  overflow-y: auto;
  padding: 2px 13px 9px;
  border-top: 1px solid rgba(140,140,140,0.16);
}
#nri-ask .nri-ask-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 0;
  font-size: 11.5px;
}
#nri-ask .nri-tag {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(34,197,94,0.16);
  border: 1px solid rgba(34,197,94,0.3);
  color: #4ade80;
  font-size: 10px;
  letter-spacing: 0.2px;
}
#nri-ask .nri-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.9;
}
#nri-ask .nri-arrow { opacity: 0.5; margin: 0 2px; }
#nri-ask .nri-ask-btns {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 9px 13px;
  border-top: 1px solid rgba(140,140,140,0.22);
}
#nri-ask .nri-btn {
  padding: 5px 11px;
  border-radius: 6px;
  border: 1px solid rgba(140,140,140,0.4);
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
#nri-ask .nri-btn:hover { background: rgba(255,255,255,0.08); }
#nri-ask .nri-btn.pri {
  border-color: transparent;
  background: #22c55e;
  color: #06240f;
  font-weight: 600;
}
#nri-ask .nri-btn.pri:hover { background: #34d86c; }
#nri-ask .nri-key {
  display: inline-block;
  padding: 0 3px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 9.5px;
  line-height: 13px;
  opacity: 0.7;
}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

/* ---------- armed 模式状态 ---------- */

let armed = null; // { nodes, el, onDown, onMove, onKey }

function showArmedBar(nodes) {
  document.getElementById(BAR_ID)?.remove();
  ensureStyle();

  const list = nodes ?? [];
  const many = list.length > 1;
  const names = list.map((n) => nodeName(n)).join(" → ");

  const bar = document.createElement("div");
  bar.id = BAR_ID;
  bar.innerHTML = `
    <span class="nri-dot"></span>
    <div class="nri-body">
      <div class="nri-msg">${tr("左键点一下要插入的那条线")}</div>
      <div class="nri-sub">
        ${tr(many ? "串联插入：" : "插入：")}${escapeHtml(names)}${many ? tr("　·　兄弟线会整组一起串") : ""}　·　${tr("取消：")}<span class="nri-key">Esc</span> / ${tr("右键 / 点空白")}
      </div>
    </div>
  `;
  document.body.appendChild(bar);
}

function disarm() {
  if (!armed) return;
  const { el, onDown, onMove, onKey } = armed;
  armed = null;

  try {
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("keydown", onKey, true);
  } catch (err) {
    /* ignore */
  }
  try {
    if (el) el.style.cursor = "";
  } catch (err) {
    /* ignore */
  }

  setLinkHighlight(null);
  document.getElementById(BAR_ID)?.remove();
  app.canvas?.setDirty?.(true, true);
}

function arm(nodes) {
  disarm();

  const list = (nodes ?? []).filter(Boolean);
  if (!list.length) {
    toast("info", "先选中要插入的节点", "选中后再右键它。", 5000);
    return;
  }

  const el = canvasElement();
  if (!el) {
    toast("error", "找不到画布", "无法进入插入模式。");
    return;
  }

  const cnv = app.canvas;
  const tolOf = () => {
    const scale = cnv?.ds?.scale || 1;
    return Math.max(5, 13 / scale);
  };

  /* 鼠标划过连线时高亮，确认打中的是哪条 */
  let raf = 0;
  const onMove = (e) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!armed) return;
      const g = eventToGraph(e);
      if (!g) return;
      setLinkHighlight(findLinkAt(g.x, g.y, tolOf()));
    });
  };

  const onDown = (e) => {
    const g = eventToGraph(e);

    // 只处理画布上的点击；点到面板 / 菜单 / 输入框一律不管
    if (!g || (e.target !== g.el && !g.el.contains?.(e.target))) return;

    if (e.button === 2) {
      e.preventDefault();
      e.stopPropagation();
      disarm();
      return;
    }
    if (e.button !== 0) return;

    e.preventDefault();
    e.stopPropagation();

    const link = findLinkAt(g.x, g.y, tolOf());
    if (!link) {
      // 没点中：以前是「点在节点上就提示、点空白就静默退出」——
      // 静默最坑，用户只会觉得「点了没反应」。现在两种都说清楚。
      const hitNode = nodeAt(app.graph, g.x, g.y);
      const near = nearestLinkInfo(g.x, g.y);
      const hint = near
        ? `最近的线还差 ${near.dist}px（${near.link}）`
        : "画布上没有可插入的线";
      console.warn(LOG, "这次没点中线条", {
        点: [Math.round(g.x), Math.round(g.y)],
        容差: Math.round(tolOf() * 10) / 10,
        缩放: g.scale,
        鼠标下面是: hitNode ? nodeName(hitNode) : "空白",
        最近: near,
      });
      if (hitNode) {
        toast("info", "这里不是线", `${hint}。点在线上，或点下游节点的输入口。`, 4200);
        return; // 留在插入模式，还能接着点
      }
      toast("info", "已退出插入", hint, 3600);
      disarm();
      return;
    }

    const targets = armed?.nodes ?? [];
    disarm();
    if (!targets.length) return;

    if (targets.length === 1) {
      insertNodeIntoLink(targets[0], link, { gx: g.x, gy: g.y });
      return;
    }

    /* 多选：按顺序串联插入 A → B → C，中间不许断开 */
    // 记下点中的那条线的原始两端：串联过程中它会被拆掉，规划兄弟线时还要用
    const primSnap = { ...linkParts(link) };
    const primEnds = [
      app.graph.getNodeById(primSnap.origin_id),
      app.graph.getNodeById(primSnap.target_id),
    ];
    const beforeText = dumpText([...primEnds, ...targets], app.graph);
    const collected = [];
    const placed = [];
    let curLink = link;
    let exitLink = null;
    let done = 0;
    let autoSiblings = 0;
    let failedAt = null;

    // 整组只算一个撤销点
    beginChange();
    try {
      for (const n of targets) {
        lastInsertOutLinkId = null;
        lastInsertAutoCount = 0;
        const ok = insertNodeIntoLink(n, curLink, {
          gx: g.x,
          gy: g.y,
          silent: true,
          placeFrom: placed[placed.length - 1] ?? null, // 接着上一个节点往右排
          collect: collected, // 只有一头相邻的先记账，等整组插完再一起问
        });
        if (!ok) {
          failedAt = n;
          break;
        }
        done++;
        placed.push(n);
        autoSiblings += lastInsertAutoCount;

        const next = lastInsertOutLinkId != null ? getLink(app.graph, lastInsertOutLinkId) : null;
        if (!next) break;
        curLink = next;
        exitLink = linkParts(next);
      }
    } finally {
      endChange();
    }

    if (!done) return;

    /* 整组插完了，这时槽位占用才是最终状态，统一规划一遍兄弟线 */
    const plan = planChainExtras(placed, primSnap, exitLink, collected);

    const bits = [];
    if (autoSiblings) bits.push(`顺路接上 ${autoSiblings} 条线`);
    if (plan.items.length) bits.push(`另有 ${plan.items.length} 条兄弟线等你确认`);
    if (plan.skipped.length) bits.push(`${plan.skipped.length} 条没槽位 / 类型对不上，没接`);
    if (failedAt) bits.push(`${nodeName(failedAt)} 和后面那些留在原位`);

    const sec = [
      `主线：${nodeTag(primEnds[0])}.out[${primSnap.origin_slot}] → ${nodeTag(primEnds[1])}.in[${primSnap.target_slot}]`,
      `串联：${placed.map((n) => nodeTag(n)).join(" → ")}`,
      `结果：串进 ${done} / ${targets.length} · 顺路 ${autoSiblings} 条 · 待确认 ${plan.items.length} · 跳过 ${plan.skipped.length}`
        + (failedAt ? ` · 卡在 ${nodeTag(failedAt)}` : ""),
      "",
    ];
    if (plan.items.length) {
      sec.push("【等你确认的兄弟线】");
      for (const it of plan.items) sec.push(`  ${it.type}  ${it.from} → ${it.to}`);
      sec.push("");
    }
    if (plan.skipped.length) {
      sec.push("【跳过：新节点没有对应的空口】");
      for (const it of plan.skipped) {
        sec.push(`  ${it.type ?? "?"}  ${it.from ?? "?"} → ${it.to ?? "?"}`);
      }
      sec.push("");
    }
    sec.push("【插入前】", beforeText, "");
    sec.push("【插入后】", dumpText([...primEnds, ...placed], app.graph));
    const copied = publishReport(
      "串联插入",
      `${done} 个节点串进 ${nodeName(primEnds[0])} → ${nodeName(primEnds[1])}`,
      sec,
    );

    toast(
      failedAt ? "warn" : "success",
      failedAt ? `串联插入到 ${done} / ${targets.length} 个` : `已串联插入 ${done} 个节点`,
      [
        bits.join("　·　") || "已经串进这条线。",
        copied ? "连线报告已复制到剪贴板" : "连线报告已写入控制台（F12）",
      ].join("　·　"),
      failedAt ? 9000 : 6000
    );

    if (plan.items.length) {
      const avoid = placed.map((n) => `「${nodeName(n)}」`).join(" → ");
      setTimeout(
        () =>
          askConnectExtras(placed[placed.length - 1], plan.items, {
            apply: applyChainExtras,
            avoidText: escapeHtml(avoid),
          }),
        80
      );
    }

    console.log(LOG, "串联插入完成", {
      nodes: placed.map((n) => nodeName(n)),
      autoSiblings,
      pending: plan.items.length,
      skipped: plan.skipped.length,
      failedAt: failedAt ? nodeName(failedAt) : null,
    });
  };

  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      disarm();
    }
  };

  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("keydown", onKey, true);
  try {
    el.style.cursor = "crosshair";
  } catch (err) {
    /* ignore */
  }

  armed = { nodes: list, el, onDown, onMove, onKey };
  showArmedBar(list);
}
/* ============================================================
 * 九、菜单挂载
 * ============================================================ */

let newMenuApiUsed = false;

/* ---------- 菜单文字：跟随 ComfyUI 的 Locale 设置（设置 → Comfy → Locale） ----------
 *  只翻译菜单项本身，日志和 toast 提示仍是中文。
 *  取文字时现读语言，用户中途改设置也能跟上，不用刷新。
 *  这段与 nodeReplacer.js 里的同名部分保持一字不差，将来抽共享文件时直接搬。
 */
const MENU_I18N = {
  zh: { insert: "插入到连线", sep: "从连线中分离" },
  en: { insert: "Insert into link", sep: "Detach from link" },
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
  return MENU_I18N[menuLang()].insert;
}

function sepText() {
  return MENU_I18N[menuLang()].sep;
}

/* ---------- 提示文案：中文 → 英文 ----------
 *  英文界面下，toast 和顶部提示条里的中文在这里换成英文；中文界面原样返回。
 *  三种匹配按顺序试：
 *    1. 整句精确匹配（EN_TEXT）
 *    2. 用「·」拼起来的复合串，切开逐段匹配
 *    3. 正则模板（EN_RULES），处理带节点名 / 数字的句子
 *  都没命中就返回原句 —— 英文界面下会看到中文，但不会出错，之后按需补表。
 *  这段与 nodeReplacer.js 里的同名部分保持一字不差，将来抽共享文件时直接搬。
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

function entryText(el) {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** 当前弹出的菜单根节点（取最后一个，避免命中没清干净的旧菜单） */
function currentMenuRoot(text) {
  const roots = [...document.querySelectorAll(".litecontextmenu")];
  let hit = null;
  for (const root of roots) {
    const entries = [...root.querySelectorAll(".litemenu-entry")];
    if (entries.some((el) => entryText(el).includes(text))) hit = root;
  }
  return hit;
}

/** 把菜单项挪到「刷新节点」下面（和替换插件保持同一位置），分离项跟着走 */
function moveNearAnchor() {
  const label = menuText();
  const sepLabel = sepText();
  const root = currentMenuRoot(label);
  if (!root) return false;

  const entries = [...root.querySelectorAll(".litemenu-entry")];
  const ours = entries.find((el) => entryText(el).includes(label));
  if (!ours) return true;

  const parent = ours.parentElement;
  if (!parent) return true;

  const sep = entries.find(
    (el) => el !== ours && entryText(el).includes(sepLabel) && el.parentElement === parent
  );

  const anchor = [...parent.children].find(
    (el) =>
      el !== ours &&
      el !== sep &&
      !el.classList.contains("separator") &&
      ANCHOR_RE.test(entryText(el))
  );

  try {
    if (anchor) {
      parent.insertBefore(ours, anchor.nextElementSibling);
      if (sep) parent.insertBefore(sep, ours.nextElementSibling);
    } else {
      parent.insertBefore(ours, parent.firstElementChild);
      if (sep) parent.insertBefore(sep, ours.nextElementSibling);
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

/**
 * 这次操作作用于哪些节点。
 * 右键的那个如果不属于当前选区，就只对它生效；否则用整个选区（多选支持）。
 * 返回顺序按 x 从左到右，多选串联插入时就是图上的先后顺序。
 */
function contextNodesOf(contextNode) {
  const sel = selectedNodes();
  const selIds = new Set(sel.map((n) => n.id));

  if (contextNode && !selIds.has(contextNode.id)) return [contextNode];

  const list = sel.length ? sel : contextNode ? [contextNode] : [];
  return list
    .slice()
    .sort((a, b) => (a?.pos?.[0] ?? 0) - (b?.pos?.[0] ?? 0));
}

function buildMenuItem(contextNode) {
  const nodes = contextNodesOf(contextNode);
  const many = nodes.length > 1;

  let content = `➕ ${menuText()}…`;
  if (many) {
    content +=
      menuLang() === "zh" ? `（${nodes.length} 个串联）` : ` (${nodes.length} in a chain)`;
  }

  return {
    content,
    callback: () => {
      if (!nodes.length) {
        toast("info", "先选中要插入的节点", "选中后再右键它。", 5000);
        return;
      }
      arm(nodes);
    },
  };
}

function buildSeparateItem(contextNode) {
  const nodes = contextNodesOf(contextNode);
  const many = nodes.length > 1;

  let content = `✂ ${sepText()}`;
  if (many) {
    content += menuLang() === "zh" ? `（${nodes.length} 个）` : ` (${nodes.length} nodes)`;
  }

  return {
    content,
    callback: () => {
      if (!nodes.length) {
        toast("info", "先选中要分离的节点", "选中后再右键它。", 5000);
        return;
      }
      separateNodes(nodes);
    },
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
  if (proto.__nriPatched) return true;

  const original = proto.getNodeMenuOptions;
  proto.getNodeMenuOptions = function (node) {
    const options = original.apply(this, arguments) || [];
    if (!newMenuApiUsed && node) {
      options.push(null);
      options.push(buildMenuItem(node));
      options.push(buildSeparateItem(node));
      scheduleMenuReposition();
    }
    return options;
  };
  proto.__nriPatched = true;
  return true;
}

app.registerExtension({
  name: EXT_NAME,

  async setup() {
    patchLegacyMenu();

    // 排查用：F12 里执行 nri.version / nri.undoProbe() 等
    window.nri = {
      version: VERSION,
      findLinkAt: (x, y) => findLinkAt(x, y, 13 / (app.canvas?.ds?.scale || 1)),
      arm: (node) => arm(node ? [node] : selectedNodes()),
      disarm,
      separate: (node) => separateNodes(node ? [node] : selectedNodes()),
      undoProbe: () => {
        const t = changeTracker();
        return {
          trackerFound: !!t,
          via: t ? (piniaOf() ? "pinia" : "app") : "none",
          changeCount: t?.changeCount ?? null,
          undoQueue: t?.undoQueue?.length ?? null,
          redoQueue: t?.redoQueue?.length ?? null,
        };
      },
      /** 排查用：nri.dump() 把选中节点（没选就整张图）的连线导出并复制到剪贴板 */
      dump() {
        const g = app.graph;
        const picked = selectedNodes();
        const list = picked.length ? picked : (g?._nodes ?? []);
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
      /** 排查用：nri.last() 取回上一次插入 / 分离的完整报告 */
      last() {
        return lastReport ?? "还没有执行过插入或分离。";
      },
      /** 排查用：nri.copy() 把上一次的报告重新复制一次 */
      copy() {
        if (!lastReport) return "还没有执行过插入或分离。";
        try {
          globalThis.navigator?.clipboard?.writeText(lastReport);
          return "已复制";
        } catch (err) {
          return String(err);
        }
      },
    };

    console.log(
      `${LOG} v${VERSION} 已加载 — 右键节点 → 插入到连线… / 从连线中分离`
    );
  },

  /** 新版前端的节点右键菜单扩展点 */
  getNodeMenuItems(node) {
    newMenuApiUsed = true;
    if (!node) return [];
    scheduleMenuReposition();
    return [buildMenuItem(node), buildSeparateItem(node)];
  },

  /** 兜底入口：选中节点后，画布空白处右键也能进入插入模式 */
  getCanvasMenuItems() {
    if (!selectedNodes().length) return [];
    return [buildMenuItem(null)];
  },
});
