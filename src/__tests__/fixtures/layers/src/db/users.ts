import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Declared first, never called from anywhere: should rank below findUser.
function normalizeId(id: string): string {
  return id.trim();
}

export async function findUser(id: string) {
  return prisma.user.findUnique({ where: { id: normalizeId(id) } });
}
