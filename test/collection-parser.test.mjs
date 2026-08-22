// 合集两级树解析单测: node test/collection-parser.test.mjs
import { extractInitialState, buildCollectionTree } from '../lib/collection-parser.js';

let passed = 0, failed = 0;
function assert(cond, name, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name, detail ? '— ' + detail : ''); }
}
function eq(actual, expected, name) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), name, `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

console.log('extractInitialState');
{
  const st = makeSeasonState();
  const html = `<html><script>window.__INITIAL_STATE__=${JSON.stringify(st)};(function(){console.log(1)}());</script></html>`;
  const got = extractInitialState(html);
  assert(got && got.videoData.bvid === 'BV1sJwezxEpJ', '提取 JSON 并剥离尾随脚本');
  eq(extractInitialState('<html><body>no state</body></html>'), null, '无状态脚本返回 null');
  eq(extractInitialState('<script>window.__INITIAL_STATE__={bad json,</script>'), null, '坏 JSON 返回 null');
  eq(extractInitialState(''), null, '空串返回 null');
}

console.log('buildCollectionTree ① 合集模式（真实结构裁剪自 BV1sJwezxEpJ）');
{
  const tree = buildCollectionTree(makeSeasonState());
  assert(tree.collectionName === 'ESP32-S3 IDF入门及AIoT项目实战', '合集名取 ugc_season.title');
  eq(tree.groups.length, 4, '跨 section 平铺 + bvid 去重 = 4 组');
  const g0 = tree.groups[0];
  assert(g0.bvid === 'BV1XyGX6KEv8' && g0.aid === 116650858779942, 'g0 标识字段');
  assert(g0.cover === 'http://i1.hdslb.com/a.jpg', 'cover 取 arc.pic');
  assert(g0.partsKnown === true && g0.parts.length === 3, 'g0 按 pages 展开三P');
  eq(g0.parts.map(p => p.p), [1, 2, 3], 'p 序号来自 page 字段');
  eq(g0.parts[1], { p: 2, cid: 38668992828, title: '实战一：TRAE开发环境搭建与配置', duration: 697 }, 'part 字段映射');
  const g1 = tree.groups[1];
  assert(g1.bvid === 'BV1eWG96zEAi' && g1.partsKnown === true && g1.parts.length === 2, '空 pages 经 availableVideoList 回退');
  assert(g1.parts[0].cid === 38668537617 && g1.parts[1].title === '初识ESP32-S3&ESP-IDF开发框架', '回退条目字段正确');
  const g2 = tree.groups[2];
  assert(g2.bvid === 'BV1X52CBREjG' && g2.partsKnown === true && g2.parts.length === 1, '无任何来源降级为单P');
  eq(g2.parts[0], { p: 1, cid: 34590492687, title: '', duration: 0 }, '单P降级 cid 取 episode 自身');
}

console.log('buildCollectionTree ② 单视频多P回退');
{
  const st = { videoData: { aid: 7, bvid: 'BVmulti', cid: 701, title: '多P视频',
    pages: [
      { cid: 701, page: 1, part: '第一集', duration: 100 },
      { cid: 702, page: 2, part: '第二集', duration: 200 },
      { cid: 703, page: 3, part: '第三集', duration: 300 }
    ] } };
  const tree = buildCollectionTree(st);
  assert(tree.collectionName === '多P视频', '合集名取视频标题');
  eq(tree.groups.length, 1, '单一分组');
  assert(tree.groups[0].partsKnown === true && tree.groups[0].parts.length === 3, '三分P全部展开');
}

console.log('buildCollectionTree ③ 单P回退');
{
  const st = { videoData: { aid: 8, bvid: 'BVs', cid: 801, title: '单P视频',
    pages: [{ cid: 801, page: 1, part: '唯一的P', duration: 60 }] } };
  const tree = buildCollectionTree(st);
  eq(tree.groups.length, 1, '单组');
  assert(tree.groups[0].partsKnown === true && tree.groups[0].parts.length === 1, '单P');
  assert(tree.groups[0].parts[0].cid === 801, 'cid 正确');
}

console.log('buildCollectionTree 兜底返回 null');
eq(buildCollectionTree(null), null, 'null state');
eq(buildCollectionTree({}), null, '空 state');
eq(buildCollectionTree({ videoData: {} }), null, '无 bvid/cid');

function makeSeasonState() {
  return {
    videoData: {
      aid: 116249497637244, bvid: 'BV1sJwezxEpJ', cid: 36788832336,
      title: '6. ESP32-S3小智AI机器人项目-桌宠机器狗',
      ugc_season: {
        id: 8218687, title: 'ESP32-S3 IDF入门及AIoT项目实战',
        sections: [
          { id: 9134838, title: '正片', type: 1, episodes: [
            { season_id: 8218687, section_id: 9134838, id: 198339571,
              aid: 116650858779942, cid: 38668928255, bvid: 'BV1XyGX6KEv8',
              title: '1. 用TRAE玩转STM32和ESP32开发',
              arc: { aid: 116650858779942, pic: 'http://i1.hdslb.com/a.jpg' },
              pages: [
                { cid: 38668928255, page: 1, part: '从AI_Agent热潮到开发方式升级', duration: 1136 },
                { cid: 38668992828, page: 2, part: '实战一：TRAE开发环境搭建与配置', duration: 697 },
                { cid: 38668994252, page: 3, part: '实战二_基于TRAE开发STM32F103', duration: 650 }
              ] },
            { season_id: 8218687, section_id: 9134838, id: 198339572,
              aid: 116650758117134, cid: 38668537617, bvid: 'BV1eWG96zEAi',
              title: '2. ESP32-S3 IDF入门开发教程(连载中)',
              arc: { aid: 116650758117134 },
              pages: [] },
            { season_id: 8218687, section_id: 9134838, id: 198301325,
              aid: 115682880590811, cid: 34590492687, bvid: 'BV1X52CBREjG',
              title: '3. ESP32-S3 AI入门项目实战-智能方向指针',
              arc: {} }
          ]},
          { id: 99, title: '花絮', type: 2, episodes: [
            { aid: 999, cid: 888, bvid: 'BVDUP00001', title: '重复项A' },
            { aid: 999, cid: 888, bvid: 'BVDUP00001', title: '重复项B(应去重)' }
          ]}
        ]
      },
      pages: [{ cid: 36788832336, page: 1, part: '如何打造一个属于自己的小智ai聊天机器人', duration: 920 }]
    },
    availableVideoList: [
      { bvid: 'BV1eWG96zEAi', list: [
        { aid: 116650758117134, bvid: 'BV1eWG96zEAi', cid: 38668537617, p: 1, title: 'ESP32-S3课程简介' },
        { aid: 116650758117134, bvid: 'BV1eWG96zEAi', cid: 38668601189, p: 2, title: '初识ESP32-S3&ESP-IDF开发框架' }
      ]}
    ]
  };
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
