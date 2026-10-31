# 07 · SQLite → MySQL 升级路径

当前版本用 SQLite（Node 内置 `node:sqlite`，零原生依赖）满足单机、双进程、低并发的场景。当出现以下信号时再升级：

- 需要多实例/多副本（MCP 进程横向扩展）；
- 并发写明显增加（多人同时审批、批量操作）；
- 数据量超过千万行，或需要集中备份/审计查询；
- 需要把 Adsmarch 接入公司既有数据库运维体系。

MySQL 8 的 DDL 已经准备好：[src/db/schema.mysql.sql](../src/db/schema.mysql.sql)，字段名与 SQLite 完全对齐。

## 1. 关键差异

| 维度 | SQLite（现状） | MySQL（目标） |
| --- | --- | --- |
| 驱动 | `node:sqlite` `DatabaseSync` | `mysql2/promise` Pool |
| API | **同步**（`prepare().get()/all()/run()`） | **异步**（`await pool.query()`） |
| 并发 | 单写者 + WAL | 多连接、行锁、事务 |
| 时间 | ISO 字符串 `2026-10-31T...Z` | `DATETIME(3)` |
| JSON | `TEXT`，应用层 `JSON.parse` | `JSON` 列（mysql2 可能自动解析） |
| 自增/ID | 应用生成字符串 ID | 保持应用生成，避免迁移歧义 |
| 布尔 | 0/1 整数 | `TINYINT(1)` |

最大工作量不是建表，而是 **把 76 处同步数据库调用改成异步**。建议一次性做，不做双栈长期共存。

## 2. 迁移分四步

### 第一步：引入数据库抽象层

新建 `src/db/driver.ts`，把“取连接/查询/事务”收敛到一个接口：

```ts
export interface DbDriver {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>;
  execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number }>;
  transaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T>;
}
```

- SQLite 实现：包装现有 `DatabaseSync`，用 `Promise.resolve(...)` 保持签名一致；
- MySQL 实现：`mysql2/promise` 的 `Pool`，`transaction` 用 `getConnection()` + `beginTransaction/commit/rollback`。

`getDb()` 改为 `getDriver()`，由 `ADS_DB_DRIVER=sqlite|mysql` 选择。

### 第二步：迁移服务层

按文件顺序改造（依赖从少到多）：

1. `services/settings.ts`
2. `services/audit.ts`
3. `services/insights.ts`
4. `services/accounts.ts`
5. `services/approvals.ts`
6. `services/oauth.ts`
7. `providers/mock.ts`
8. `server/http.ts`、`server/mcp.ts`、`cli.ts`

改造模式：

```ts
// before (SQLite, sync)
const row = getDb().prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;

// after (driver, async)
const row = await getDriver().one<AccountRow>("SELECT * FROM accounts WHERE id = ?", [id]);
```

注意点：

- **审批原子抢占**必须保留条件更新语义：
  ```sql
  UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = ?
   WHERE id = ? AND status = 'pending'
  ```
  用 `affectedRows === 1` 判断是否抢到，不能用“先查后改”。
- `INSERT ... ON CONFLICT` 改为 MySQL 的 `INSERT ... ON DUPLICATE KEY UPDATE`（`accounts` 的 `UNIQUE(provider, external_id)`、`settings.key`）。
- SQLite 的 `PRAGMA` 全部删除；MySQL 连接池设置 `charset: "utf8mb4"`、`timezone: "Z"`、`decimalNumbers: true`。
- 所有导出函数签名从同步变 `async`，调用方补 `await`（TypeScript 会帮你找全）。

### 第三步：数据搬迁

一次性停机搬迁（推荐，数据量小、逻辑简单）：

```bash
# 1) 停掉 HTTP 进程和 Codex 的 MCP 进程
# 2) 备份 SQLite
sqlite3 data/adsmarch.db ".backup 'backup/adsmarch-final.db'"
# 3) 建 MySQL 库
mysql -u root -p -e "CREATE DATABASE adsmarch CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
mysql -u root -p adsmarch < src/db/schema.mysql.sql
```

