# ChatBI · 自然语言数据分析

上传 CSV / Excel 表格，**用中文提问**，系统自动把问题翻译成 SQL、查询数据、画出合适的图表，并给出数据解读。

不需要懂 SQL，也不需要拖拽配置图表——**问一句话就能拿到结果**。

---

## 解决什么问题

传统 BI 工具的门槛在于：要看得懂数据，还要会写 SQL 或拖拽配置图表。业务同学想问「哪个地区卖得最好」，往往得排队等数据分析师。

ChatBI 的思路是：**用大模型做翻译层**。把表结构告诉模型，让它生成 SQL，程序执行后把结果和图表直接呈现出来。

---

## 功能特性

| 特性 | 说明 |
|---|---|
| 📄 多格式导入 | CSV / TXT / XLSX，拖拽上传，自动建表 |
| 🔎 智能类型推断 | 自动识别 INTEGER / REAL / TEXT；前导 0 编码与大整数**保留为文本**避免精度丢失 |
| 🧠 NL2SQL | 把自然语言翻译成 SQL，schema + 样本数据一起注入提示词 |
| 🛡️ 双层 SQL 防护 | SQL 白名单校验 + **数据库只读连接**，双保险防止写操作 |
| 🔧 执行失败自愈 | SQL 报错时把错误回传模型自动修正重试 |
| 📊 图表自动推荐 | 模型同时输出图表类型与字段映射；字段对不上时自动降级为表格 |
| 💬 流式全过程 | SSE 逐步推送「生成 SQL → 查询 → 解读」，过程可见 |
| 🚫 抗幻觉 | 问题超出数据范围时明确说明原因，而不是硬编一个 SQL |

---

## 技术栈

**前端**：Vue 3 + Vite + **ECharts**（按需引入 + 独立分包）

**后端**：Node.js + Express + **`node:sqlite`**（Node 内置，零第三方依赖）

**解析**：自研 CSV 状态机解析器 + `exceljs`（Excel）

**模型**：DeepSeek API（JSON 模式）

---

## 架构与数据流

### 导入链路

```
上传文件
   ↓
解析为二维表          csv.js / xlsx.js
   ↓
列名规整 + 类型推断    normalizeHeader / inferType
   ↓
建表并批量插入         db.js（事务包裹）
   ↓
SQLite 文件持久化      server/data/chatbi.db
```

### 问答链路

```
用户提问
   ↓
提取 schema（表结构 + 样例行）   db.js
   ↓
NL2SQL：模型生成 SQL + 图表配置   nl2sql.js
   ↓
SQL 安全校验（白名单）            sqlGuard.js   ← 第一层防护
   ↓
只读连接执行                     db.js         ← 第二层防护
   ↓（失败则回传报错让模型自愈，最多重试 2 次）
图表配置校验与降级               normalizeChart
   ↓
流式生成自然语言解读             llm.js
   ↓
前端渲染：SQL + 图表 + 表格 + 解读
```

---

## 快速开始

### 环境要求

- **Node.js ≥ 22**（`node:sqlite` 需要 Node 22+；本项目在 v24 上开发验证）

### 1. 安装依赖

```bash
cd server && npm install
cd ../web && npm install
```

### 2. 配置 API Key

在 `server/` 下创建 `.env`：

```ini
DEEPSEEK_API_KEY=sk-your-key-here
PORT=3002
CHAT_MODEL=deepseek-chat
```

### 3. 启动

```bash
# 终端 1
cd server && npm start

# 终端 2
cd web && npm run dev
```

打开 **http://localhost:5174**

### 4. 验证一下

上传 `samples/销售数据.csv`，然后依次问：

- 「各地区的销售额合计是多少？」→ 柱状图，按地区分组求和
- 「销售额最高的前 3 个产品类别」→ 柱状图，Top-3
- 「每个月的销售额趋势如何？」→ **折线图**（模型会用 `strftime` 按月份聚合）
- 「数据里有没有员工年龄？」→ 应明确回答**没有该字段**，而不是编一个

再上传 `samples/门店业绩.xlsx`，问「各门店的开业日期」验证 Excel 与日期解析。

---

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 + 统计 |
| GET | `/api/datasets` | 数据集列表 |
| POST | `/api/upload` | 上传表格（`multipart/form-data`，字段名 `files`，最多 10 个） |
| DELETE | `/api/datasets/:id` | 删除数据集（含数据表） |
| DELETE | `/api/datasets` | 清空全部 |
| POST | `/api/ask` | 提问，**SSE 流式**返回 |

### `/api/ask` 事件协议

请求：`{ "question": "各地区的销售额合计？", "history": [] }`

响应（`text/event-stream`）：

```
event: stage
data: {"stage":"generating_sql","message":"正在理解问题并生成 SQL…"}

event: sql
data: {"sql":"SELECT ...","reasoning":"...","attempts":1,"warnings":[]}

event: result
data: {"columns":["地区","销售额合计"],"rows":[{"地区":"华东","销售额合计":934130}],"truncated":false}

event: chart
data: {"type":"bar","x":"地区","y":["销售额合计"],"title":"各地区销售额合计"}

event: stage
data: {"stage":"insight","message":"正在解读结果…"}

event: insight
data: "华东地区销售额合计最高…"

event: done
data: {"ok":true}
```

无法回答时返回 `event: unanswerable`（附原因），出错返回 `event: error`。

---

## 关键设计说明

### 1. SQL 安全为什么要做两层

让大模型直接生成 SQL 并执行，是这个项目最大的风险点——**一句 `DROP TABLE` 就能把数据删了**。

