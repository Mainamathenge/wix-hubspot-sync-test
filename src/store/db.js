import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

const REDACT = /(pat-[\w-]+|Bearer\s+[\w.-]+|"(?:accessToken|refreshToken|token|secret)"\s*:\s*"[^"]+")/gi;

export function safeLog(...args) {
  const clean = args.map((a) => {
    const str = typeof a === 'string' ? a : JSON.stringify(a);
    return str.replace(REDACT, '[REDACTED]');
  });
  console.log(...clean);
}
