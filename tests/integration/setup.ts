import { execSync } from "node:child_process"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"

declare global {
  // eslint-disable-next-line no-var
  var __pgContainer: StartedPostgreSqlContainer
}

export async function setup() {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start()
  const url = container.getConnectionUri()

  process.env["DATABASE_URL"] = url
  globalThis.__pgContainer = container

  execSync(`npx prisma db push --url "${url}"`, {
    stdio: "pipe",
  })
}

export async function teardown() {
  await globalThis.__pgContainer?.stop()
}
