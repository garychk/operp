import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Graph, Shape } from "@antv/x6";
import type { Edge, Node } from "@antv/x6";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
  AimOutlined,
  ApartmentOutlined,
  DeleteOutlined,
  PlusOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import {
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from "antd";
import { useTranslation } from "react-i18next";
import {
  aliasTableMap,
  descendantsOf,
  joinDepths,
  nextAlias,
  sortJoinsByDependency,
  suggestParentAlias,
  wouldCreateCycle,
} from "./joinGraph";
import { shortTableName, tableDisplayName } from "./tableLabel";
import type {
  Aggregate,
  BaqColumn,
  BaqDefinition,
  BaqJoin,
  BaqRelation,
  BaqTable,
} from "./types";

/**
 * BAQ 图形化（ER 图式）设计器。
 *
 * 与原表格页签共用同一份 definition：
 *   · 卡片 = 一张数据表；勾选字段 → definition.fields
 *   · 连线 = definition.joins（左端 leftAlias.leftField，右端 alias.rightField）
 *   · 卡片坐标 → definition.layout，随 definition 一起落库（execute_baq 不读该键）
 *
 * 画布用项目已有的 @antv/x6（RoutingMap / BomEditableTreeGraph 同款依赖），
 * 节点是 x6 的 HTML 形状，内容由 React 单独挂 root 渲染，因此卡片里能直接用 antd 组件。
 */

const CARD_WIDTH = 248;
const CARD_HEADER_HEIGHT = 38;
const CARD_ROW_HEIGHT = 24;
const CARD_FOOTER_HEIGHT = 26;
const MAX_VISIBLE_FIELDS = 10;
const GRID_COLUMNS = 3;
const GRID_COLUMN_GAP = 320;
const GRID_ROW_GAP = 372;
const JOIN_EDGE_PREFIX = "join:";
const AUTO_FIT_DELAY = 60;

const cardHeight = (fieldCount: number) =>
  CARD_HEADER_HEIGHT +
  Math.min(Math.max(fieldCount, 1), MAX_VISIBLE_FIELDS) * CARD_ROW_HEIGHT +
  CARD_FOOTER_HEIGHT;

const autoPosition = (index: number) => ({
  x: 40 + (index % GRID_COLUMNS) * GRID_COLUMN_GAP,
  y: 40 + Math.floor(index / GRID_COLUMNS) * GRID_ROW_GAP,
});

/** 别名当前实际位置（layout 里没有就按画布顺序推算） */
const effectivePosition = (definition: BaqDefinition, alias: string) => {
  const stored = definition.layout?.[alias];
  if (stored) return stored;
  const order = [
    definition.source.alias,
    ...definition.joins.map((join) => join.alias),
  ];
  return autoPosition(Math.max(order.indexOf(alias), 0));
};

/**
 * 新表默认放在父表右侧，同一父表下依次向下排；
 * 位置被占就继续下移，避免新卡片压在已有卡片上。
 */
const childPosition = (
  definition: BaqDefinition,
  parentAlias: string,
  alias: string,
) => {
  const base = effectivePosition(definition, parentAlias);
  const taken = Object.entries(definition.layout ?? {})
    .filter(([key]) => key !== alias)
    .map(([, value]) => value);
  const x = base.x + CARD_WIDTH + 72;
  let y = base.y;
  let guard = 0;
  while (
    taken.some(
      (pos) => Math.abs(pos.x - x) < CARD_WIDTH && Math.abs(pos.y - y) < 160,
    ) &&
    guard < 40
  ) {
    y += 160;
    guard += 1;
  }
  return { x, y };
};

const joinEdgeId = (joinId: string) => `${JOIN_EDGE_PREFIX}${joinId}`;

// x6 v3 取消了 graph.getNodeById / getEdgeById，统一走 getCellById + 类型判断
const nodeById = (graph: Graph, id: string): Node | null => {
  const cell = graph.getCellById(id);
  return cell && cell.isNode() ? (cell as Node) : null;
};
const edgeById = (graph: Graph, id: string): Edge | null => {
  const cell = graph.getCellById(id);
  return cell && cell.isEdge() ? (cell as Edge) : null;
};

const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

/** 字段类型收敛成短标签，避免 248px 宽的卡片里被长类型名挤爆 */
const shortType = (type: string) => {
  const raw = (type || "").toLowerCase();
  if (!raw) return "";
  if (raw.includes("char") || raw === "text" || raw.includes("json")) return "text";
  if (raw.includes("timestamp") || raw.includes("time")) return "time";
  if (raw === "date") return "date";
  if (raw === "boolean" || raw === "bool") return "bool";
  if (
    raw.includes("int") ||
    raw === "numeric" ||
    raw === "decimal" ||
    raw === "real" ||
    raw.includes("double")
  )
    return "number";
  return raw.slice(0, 8);
};

let baqShapeRegistered = false;

/** 注册一次即可；内容由 React root 渲染，x6 只在尺寸变化时重新挂载该元素 */
const ensureBaqShape = () => {
  if (baqShapeRegistered) return;
  Shape.HTML.register({
    shape: "baq-table-node",
    width: CARD_WIDTH,
    height: cardHeight(6),
    effect: ["size"],
    html: (cell) =>
      (cell.getData() as { el?: HTMLElement } | undefined)?.el ?? "",
    ports: {
      groups: {
        out: {
          position: "right",
          attrs: {
            circle: {
              r: 5,
              magnet: true,
              stroke: "#1677ff",
              strokeWidth: 1.5,
              fill: "#fff",
            },
          },
        },
        in: {
          position: "left",
          attrs: {
            circle: {
              r: 5,
              magnet: true,
              stroke: "#8c8c8c",
              strokeWidth: 1.5,
              fill: "#fff",
            },
          },
        },
      },
      items: [
        { id: "in", group: "in" },
        { id: "out", group: "out" },
      ],
    },
  });
  baqShapeRegistered = true;
};

interface BaqTableCardProps {
  alias: string;
  table: string;
  label: string;
  isMain: boolean;
  columns: BaqColumn[];
  checkedFields: Set<string>;
  foreignKeys: Set<string>;
  onToggle: (field: string, checked: boolean) => void;
  onRemove?: () => void;
  removeTitle: string;
  mainTag: string;
  /** 非主表的层级标签（如「2 级」），主表用 mainTag */
  depthTag: string;
  fieldUnit: string;
}

function BaqTableCard({
  alias,
  table,
  label,
  isMain,
  columns,
  checkedFields,
  foreignKeys,
  onToggle,
  onRemove,
  removeTitle,
  mainTag,
  depthTag,
  fieldUnit,
}: BaqTableCardProps) {
  return (
    <Card
      size="small"
      className={`baq-graph-card${isMain ? " is-main" : ""}`}
      styles={{
        header: { padding: "0 10px", minHeight: 34 },
        body: { padding: "4px 0" },
      }}
      title={
        <div className="baq-graph-card-title">
          <span className="baq-graph-card-label" title={table}>
            {label}
          </span>
          <span className="baq-graph-card-alias">
            {alias}
            {" · "}
            {isMain ? mainTag : depthTag}
          </span>
        </div>
      }
      extra={
        !isMain && onRemove ? (
          <Button
            type="text"
            size="small"
            danger
            title={removeTitle}
            icon={<DeleteOutlined />}
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
          />
        ) : undefined
      }
    >
      <div
        className="baq-graph-fields"
        style={{ maxHeight: MAX_VISIBLE_FIELDS * CARD_ROW_HEIGHT }}
      >
        {columns.length === 0 ? (
          <div className="baq-graph-fields-empty">—</div>
        ) : (
          columns.map((column) => {
            const checked = checkedFields.has(column.name);
            const keyTag =
              column.name === "id"
                ? "PK"
                : foreignKeys.has(`${table}.${column.name}`)
                  ? "FK"
                  : "";
            return (
              <div
                key={column.name}
                className={`baq-graph-field${checked ? " is-checked" : ""}`}
              >
                <Checkbox
                  checked={checked}
                  onChange={(event) =>
                    onToggle(column.name, event.target.checked)
                  }
                />
                <span
                  className="baq-graph-field-name"
                  title={column.name}
                  onClick={() => onToggle(column.name, !checked)}
                >
                  {column.name}
                </span>
                <span className="baq-graph-field-key">{keyTag}</span>
                <span className="baq-graph-field-type">
                  {shortType(column.type)}
                </span>
              </div>
            );
          })
        )}
      </div>
      <div className="baq-graph-card-footer">
        {alias} · {checkedFields.size}/{columns.length} {fieldUnit}
      </div>
    </Card>
  );
}

interface BaqGraphDesignerProps {
  definition: BaqDefinition;
  catalog: BaqTable[];
  relations: BaqRelation[];
  patchDef: (patch: Partial<BaqDefinition>) => void;
}

export function BaqGraphDesigner({
  definition,
  catalog,
  relations,
  patchDef,
}: BaqGraphDesignerProps) {
  const { t, i18n } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const hostsRef = useRef(new Map<string, { root: Root; el: HTMLDivElement }>());
  const defRef = useRef(definition);
  defRef.current = definition;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const relationsRef = useRef(relations);
  relationsRef.current = relations;
  const fittedRef = useRef(false);
  /**
   * 未选主表时渲染的是「空态」分支，DOM 里根本没有画布容器，
   * 所以建图 effect 必须等到画布真正挂载后再跑一次 —— 否则首次选完主表，
   * 画布区永远是空白（图建在一个 null 容器上）。
   */
  const hasMainTable = !!definition.source.table;

  const [selectedAlias, setSelectedAlias] = useState<string | null>(null);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [selectedJoinId, setSelectedJoinId] = useState<string | null>(null);
  const [pendingFrom, setPendingFrom] = useState<string | null>(null);
  const [pendingTable, setPendingTable] = useState<string>("");

  const aggregateOptions = useMemo(
    () =>
      ["none", "sum", "count", "avg", "min", "max"].map((value) => ({
        value,
        label:
          value === "none" ? t("baqDesigner.noAggregate") : value.toUpperCase(),
      })),
    [t],
  );

  const columnsOf = useCallback(
    (table: string) =>
      catalogRef.current.find((item) => item.table === table)?.columns ?? [],
    [],
  );
  const labelOf = useCallback((table: string) => {
    const item = catalogRef.current.find((entry) => entry.table === table);
    // 显示用短名；完整物理表名通过卡片 title 悬停可见
    return tableDisplayName(table, item?.label);
  }, []);

  const fkSet = useMemo(
    () => new Set(relations.map((item) => `${item.table}.${item.column}`)),
    [relations],
  );

  /** 依据外键元数据猜关联字段；猜不到就留空让用户在右侧面板选 */
  const guessJoinFields = useCallback((leftTable: string, rightTable: string) => {
    const list = relationsRef.current;
    const direct = list.find(
      (item) => item.table === leftTable && item.refTable === rightTable,
    );
    if (direct) return { leftField: direct.column, rightField: direct.refColumn };
    const reverse = list.find(
      (item) => item.table === rightTable && item.refTable === leftTable,
    );
    if (reverse) return { leftField: reverse.refColumn, rightField: reverse.column };
    return { leftField: "", rightField: "" };
  }, []);

  /** 结构签名：只在真正影响画布的内容变化时重跑同步，避免拖动中反复重建 */
  const structureKey = useMemo(
    () =>
      JSON.stringify([
        definition.source,
        definition.joins,
        definition.fields,
        definition.layout,
        definition.filters,
        definition.sorts,
        catalog.length,
        relations.length,
        i18n.language,
      ]),
    [definition, catalog.length, relations.length, i18n.language],
  );

  const aliases = useMemo(
    () => [
      {
        alias: definition.source.alias,
        table: definition.source.table,
        isMain: true,
      },
      ...definition.joins.map((join) => ({
        alias: join.alias,
        table: join.table,
        isMain: false,
      })),
    ],
    [definition.source, definition.joins],
  );

  /**
   * 把一张表加进画布。
   *
   * fromAlias 为空时不再恒定挂主表，而是按外键猜一个父表（下钻场景：详情表 →
   * 主档表），这样「子表再关联子表」只点两下就能连出来。
   */
  const appendTable = useCallback(
    (table: string, fromAlias?: string) => {
      const def = defRef.current;
      if (!def.source.table) return;
      const alias = nextAlias([
        def.source.alias,
        ...def.joins.map((join) => join.alias),
      ]);
      const parentAlias =
        fromAlias ??
        suggestParentAlias(
          def.source,
          def.joins,
          table,
          relationsRef.current ?? [],
        ) ??
        def.source.alias;
      const tableOf = aliasTableMap(def.source, def.joins);
      const guess = guessJoinFields(
        tableOf.get(parentAlias) ?? def.source.table,
        table,
      );
      const join: BaqJoin = {
        id: uid(),
        type: "left",
        table,
        alias,
        leftAlias: parentAlias,
        leftField: guess.leftField,
        rightField: guess.rightField,
      };
      // 新 join 可能挂在更深的层级上，统一重排一次保证 JOIN 顺序合法
      const sorted = sortJoinsByDependency(def.source, [...def.joins, join]);
      patchDef({
        joins: sorted.joins,
        layout: {
          ...(def.layout ?? {}),
          [alias]: childPosition(def, parentAlias, alias),
        },
      });
      setSelectedJoinId(join.id);
      setSelectedAlias(alias);
    },
    [guessJoinFields, patchDef],
  );

  /**
   * 改一条关联的父表（左表）。
   *
   * 不再限制方向（原来只允许「靠前的表 → 靠后的表」，所以子表没法挂到另一张
   * 子表下面），改成：成环才拒绝，合法的改动自动把 joins 重排成依赖顺序。
   * 父表换掉后左字段所属表也变了，用外键元数据重新猜一次。
   */
  const reparentJoin = (joinId: string, parentAlias: string) => {
    const def = defRef.current;
    const join = def.joins.find((item) => item.id === joinId);
    if (!join || join.leftAlias === parentAlias) return;
    if (wouldCreateCycle(def.source, def.joins, join.alias, parentAlias)) {
      message.warning(t("baqDesigner.graphJoinCycle"));
      return;
    }
    const tableOf = aliasTableMap(def.source, def.joins);
    const guess = guessJoinFields(
      tableOf.get(parentAlias) ?? "",
      join.table,
    );
    const sorted = sortJoinsByDependency(
      def.source,
      def.joins.map((item) =>
        item.id === joinId ? { ...item, leftAlias: parentAlias } : item,
      ),
    );
    patchDef({
      joins: sorted.joins.map((item) =>
        item.id === joinId
          ? {
              ...item,
              // 左字段属于旧父表，换表后必须重取；右字段是子表自己的列，猜不到就留着
              leftField: guess.leftField,
              rightField: guess.rightField || item.rightField,
            }
          : item,
      ),
    });
    setSelectedJoinId(joinId);
  };

  /** 拖线落点：连到已加入的表 → 改关联父表；落在空白 → 弹窗选表新增 */
  const connectHandlerRef = useRef<(edge: Edge) => void>(() => undefined);
  connectHandlerRef.current = (edge: Edge) => {
    const graph = graphRef.current;
    if (!graph) return;
    const def = defRef.current;
    const source = edge.getSourceCell();
    const target = edge.getTargetCell();
    const drop = () => graph.removeEdge(edge);
    if (!source || !source.id) {
      drop();
      return;
    }
    if (!aliasTableMap(def.source, def.joins).has(source.id)) {
      drop();
      return;
    }
    if (!target) {
      drop();
      setPendingTable("");
      setPendingFrom(source.id);
      return;
    }
    if (target.id === source.id) {
      drop();
      message.info(t("baqDesigner.graphSelfLoopUnsupported"));
      return;
    }
    const join = def.joins.find((item) => item.alias === target.id);
    if (!join) {
      drop();
      message.info(t("baqDesigner.graphTargetNotOnCanvas"));
      return;
    }
    if (join.leftAlias === source.id) {
      drop();
      message.info(t("baqDesigner.graphJoinExists"));
      return;
    }
    drop();
    reparentJoin(join.id, source.id);
  };

  /**
   * 位置回写：x6 v3 没有 node:moved，而 node:change:position 在拖动过程中会持续触发
   * （每次回写 definition 都会让整块画布重渲染）。折中做法是在 window mouseup 时统一读一次。
   */
  const flushPositionsRef = useRef<() => void>(() => undefined);
  flushPositionsRef.current = () => {
    const graph = graphRef.current;
    if (!graph) return;
    const def = defRef.current;
    const next = { ...(def.layout ?? {}) };
    let changed = false;
    graph.getNodes().forEach((node) => {
      const position = node.position();
      const x = Math.round(position.x);
      const y = Math.round(position.y);
      const current = next[node.id];
      if (!current || current.x !== x || current.y !== y) {
        next[node.id] = { x, y };
        changed = true;
      }
    });
    if (changed) patchDef({ layout: next });
  };

  // ------------------------------------------------- 建图（画布挂载后一次）
  useEffect(() => {
    ensureBaqShape();
    const container = containerRef.current;
    if (!container) return;
    // 新图建好后重新做一次居中（空态切过来 / 主表换过都适用）
    fittedRef.current = false;
    const graph = new Graph({
      container,
      // 不能用 x6 自带 autoResize：它观察的是画布的「父容器」，并把父容器尺寸
      // 写回画布内联样式 → 画布长高 → 父容器跟着长高 → 无限增长（画布被撑到上万 px）。
      // 下面改为自己观察画布本身：画布高度由 CSS 固定、宽度来自 flex，
      // 写回的尺寸和 CSS 一致，不会形成反馈环。
      autoResize: false,
      background: { color: "#fafafa" },
      grid: {
        size: 12,
        visible: true,
        type: "dot",
        args: { color: "#e6e6e6", thickness: 1 },
      },
      panning: { enabled: true, eventTypes: ["leftMouseDown", "mouseWheel"] },
      mousewheel: {
        enabled: true,
        modifiers: ["ctrl", "meta"],
        minScale: 0.4,
        maxScale: 1.5,
      },
      connecting: {
        snap: { radius: 30 },
        allowBlank: true,
        allowLoop: false,
        allowNode: false,
        allowEdge: false,
        allowMulti: true,
        highlight: true,
        router: { name: "manhattan" },
        connector: { name: "rounded" },
        createEdge() {
          return this.createEdge({
            attrs: {
              line: {
                stroke: "#1677ff",
                strokeWidth: 1.6,
                strokeDasharray: "5 4",
                targetMarker: { name: "block", width: 8, height: 6 },
              },
            },
            zIndex: 5,
          });
        },
      },
    });
    graphRef.current = graph;

    // 自行跟随画布尺寸，两个坑都在这儿：
    // ① 不能用 x6 自带 autoResize：它观察的是画布的「父容器」，并把父容器尺寸写回画布
    //    内联样式 → 画布长高 → 父容器跟着长高 → 无限增长（实测画布被撑到上万 px）。
    // ② 切到其他 Tab 时画布被 display:none 隐藏，尺寸变 0，若把 0 写回内联样式，
    //    内联样式会盖过 CSS，切回来画布永久 0 宽（表现就是「表和连线全没了」）。
    const syncSize = () => {
      const width = container.parentElement?.clientWidth ?? 0;
      const height = container.clientHeight;
      if (!width || !height) return;
      graph.resize(width, height);
    };
    const resizeObserver = new ResizeObserver(() => syncSize());
    resizeObserver.observe(container.parentElement ?? container);

    graph.on("node:click", ({ node }) => {
      setSelectedAlias(node.id);
      setSelectedJoinId(null);
    });
    graph.on("blank:click", () => {
      setSelectedAlias(null);
      setSelectedJoinId(null);
    });
    graph.on("edge:click", ({ edge }) => {
      const joinId = (edge.getData() as { joinId?: string } | undefined)?.joinId;
      if (joinId) {
        setSelectedJoinId(joinId);
        setSelectedAlias(null);
      }
    });
    graph.on("edge:connected", ({ edge }) => connectHandlerRef.current(edge));
    const onMouseUp = () => flushPositionsRef.current();
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mouseup", onMouseUp);
      resizeObserver.disconnect();
      graph.dispose();
      graphRef.current = null;
      hostsRef.current.forEach((host) => host.root.unmount());
      hostsRef.current.clear();
    };
  }, [hasMainTable]);

  // ------------------------------------------------- 结构同步（节点 / 连线 / 内容）
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const def = definition;
    const liveAliases = aliases.filter((item) => !!item.table);
    const keep = new Set(liveAliases.map((item) => item.alias));

    // 1) 清掉已从 definition 移除的表
    graph.getNodes().forEach((node) => {
      if (keep.has(node.id)) return;
      const host = hostsRef.current.get(node.id);
      if (host) {
        hostsRef.current.delete(node.id);
        window.setTimeout(() => host.root.unmount(), 0);
      }
      graph.removeNode(node);
    });

    // 2) 补建缺的表，并按 layout 校正位置（拖动中的位置不回写，避免抖动）
    liveAliases.forEach((item, index) => {
      const height = cardHeight(columnsOf(item.table).length);
      const existing = nodeById(graph, item.alias);
      if (!existing) {
        const el = document.createElement("div");
        el.className = "baq-graph-node-host";
        const root = createRoot(el);
        hostsRef.current.set(item.alias, { root, el });
        const stored = def.layout?.[item.alias];
        const position = stored ?? autoPosition(index);
        graph.addNode({
          id: item.alias,
          shape: "baq-table-node",
          x: position.x,
          y: position.y,
          width: CARD_WIDTH,
          height,
          data: { el },
          zIndex: item.isMain ? 10 : 1,
        });
      } else {
        const size = existing.size();
        if (size.width !== CARD_WIDTH || size.height !== height) {
          existing.resize(CARD_WIDTH, height);
        }
        const stored = def.layout?.[item.alias];
        if (stored) {
          const position = existing.position();
          if (position.x !== stored.x || position.y !== stored.y) {
            existing.setPosition(stored.x, stored.y);
          }
        }
      }
    });

    // 3) 重渲染每张卡片的内容
    const depths = joinDepths(def.source, def.joins);
    liveAliases.forEach((item) => {
      const host = hostsRef.current.get(item.alias);
      if (!host) return;
      const checked = new Set(
        def.fields
          .filter((field) => field.tableAlias === item.alias)
          .map((field) => field.field),
      );
      const removeNode = item.isMain
        ? undefined
        : () => removeAliases([item.alias]);
      host.root.render(
        <BaqTableCard
          alias={item.alias}
          table={item.table}
          label={labelOf(item.table)}
          isMain={item.isMain}
          columns={columnsOf(item.table)}
          checkedFields={checked}
          foreignKeys={fkSet}
          onToggle={(field, isChecked) => {
            const current = defRef.current;
            const hit = current.fields.find(
              (entry) =>
                entry.tableAlias === item.alias && entry.field === field,
            );
            if (isChecked) {
              if (hit) return;
              patchDef({
                fields: [
                  ...current.fields,
                  {
                    id: uid(),
                    tableAlias: item.alias,
                    field,
                    alias: field,
                    aggregate: "none",
                    groupBy: false,
                  },
                ],
              });
              setSelectedFieldId(null);
            } else {
              if (!hit) return;
              patchDef({
                fields: current.fields.filter((entry) => entry.id !== hit.id),
                sorts: current.sorts.filter(
                  (sort) => sort.fieldAlias !== hit.alias,
                ),
              });
              setSelectedFieldId((id) => (id === hit.id ? null : id));
            }
          }}
          onRemove={removeNode}
          removeTitle={t("baqDesigner.graphRemoveTable")}
          mainTag={t("baqDesigner.graphMainTag")}
          depthTag={t("baqDesigner.graphLevelTag", {
            level: depths.get(item.alias) ?? 1,
          })}
          fieldUnit={t("baqDesigner.graphFieldUnit")}
        />,
      );
    });

    // 4) 连线与 definition.joins 对齐
    const liveJoins = def.joins.filter((join) => !!join.table);
    const keepEdges = new Set(liveJoins.map((join) => joinEdgeId(join.id)));
    graph.getEdges().forEach((edge) => {
      if (edge.id.startsWith(JOIN_EDGE_PREFIX) && !keepEdges.has(edge.id)) {
        graph.removeEdge(edge);
      }
    });
    liveJoins.forEach((join) => {
      const complete = !!join.leftField && !!join.rightField;
      const label =
        `${join.type === "inner" ? "INNER" : "LEFT"} · ` +
        `${join.leftAlias}.${join.leftField || "?"} = ${join.alias}.${join.rightField || "?"}`;
      const attrs = {
        line: {
          stroke: complete ? "#1677ff" : "#faad14",
          strokeWidth: 1.6,
          strokeDasharray: complete ? undefined : "4 3",
          targetMarker: { name: "block", width: 8, height: 6 },
        },
      };
      const labelAttrs = {
        label: {
          text: label,
          fill: complete ? "#1677ff" : "#d46b08",
          fontSize: 11,
        },
        body: {
          fill: "#fff",
          stroke: complete ? "#d6e4ff" : "#ffe7ba",
          strokeWidth: 1,
          rx: 3,
          ry: 3,
        },
      };
      const edgeId = joinEdgeId(join.id);
      const existing = edgeById(graph, edgeId);
      if (!existing) {
        if (!nodeById(graph, join.leftAlias) || !nodeById(graph, join.alias)) {
          return;
        }
        graph.addEdge({
          id: edgeId,
          shape: "edge",
          source: { cell: join.leftAlias, port: "out" },
          target: { cell: join.alias, port: "in" },
          router: { name: "manhattan" },
          connector: { name: "rounded" },
          attrs,
          labels: [{ attrs: labelAttrs }],
          // 连线压在卡片之上：manhattan 路线基本走卡片间隙，
          // 而标签比间隙宽，压在卡片下面会被整段遮住
          zIndex: 20,
          data: { joinId: join.id },
        });
      } else {
        existing.attr("line/stroke", attrs.line.stroke);
        existing.attr("line/strokeDasharray", attrs.line.strokeDasharray ?? null);
        existing.setLabels([{ attrs: labelAttrs }]);
      }
    });

    if (!fittedRef.current && liveAliases.length > 0) {
      fittedRef.current = true;
      // 首屏尽量 1:1 全览，放不下时最小缩到 0.75（再小字就看不清了）
      window.setTimeout(
        () => graph.zoomToFit({ padding: 24, minScale: 0.75, maxScale: 1 }),
        AUTO_FIT_DELAY,
      );
    }
    // 只随结构签名重跑；effect 闭包里的 definition / aliases 等都由该签名覆盖
  }, [structureKey]);

  // -------------------------------------------------------------------- 交互
  const toggleJoin = (joinId: string, patch: Partial<BaqJoin>) => {
    const def = defRef.current;
    patchDef({
      joins: def.joins.map((join) =>
        join.id === joinId ? { ...join, ...patch } : join,
      ),
    });
  };

  /**
   * 移除表（含其全部下游表）。
   *
   * 下游表的左别名指向被删掉的表，留着会让生成的 SQL 引用不存在的别名而报错，
   * 所以必须整棵子树一起摘掉。layout 里的残留坐标顺手清掉。
   */
  const removeAliases = (targets: Iterable<string>) => {
    const def = defRef.current;
    const doomed = new Set<string>(targets);
    doomed.forEach((alias) => {
      descendantsOf(def.joins, alias).forEach((child) => doomed.add(child));
    });
    if (doomed.size === 0) return;
    const layout: Record<string, { x: number; y: number }> = {};
    Object.entries(def.layout ?? {}).forEach(([alias, position]) => {
      if (!doomed.has(alias)) layout[alias] = position;
    });
    const removedAliases = def.joins.filter((join) =>
      doomed.has(join.alias),
    ).length;
    patchDef({
      joins: def.joins.filter((join) => !doomed.has(join.alias)),
      fields: def.fields.filter((field) => !doomed.has(field.tableAlias)),
      filters: def.filters.filter((filter) => !doomed.has(filter.tableAlias)),
      layout,
    });
    setSelectedJoinId((id) =>
      def.joins.some((join) => join.id === id && doomed.has(join.alias))
        ? null
        : id,
    );
    setSelectedAlias((alias) => (alias && doomed.has(alias) ? null : alias));
    // 被删的表还带着下游时给个提示，避免用户以为只删了一张
    if (removedAliases > 1) {
      message.info(
        t("baqDesigner.graphCascadeRemoved", { count: removedAliases - 1 }),
      );
    }
  };

  const removeJoin = (joinId: string) => {
    const def = defRef.current;
    const join = def.joins.find((item) => item.id === joinId);
    if (!join) return;
    removeAliases([join.alias]);
    setSelectedJoinId(null);
  };

  const patchField = (
    fieldId: string,
    patch: Partial<BaqDefinition["fields"][number]>,
  ) => {
    const def = defRef.current;
    patchDef({
      fields: def.fields.map((field) =>
        field.id === fieldId ? { ...field, ...patch } : field,
      ),
    });
  };

  /**
   * 自动发现关联。
   *
   * 注意：一条 join = 一个 FROM 项，别名在查询里唯一，所以「发现」不能凭外键凭空
   * 多连一条线（那会产生重复别名）。真正能做的是两件事：
   *   1) 用外键元数据把连线里空着的左/右字段补全（拉线时没猜到的、手工加表留下的）；
   *   2) 报告「与画布上的表存在外键、但还没加入画布」的表，提示可以补上。
   */
  const discoverRelations = () => {
    const def = defRef.current;
    if (!def.source.table) return;
    const tableOf = new Map<string, string>([
      [def.source.alias, def.source.table],
      ...def.joins.map((join) => [join.alias, join.table] as [string, string]),
    ]);
    let filled = 0;
    const joins = def.joins.map((join) => {
      if (join.leftField && join.rightField) return join;
      const guess = guessJoinFields(
        tableOf.get(join.leftAlias) ?? "",
        join.table,
      );
      const leftField = join.leftField || guess.leftField;
      const rightField = join.rightField || guess.rightField;
      if (leftField !== join.leftField || rightField !== join.rightField) {
        filled += 1;
      }
      return { ...join, leftField, rightField };
    });
    const present = new Set([
      def.source.table,
      ...def.joins.map((join) => join.table),
    ]);
    const missing = new Set<string>();
    (relationsRef.current ?? []).forEach((relation) => {
      if (present.has(relation.table) && !present.has(relation.refTable)) {
        missing.add(relation.refTable);
      }
      if (present.has(relation.refTable) && !present.has(relation.table)) {
        missing.add(relation.table);
      }
    });
    if (filled) patchDef({ joins });
    if (filled && missing.size) {
      message.success(
        t("baqDesigner.graphDiscoverFilledAndMissing", {
          filled,
          count: missing.size,
        }),
      );
    } else if (filled) {
      message.success(t("baqDesigner.graphDiscoverFilled", { filled }));
    } else if (missing.size) {
      message.info(t("baqDesigner.graphDiscoverMissing", { count: missing.size }));
    } else {
      message.info(t("baqDesigner.graphDiscoverNone"));
    }
  };

  const confirmPending = () => {
    if (!pendingFrom || !pendingTable) return;
    appendTable(pendingTable, pendingFrom);
    setPendingFrom(null);
    setPendingTable("");
  };

  const pendingOptions = useMemo(() => {
    const sourceTable = pendingFrom
      ? (aliases.find((item) => item.alias === pendingFrom)?.table ?? "")
      : "";
    const related = new Set(
      relations
        .filter(
          (item) => item.table === sourceTable || item.refTable === sourceTable,
        )
        .flatMap((item) => [item.table, item.refTable]),
    );
    return [...catalog]
      .sort((a, b) => {
        const aHit = related.has(a.table) ? 0 : 1;
        const bHit = related.has(b.table) ? 0 : 1;
        if (aHit !== bHit) return aHit - bHit;
        return tableDisplayName(a.table, a.label).localeCompare(
          tableDisplayName(b.table, b.label),
        );
      })
      .map((item) => ({
        // value 一律是完整物理表名；label 只做显示（去掉租户后缀）
        value: item.table,
        title: item.table,
        label: related.has(item.table)
          ? `${tableDisplayName(item.table, item.label)} · ${t("baqDesigner.graphRelatedHint")}`
          : tableDisplayName(item.table, item.label),
      }));
  }, [aliases, catalog, pendingFrom, relations, t]);

  const tableOptions = useMemo(
    () =>
      catalog.map((item) => {
        const short = shortTableName(item.table);
        const label = shortTableName(item.label);
        return {
          // value 必须是完整物理表名（落库、执行查询都用它），别去掉后缀
          value: item.table,
          title: item.table,
          label: label && label !== short ? `${label} · ${short}` : short,
        };
      }),
    [catalog],
  );

  const selectedField = definition.fields.find(
    (field) => field.id === selectedFieldId,
  );

  /** 右侧关联面板用：别名层级 + 每条关联可选的父表 */
  const panelDepths = useMemo(
    () => joinDepths(definition.source, definition.joins),
    [definition.source, definition.joins],
  );

  const parentOptionsOf = useCallback(
    (join: BaqJoin) => {
      const blocked = descendantsOf(definition.joins, join.alias);
      return [
        {
          alias: definition.source.alias,
          table: definition.source.table,
        },
        ...definition.joins.map((item) => ({
          alias: item.alias,
          table: item.table,
        })),
      ]
        .filter(
          (item) =>
            item.table &&
            item.alias !== join.alias &&
            !blocked.has(item.alias),
        )
        .map((item) => ({
          value: item.alias,
          label: `${item.alias} · ${labelOf(item.table)}`,
          title: item.table,
        }));
    },
    [definition.joins, definition.source, labelOf],
  );

  if (!definition.source.table) {
    return (
      <div className="baq-graph-layout">
        <div className="baq-graph-canvas-wrap">
          <div className="baq-graph-toolbar">
            <Select
              className="baq-graph-main-picker"
              showSearch
              optionFilterProp="label"
              placeholder={t("baqDesigner.graphMainTablePlaceholder")}
              options={tableOptions}
              onChange={(table) =>
                patchDef({
                  source: { table, alias: "t0" },
                  joins: [],
                  fields: [],
                  filters: [],
                  sorts: [],
                  layout: {},
                })
              }
            />
          </div>
          <div className="baq-graph-canvas is-empty">
            <Empty description={t("baqDesigner.graphPickMainTable")} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="baq-graph-layout">
      <div className="baq-graph-canvas-wrap">
        <div className="baq-graph-toolbar">
          <span className="baq-graph-toolbar-label">
            {t("baqDesigner.graphMainTable")}
          </span>
          <Select
            className="baq-graph-main-picker"
            showSearch
            optionFilterProp="label"
            value={definition.source.table}
            options={tableOptions}
            onChange={(table) => {
              if (table === definition.source.table) return;
              patchDef({
                source: { table, alias: "t0" },
                joins: [],
                fields: [],
                filters: [],
                sorts: [],
                layout: {},
              });
              fittedRef.current = false;
            }}
          />
          <span className="baq-graph-toolbar-divider" />
          <Select
            key={`baq-add-table-${definition.joins.length}`}
            className="baq-graph-add-picker"
            showSearch
            optionFilterProp="label"
            placeholder={t("baqDesigner.graphAddTable")}
            suffixIcon={<PlusOutlined />}
            options={tableOptions}
            onChange={(table) => appendTable(table)}
          />
          <Button
            icon={<ThunderboltOutlined />}
            onClick={discoverRelations}
          >
            {t("baqDesigner.graphAutoDiscover")}
          </Button>
          <Button
            icon={<AimOutlined />}
            onClick={() =>
              graphRef.current?.zoomToFit({ padding: 30, maxScale: 1 })
            }
          >
            {t("baqDesigner.graphFitView")}
          </Button>
          <span className="baq-graph-toolbar-hint">
            {t("baqDesigner.graphDragHint")}
          </span>
        </div>
        <div ref={containerRef} className="baq-graph-canvas" />
      </div>

      <aside className="baq-graph-panel">
        <section className="baq-graph-panel-section">
          <div className="baq-graph-panel-title">
            <ApartmentOutlined />
            <span>
              {t("baqDesigner.outputFieldsTab", {
                count: definition.fields.length,
              })}
            </span>
          </div>
          {definition.fields.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t("baqDesigner.graphNoFields")}
            />
          ) : (
            <div className="baq-graph-field-list">
              {definition.fields.map((field) => {
                const active = field.id === selectedFieldId;
                return (
                  <div key={field.id} className="baq-graph-field-item">
                    <div
                      className={`baq-graph-field-item-head${active ? " is-active" : ""}`}
                      onClick={() => setSelectedFieldId(active ? null : field.id)}
                    >
                      <span className="baq-graph-field-item-name">
                        {field.tableAlias}.{field.field}
                      </span>
                      <span className="baq-graph-field-item-alias">
                        {field.alias}
                      </span>
                      {field.aggregate !== "none" && (
                        <Tag color="blue">{(field.aggregate || "none").toUpperCase()}</Tag>
                      )}
                      {field.groupBy && <Tag color="green">GROUP</Tag>}
                    </div>
                    {active && (
                      <div className="baq-graph-field-editor">
                        <label>
                          <span>{t("baqDesigner.outputAlias")}</span>
                          <Input
                            size="small"
                            value={field.alias}
                            onChange={(event) =>
                              patchField(field.id, {
                                alias: event.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          <span>{t("baqDesigner.aggregate")}</span>
                          <Select
                            size="small"
                            value={field.aggregate}
                            options={aggregateOptions}
                            onChange={(aggregate: Aggregate) =>
                              patchField(field.id, { aggregate })
                            }
                          />
                        </label>
                        <label className="is-inline">
                          <span>{t("baqDesigner.groupBy")}</span>
                          <Switch
                            size="small"
                            checked={field.groupBy}
                            onChange={(groupBy) =>
                              patchField(field.id, { groupBy })
                            }
                          />
                        </label>
                        <Button
                          size="small"
                          danger
                          type="text"
                          icon={<DeleteOutlined />}
                          onClick={() => {
                            const def = defRef.current;
                            patchDef({
                              fields: def.fields.filter(
                                (entry) => entry.id !== field.id,
                              ),
                              sorts: def.sorts.filter(
                                (sort) => sort.fieldAlias !== field.alias,
                              ),
                            });
                            setSelectedFieldId(null);
                          }}
                        >
                          {t("baqDesigner.graphRemoveField")}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="baq-graph-panel-section">
          <div className="baq-graph-panel-title">
            <ApartmentOutlined />
            <span>{t("baqDesigner.graphJoinsTitle")}</span>
            <span className="baq-graph-panel-count">
              {definition.joins.length}
            </span>
          </div>
          <div className="baq-graph-join-list">
            {definition.joins.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t("baqDesigner.graphNoJoins")}
              />
            ) : (
              definition.joins.map((join) => {
                const active = join.id === selectedJoinId;
                return (
                  <div
                    key={join.id}
                    className={`baq-graph-join-item${active ? " is-active" : ""}`}
                    onClick={() => setSelectedJoinId(join.id)}
                  >
                    <div className="baq-graph-join-head">
                      <Select
                        size="small"
                        className="baq-graph-join-type"
                        value={join.type}
                        options={[
                          { value: "inner", label: "INNER" },
                          { value: "left", label: "LEFT" },
                        ]}
                        onChange={(type: BaqJoin["type"]) =>
                          toggleJoin(join.id, { type })
                        }
                      />
                      <span className="baq-graph-join-table">
                        {join.alias} · {labelOf(join.table)}
                      </span>
                      <span className="baq-graph-join-level">
                        {t("baqDesigner.graphLevelTag", {
                          level: panelDepths.get(join.alias) ?? 1,
                        })}
                      </span>
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={(event) => {
                          event.stopPropagation();
                          removeJoin(join.id);
                        }}
                      />
                    </div>
                    <div className="baq-graph-join-parent">
                      <span className="baq-graph-join-parent-label">
                        {t("baqDesigner.graphParentTable")}
                      </span>
                      <Select
                        size="small"
                        className="baq-graph-join-parent-select"
                        value={join.leftAlias}
                        options={parentOptionsOf(join)}
                        onChange={(parentAlias: string) =>
                          reparentJoin(join.id, parentAlias)
                        }
                      />
                    </div>
                    <div className="baq-graph-join-body">
                      <Select
                        size="small"
                        className="baq-graph-join-field"
                        showSearch
                        value={join.leftField || undefined}
                        placeholder={t("baqDesigner.leftField")}
                        options={columnsOf(
                          aliases.find((item) => item.alias === join.leftAlias)
                            ?.table ?? "",
                        ).map((column) => ({
                          value: column.name,
                          label: column.name,
                        }))}
                        onChange={(leftField) =>
                          toggleJoin(join.id, { leftField })
                        }
                      />
                      <span className="baq-graph-join-eq">=</span>
                      <Select
                        size="small"
                        className="baq-graph-join-field"
                        showSearch
                        value={join.rightField || undefined}
                        placeholder={t("baqDesigner.rightField")}
                        options={columnsOf(join.table).map((column) => ({
                          value: column.name,
                          label: column.name,
                        }))}
                        onChange={(rightField) =>
                          toggleJoin(join.id, { rightField })
                        }
                      />
                    </div>
                    <div className="baq-graph-join-note">
                      {join.leftAlias} → {join.alias}
                      {(!join.leftField || !join.rightField) && (
                        <Tag color="orange">
                          {t("baqDesigner.graphJoinIncomplete")}
                        </Tag>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {selectedField && (
          <section className="baq-graph-panel-section is-muted">
            <Typography.Text type="secondary">
              {t("baqDesigner.graphFieldSelectedHint", {
                field: `${selectedField.tableAlias}.${selectedField.field}`,
              })}
            </Typography.Text>
          </section>
        )}
        {selectedAlias && (
          <section className="baq-graph-panel-section is-muted">
            <Typography.Text type="secondary">
              {t("baqDesigner.graphTableSelectedHint", { alias: selectedAlias })}
            </Typography.Text>
          </section>
        )}
      </aside>

      <Modal
        open={!!pendingFrom}
        title={t("baqDesigner.graphPickJoinTable")}
        okText={t("common.confirm")}
        cancelText={t("common.cancel")}
        okButtonProps={{ disabled: !pendingTable }}
        onOk={confirmPending}
        onCancel={() => {
          setPendingFrom(null);
          setPendingTable("");
        }}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {t("baqDesigner.graphPickJoinTableHint", {
              alias: pendingFrom ?? "",
            })}
          </Typography.Text>
          <Select
            showSearch
            autoFocus
            optionFilterProp="label"
            style={{ width: "100%" }}
            placeholder={t("baqDesigner.graphAddTable")}
            value={pendingTable || undefined}
            options={pendingOptions}
            onChange={setPendingTable}
          />
        </Space>
      </Modal>
    </div>
  );
}
