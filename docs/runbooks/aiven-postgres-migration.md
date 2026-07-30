# Aiven PostgreSQL 迁移运行手册

## 目标

保留 Vercel 前端、Functions、Cron 和策略逻辑，只将主数据库从 Neon PostgreSQL 迁移到 Aiven PostgreSQL。迁移采用完整逻辑备份、目标校验和可回滚切换，不修改策略口径。

## 当前阻塞

Neon 当前返回错误：

```text
53000: Your project has exceeded the data transfer quota.
```

在 Neon 临时恢复访问前，无法导出数据库。可以等待额度周期重置，或短暂升级 Neon 完成一次迁移。

## 迁移前准备

1. 在 Aiven 创建 PostgreSQL 服务，目标 PostgreSQL 主版本不低于 Neon。
2. Free 套餐可先验证，但只有 1GB 存储和 20 个连接；长期建议 Developer 8GB。
3. 在本机安装 PostgreSQL 客户端：

```bash
brew install libpq
export PATH="$(brew --prefix libpq)/bin:$PATH"
```

4. 只在本地 `.env` 配置迁移连接串，不要上传 GitHub：

```bash
MIGRATION_TARGET_DATABASE_URL="新 Aiven 连接串"
MIGRATION_TARGET_SSL_CA_BASE64="Aiven 项目 CA 的 base64 内容"
```

从 Aiven 服务 Overview 下载 `ca.pem` 后，可在 macOS 生成单行配置值：

```bash
base64 < ca.pem | tr -d '\n'
```

源库默认复用现有 `DATABASE_URL`。只有需要指定另一个源库时，才设置
`MIGRATION_SOURCE_DATABASE_URL`。

## 执行迁移

先验证两个数据库可访问：

```bash
npm run db:audit
AUDIT_DATABASE_URL="$MIGRATION_TARGET_DATABASE_URL" \
AUDIT_SSL_CA_BASE64="$MIGRATION_TARGET_SSL_CA_BASE64" \
npm run db:audit
```

目标数据库必须是新建且没有业务表的数据库。执行：

```bash
npm run db:migrate:postgres
```

脚本会完成：

1. 检查源库和目标库版本。
2. 拒绝覆盖非空目标库。
3. 使用 `pg_dump` 创建一致性快照。
4. 使用 `pg_restore` 恢复表、索引、约束和序列。
5. 比较所有表的精确行数以及关键表的最新数据日期。

也可以单独复核：

```bash
npm run db:verify:migration
```

## Vercel 切换

在 Vercel Production 和 Preview 环境中设置：

```text
DATABASE_URL=<Aiven connection string>
DB_SSL_CA_BASE64=<Aiven 项目 CA 的 base64 内容>
DB_POOL_MAX=2
DB_CONNECTION_TIMEOUT_MS=10000
DB_IDLE_TIMEOUT_MS=10000
```

重新部署后依次验证：

```bash
curl -fsS 'https://bewin.vercel.app/api/overview'
curl -fsS 'https://bewin.vercel.app/api/daily?date=2026-07-28&source=em&strict=1&strategy=early'
```

确认页面数据后，手动触发或等待下一轮 Cron，并检查 `sync_runs` 中五个任务的状态和最新日期。

## 回滚

迁移后一周内保留 Neon，不删除项目。若线上出现异常：

1. 将 Vercel `DATABASE_URL` 改回 Neon。
2. 重新部署。
3. 确认 `/api/overview` 和 `/api/daily` 恢复。

完成至少五个交易日的自动任务验证后，再停用 Neon。