- **第一层：提示词约束**。系统提示词明确禁止写操作。实测有效：问「帮我把所有数据都删掉」，模型会回答「这属于写操作，违反只能生成 SELECT 的规则」而拒绝生成。
- **第二层：SQL 白名单校验**（`sqlGuard.js`）。只允许单条 `SELECT` / `WITH`，拦截 `INSERT/UPDATE/DELETE/DROP/ALTER/PRAGMA/ATTACH` 等关键字，禁止 `load_extension` 等危险函数，并自动补 `LIMIT` 防止全表返回。
- **第三层：数据库只读连接**。执行查询用 `new DatabaseSync(path, { readOnly: true })`，即使前两层被绕过，SQLite 自己也会拒绝写入：

```
> INSERT INTO t VALUES (1)
错误：attempt to write a readonly database
```

**校验的关键细节**：判断前先剥离 SQL 注释和字符串字面量。否则会走向两个错误极端——不剥离则数据里含 `"DROP"` 的字符串会误报；只看原文则把关键字藏进注释就能绕过。测试用例覆盖了这两种情况。

**测试中发现的一个真实缺口**：写自愈机制的验证用例时，模型为了确认列名，主动生成了

```sql
SELECT name FROM pragma_table_info('ds_b263329c44')
```

而这条 SQL **通过了校验**——因为 `pragma_table_info` 是「表值函数」而不是 `PRAGMA` 语句，关键字黑名单拦不住它。虽然这类函数只读元数据、危害有限，但它泄露了表结构信息，属于设计外的行为。现已补上 `pragma_*` 的拦截规则并加入回归测试。

> 这件事的启示：**白名单校验最容易漏的，正是那些「语法形态和你预期不同」的等价写法**。靠枚举关键字很难穷尽，所以第二层（数据库只读连接）才是真正的兜底。

### 2. 为什么用执行失败自愈

模型生成的 SQL 经常有列名写错、函数用错这类小毛病。**直接把报错回传给模型让它修正，比重新生成一次有效得多**——它已经知道错在哪了。

实测中「尝试 1 次」是常态，自愈机制是兜底。前端会显示「已自动修正 N 次」，让这个过程可见。

**这段逻辑怎么测**：依赖真实模型是不行的——它每次输出都不同，测试会变成碰运气。所以 `ask()` 接受一个可注入的 `generateSql` 生成器参数，测试里注入一个「第一次故意写错、第二次修正」的假生成器，就能**确定性**地验证整条链路：模型被调用 2 次、`attempts === 2`、且第二次调用时确实收到了 SQLite 的原始报错。

### 3. 为什么安全拦截不重试，执行失败才重试

两者的处理**故意不同**：

- **执行失败** → 重试（列名拼错是能力问题，给它改正机会）
- **安全校验失败** → 直接终止（试图生成写操作是边界问题，再给一次机会等于给它一次绕过限制的机会）

安全问题应该「失败即终止」，而不是「失败即重试」。

### 4. 图表为什么要做降级

模型经常会给出与真实结果集对不上的图表配置：编造列名、对单行结果硬画饼图、类别过多还坚持画饼图。

`normalizeChart` 会校验并降级：

| 情况 | 处理 |
|---|---|
| x / y 列名不在结果集中 | 降级为表格 |
| 结果只有 1 行 | 降级为表格（单点画图无意义） |
| 饼图类别 > 12 | 改成柱状图（否则糊成一团） |

**宁可少画一张图，也不要画一张错图或空白图。**实测问「哪个销售员业绩最好」，结果只有 1 行，图表被正确降级成表格。

### 5. CSV 为什么要自己写解析器

`line.split(',')` 在真实数据上会直接失效——CSV 标准允许字段被双引号包裹，引号内可以出现**逗号、换行**，以及用 `""` 转义的双引号。比如地址 `"重庆市,渝北区"` 会被拆成两列，导致整行错位。

所以用**状态机**逐字符解析，正确处理：引号内的逗号/换行、`""` 转义、CRLF 与 LF、文件 BOM、末尾无换行。共 19 项测试覆盖这些边界。

---

## 已知限制与后续优化

- **只导入第一个工作表**：多 sheet 的 Excel 只取第一个非空表，可扩展为全部导入。
- **同步阻塞**：`node:sqlite` 是同步 API，超大文件导入时会阻塞事件循环，应改为 worker 线程。
- **无鉴权**：API 完全开放，公网部署前必须加认证与限流，否则会被刷 API 额度。
- **单轮 schema 注入**：表很多时提示词会变长，可改为先让模型选表再取详细结构。
- **NL2SQL 准确率无量化评估**：应建立问题-SQL 测试集，统计执行准确率（EX 指标）。
- **无查询缓存**：相同问题会重复调用模型，可加结果缓存。

---

## 目录结构

```
chatbi/
├── server/
│   ├── src/
│   │   ├── index.js      Express 入口 + SSE
│   │   ├── config.js     配置
│   │   ├── csv.js        CSV 状态机解析 + 类型推断
│   │   ├── xlsx.js       Excel 解析（含日期时区处理）
│   │   ├── db.js         SQLite 管理（导入 / schema / 只读查询）
│   │   ├── sqlGuard.js   SQL 安全校验                      ← 安全关键
│   │   ├── nl2sql.js     NL2SQL + 自愈重试 + 图表降级
│   │   ├── llm.js        DeepSeek 调用 + JSON 容错解析
│   │   └── scripts/      测试脚本（csv / sqlguard / retry）
│   └── data/            SQLite 数据库（已 gitignore）
├── web/
│   └── src/
│       ├── api.js        接口封装 + SSE 解析
│       ├── App.vue       布局
│       └── components/
│           ├── DatasetPanel.vue   数据集管理
│           ├── ChatPanel.vue      对话
│           ├── ChatMessage.vue    单条消息
│           └── ResultView.vue     SQL + ECharts + 表格 + 解读
└── samples/              示例数据集
```

---

## License

MIT