写一个一次性脚本 `scripts/migrate-sqlite-to-mysql.ts`：

```ts
import { DatabaseSync } from "node:sqlite";
import mysql from "mysql2/promise";

const sqlite = new DatabaseSync("data/adsmarch.db");
const pool = mysql.createPool({ host, user, password, database: "adsmarch", connectionLimit: 5 });

const TABLES = ["accounts", "oauth_states", "approvals", "audit_logs", "metrics_cache", "settings", "mock_entities"];

for (const table of TABLES) {
  const rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  for (const row of rows) {
    const keys = Object.keys(row);
    await pool.query(
      `INSERT INTO ${table} (${keys.map((k) => `\`${k}\``).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
      keys.map((k) => normalize(table, k, row[k]))
    );
  }
  console.log(`${table}: ${rows.length} rows`);
}
await pool.end();
```

字段归一化规则：

| 类型 | SQLite 值 | MySQL 写入 |
| --- | --- | --- |
| 时间 | `"2026-10-31T08:00:00.000Z"` | `toDate()` → `Date`（列 `DATETIME(3)`，连接时区 `Z`） |
| JSON 文本 | `'{"a":1}'` | `JSON.parse` 后写入（列 `JSON`），或改为写字符串并统一在应用层解析 |
| `daily_budget` | number | number（`DECIMAL(12,2)` + `decimalNumbers: true`） |
| 空字符串 | `""` | 视列可空性转 `null`（尤其 `token_expires_at`、`decided_at`） |

搬迁后校验：

```sql
SELECT COUNT(*) FROM accounts;
SELECT COUNT(*) FROM approvals WHERE status = 'pending';
SELECT COUNT(*) FROM audit_logs;
-- 抽样比对最近 10 条审批与 SQLite 中的 summary/payload
```

- [ ] 各表行数与 SQLite 一致
- [ ] pending 审批数量一致
- [ ] 随机抽样 10 条 `payload` 能正常反序列化
- [ ] `accounts.credentials` 仍可被 `ADS_ENCRYPTION_KEY` 解密

> **密钥必须一起迁移**：`ADS_ENCRYPTION_KEY` 保持不变；换密钥会导致所有 `credentials` 无法解密。

### 第四步：切换与回滚

```bash
# .env
ADS_DB_DRIVER=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=adsmarch
MYSQL_PASSWORD=...
MYSQL_DATABASE=adsmarch
MYSQL_POOL_SIZE=10
```

- [ ] 先切 HTTP 进程验证：`/api/health`、账户列表、审批读写
- [ ] 再重启 Codex，验证 MCP 工具
- [ ] 观察一周：慢查询、锁等待、连接数
- [ ] 保留 SQLite 备份至少 30 天

回滚：把 `ADS_DB_DRIVER` 改回 `sqlite`，恢复切换前的数据库文件（切换后 MySQL 有新写入时，这段数据会丢失，需评估）。

## 3. MySQL 运维建议

- 用户与权限：应用账号只授予 `SELECT/INSERT/UPDATE/DELETE`，DDL 由迁移专用账号执行；
- 索引：`approvals(status, created_at)`、`audit_logs(created_at)`、`metrics_cache(created_at)` 已内置；审计查询多时按 `account_id` 再加复合索引；
- 清理：`metrics_cache` 保留 7 天、`audit_logs` 按公司政策归档（例如 180 天后转冷存储）；
- 连接池：`MYSQL_POOL_SIZE` 默认 10，按实例数 × 并发评估，不要超过数据库 `max_connections` 的 70%；
- 备份：每日全量 + binlog 增量；恢复演练纳入 [06-launch-checklist.md](06-launch-checklist.md)；
- 监控：慢查询（>200ms）、锁等待、连接池耗尽、`approvals` pending 堆积。

## 4. 可选：更彻底的抽象

如果未来还要支持 PostgreSQL 或托管数据库，可在 `driver.ts` 之上再引入 repository 层（`AccountRepository`、`ApprovalRepository`），把 SQL 从服务层移出。对当前业务规模而言，直接替换 driver 已经足够，不必提前抽象。
