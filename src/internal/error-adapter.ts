// Detects if Prisma ships native typed errors; falls back to our own impl.
// Single file to update when Prisma merges typed errors natively.
export {
  PrismaBridgeError,
  PrismaForeignKeyError,
  PrismaNotFoundError,
  PrismaRelationViolationError,
  PrismaUniqueConstraintError,
} from "../adapters/prisma/errors.js"
