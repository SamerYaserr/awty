import type { Db } from 'pg-boss';
import type { EntityManager } from 'typeorm';

export function pgBossDbFor(manager: EntityManager): Db {
  const runner = manager.queryRunner;
  if (!runner) {
    throw new Error(
      'pgBossDbFor needs an EntityManager that belongs to a transaction',
    );
  }
  return {
    async executeSql(text, values) {
      const result = await runner.query(text, values, true);
      return { rows: result.records };
    },
  };
}
