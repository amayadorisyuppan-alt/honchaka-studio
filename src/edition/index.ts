// 標準の版。出し先は Amazon KDP と「その他の印刷所」だけで、ヘルプも書いたとおりに出す。
// 形と、版を差し替えるしくみは ./types.ts と vite.config.ts を参照
import type { Edition } from './types';

export const EDITION: Edition = {
  id: 'public',
  storageSuffix: '',
  printTargets: {},
  helpReplaces: [],
  helpInserts: [],
};
