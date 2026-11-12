// テストの初めの設定: 爆発事故の「初回の確率」（1日1.0%）は、何日も営業するテストの結果を偶然で変えてしまうので0にする。
// 爆発を確かめるテストは、そのテストの中で確率を決める（出荷の値は JIRO_EXPLOSION_FIRST で確かめる）
import { BALANCE } from '../src';

const X = BALANCE.events.explosion as { firstChancePerDay: number };
process.env.JIRO_EXPLOSION_FIRST = String(X.firstChancePerDay);
X.firstChancePerDay = 0;
