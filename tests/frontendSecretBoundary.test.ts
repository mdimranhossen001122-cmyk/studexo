import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Phase 8B.5B Frontend Secret Boundary Verification', () => {
  it('contains zero references to SUPABASE_SERVICE_ROLE_KEY or server secrets in src/client', () => {
    const clientRoot = path.resolve(process.cwd(), 'src/client');
    const files: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
          files.push(fullPath);
        }
      }
    };

    walk(clientRoot);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
      expect(content).not.toMatch(/SUPABASE_JWT_SECRET/);
      expect(content).not.toMatch(/DATABASE_URL/);
    }
  });
});
