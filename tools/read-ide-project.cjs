#!/usr/bin/env node
/**
 * 读微信开发者工具里**这个工程被当成什么类型**——以及真机调试/预览的状态。
 *
 * ```bash
 * node tools/read-ide-project.cjs                       # 当前仓库的 dist-minigame
 * node tools/read-ide-project.cjs --path=<工程目录>      # 指定别的工程
 * node tools/read-ide-project.cjs --all                 # 列出 IDE 里所有工程
 * node tools/read-ide-project.cjs --raw                 # 打印原始记录
 * ```
 *
 * ## 为什么需要它（这一类故障的完整链条）
 *
 * 症状是「真机调试报 `ENOENT: no such file or directory, open '<工程根>/app.json'`」，
 * 但**这不是工程文件的问题** —— 小游戏根本不该有 `app.json`，报它找不到才是对的。
 * 真正的问题在工具侧：**它把工程当成了小程序**。链条是这样的（全部由反解
 * `/Applications/wechatwebdevtools.app/Contents/Resources/app.asar` 得到）：
 *
 * 1) `DevtoolsProject` 构造函数：
 *
 *      c = { weapp:"miniProgram", plugin:"miniProgramPlugin",
 *            game:"miniGame", gamePlugin:"miniGamePlugin" };
 *      this._type = c[e.compileType];      // ← 直接查表，没有兜底
 *
 * 2) 打包器判类型：
 *
 *      function isGameApp(e) { return e.type === EProjectType.miniGame || ... }
 *      ...
 *      const J = isGameApp(n), O = J ? "game.json" : "app.json";
 *      let T = await IFileService.readFile(join(L, O), { encoding:"utf8" });  // ← 无 try/catch
 *
 * 所以只要 `compileType` **缺失或不在那张表里**（例如 `undefined`、`""`、
 * 或拼错的 `minigame`），第一步就得到 `_type = undefined`，第二步判定「不是小游戏」，
 * 于是去读 `app.json`；文件当然不存在，而这里没有 try/catch，
 * **Node 的原始 ENOENT 直接冒到界面上** —— 这就是那条报文。
 * 注意它与编译器给的友好提示（`app.json: 在项目根目录未找到 app.json`）**不是同一条路径**：
 * 后者来自小程序编译管线，说明工具「确信」这是小程序；前者只是某个环节没拿到类型。
 *
 * 结论：**工程侧唯一要做对的事，就是让 `compileType` 有那个合法值。**
 * （`compileTypeConfig={weapp:"weapp",game:"game",plugin:"plugin",gamePlugin:"gamePlugin"}`，
 * 小游戏写 `"game"`。）剩下的一律是工具侧状态问题，本脚本负责把它读出来。
 *
 * ## 读的时候要注意的两件事
 *
 * 1. **`compileType` 有两个来源，会打架**：`reduxPersist:projectList`（导入时的意图）
 *    与 `project2_<绝对路径>`（实际生效的那份）。本脚本两个都打印，不一致就是线索。
 * 2. **`reduxPersist:toolbar` / `reduxPersist:window` 是窗口层状态**，与工程记录**可以不一致**。
 *    实测撞到过：工程记录明明是 `game`，而工具栏 `compileType.current` 是 `weapp`、
 *    入口窗口 `entrance.tab` 是 `miniprogram` —— 这时候工具的部分环节就会按小程序走。
 *    遇到这种不一致，修法是**清缓存 + 重开/重导工程**（见 docs/wechat-minigame.md §8），
 *    改工程文件是没用的。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const IDE_ROOT = path.join(os.homedir(), 'Library', 'Application Support', '微信开发者工具');

/** DevTools 内部的类型表 —— 与 asar 里那份逐字一致，判「合法值」就靠它。 */
const COMPILE_TYPE_TO_PROJECT_TYPE = {
  weapp: 'miniProgram',
  plugin: 'miniProgramPlugin',
  game: 'miniGame',
  gamePlugin: 'miniGamePlugin'
};

/** 小游戏的那两个（`isGameApp` 只认它们）。 */
const GAME_TYPES = ['miniGame', 'miniGamePlugin'];

function findLocalDataDirs() {
  const out = [];
  let hashes = [];
  try {
    hashes = fs.readdirSync(IDE_ROOT);
  } catch {
    return out;
  }
  for (const h of hashes) {
    const dir = path.join(IDE_ROOT, h, 'WeappLocalData');
    try {
      if (fs.statSync(dir).isDirectory()) out.push({ hash: h, dir });
    } catch {
      /* 不是工程数据目录 */
    }
  }
  return out;
}

/** hash_key_map_2.json 把「文件名的哈希」映射回 redux 里的键名。 */
function loadKeyMap(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'hash_key_map_2.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 按 redux 键名取回真值。
 *
 * 两个容易写错的地方（第一版都踩了）：
 *   - **文件名是 `localstorage_<hash>.json`**，而 `hash_key_map_2.json` 里的键**不带**前缀；
 *   - **文件内容就是那个值本身**（键名不在文件里），且有两种形态：
 *     直接是对象（如 `project2_<路径>` 的记录），或被包成 `{ "0": <值> }`（数组式序列化）。
 *     单个字段的值还可能被包成 `{ data: <值> }`。
 */
function readByKey(dir, keyMap, key) {
  const hit = Object.entries(keyMap).find(([, v]) => v === key);
  if (!hit) return undefined;
  let v;
  try {
    v = JSON.parse(fs.readFileSync(path.join(dir, `localstorage_${hit[0]}.json`), 'utf8'));
  } catch {
    return undefined;
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '0') v = v['0'];
    else if (keys.length === 1 && keys[0] === 'data') v = v['data'];
  }
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/** 字段级解包装（`{data: X}` → `X`），工程记录里的字段会这样存。 */
function field(rec, k) {
  if (!rec || typeof rec !== 'object') return undefined;
  let v = rec[k];
  if (v && typeof v === 'object' && 'data' in v) v = v.data;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

function fmtTime(ms) {
  if (typeof ms !== 'number' || !ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

/** 工程目录里「决定性文件」的在位情况 —— `isSuspectedProject` 就是按这个顺序判的。 */
function inspectProjectDir(dir) {
  const has = (f) => {
    try {
      return fs.existsSync(path.join(dir, f));
    } catch {
      return false;
    }
  };
  const readJson = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      return null;
    }
  };
  return {
    exists: has('.'),
    appJson: has('app.json'),
    gameJson: has('game.json'),
    projectConfig: readJson('project.config.json')
  };
}

function printProjectRecord(label, rec) {
  console.log(`  ${label}`);
  if (!rec || typeof rec !== 'object') {
    console.log('    （没有记录）');
    return null;
  }
  const ct = field(rec, 'compileType');
  const derived = COMPILE_TYPE_TO_PROJECT_TYPE[ct];
  const isGame = GAME_TYPES.includes(derived);
  console.log(`    compileType        = ${JSON.stringify(ct)}`);
  console.log(
    `    → 工具内部 type    = ${derived === undefined ? 'undefined  ⛔ 不在表里！' : derived}` +
      (derived === undefined ? '' : isGame ? '  ✅ 小游戏' : '  ⚠️ 非小游戏')
  );
  console.log(`    appid              = ${JSON.stringify(field(rec, 'appid'))}`);
  const arch = field(rec, 'projectArchitecture');
  if (arch) console.log(`    projectArchitecture= ${arch}`);
  const sim = field(rec, 'simulatorType');
  if (sim) console.log(`    simulatorType      = ${sim}`);
  const at = field(rec, 'accessTime');
  if (at) console.log(`    accessTime         = ${fmtTime(at)}`);
  const attr = field(rec, 'attr') || {};
  if ('gameApp' in attr) {
    console.log(
      `    attr.gameApp       = ${attr.gameApp}${attr.gameApp ? '  ✅ 平台认定是小游戏' : '  ⛔ 平台认定不是小游戏'}` +
        (attr.appName ? `   （${attr.appName}）` : '')
    );
    if ('isSandbox' in attr) console.log(`    attr.isSandbox     = ${attr.isSandbox}`);
    if ('appType' in attr) console.log(`    attr.appType       = ${attr.appType}  （4 = GAME）`);
  }
  return { compileType: ct, derived, isGame };
}

function main() {
  const args = process.argv.slice(2);
  const showRaw = args.includes('--raw');
  const showAll = args.includes('--all');
  const pathArg = args.find((a) => a.startsWith('--path='));
  const targetPath = pathArg
    ? path.resolve(pathArg.slice('--path='.length))
    : path.resolve('dist-minigame');

  const dirs = findLocalDataDirs();
  if (!dirs.length) {
    console.error(`没找到 IDE 数据目录：${IDE_ROOT}/*/WeappLocalData`);
    process.exit(1);
  }

  let problems = 0;
  for (const { hash, dir } of dirs) {
    const keyMap = loadKeyMap(dir);
    if (!keyMap) continue;
    const projectList = readByKey(dir, keyMap, 'reduxPersist:projectList');
    const toolbar = readByKey(dir, keyMap, 'reduxPersist:toolbar');
    const windowState = readByKey(dir, keyMap, 'reduxPersist:window');
    const projectKeys = Object.entries(keyMap).filter(([, v]) => v.startsWith('project2_'));
    if (!projectKeys.length && !showAll) continue;

    console.log('═'.repeat(96));
    console.log(`IDE 数据目录：${dir}`);
    console.log(`（项目 hash ${hash}）`);

    if (showRaw) {
      console.log('\n--- reduxPersist:projectList ---');
      console.log(JSON.stringify(projectList, null, 1));
      console.log('\n--- reduxPersist:toolbar ---');
      console.log(JSON.stringify(toolbar, null, 1));
      console.log('\n--- reduxPersist:window ---');
      console.log(JSON.stringify(windowState, null, 1));
      continue;
    }

    // ── 1) 所有工程的 compileType 一览 ──────────────────────────────
    console.log('\n── 工程记录（project2_<路径>）──');
    if (!projectKeys.length) console.log('  （没有工程记录）');
    for (const [file, key] of projectKeys) {
      const p = key.slice('project2_'.length);
      if (!showAll && p !== targetPath) {
        console.log(`  · ${p}   （不是目标工程，用 --all 也看）`);
        continue;
      }
      console.log(`  · ${p}`);
      if (showAll || p === targetPath) {
        const rec = readByKey(dir, keyMap, key);
        const verdict = printProjectRecord('记录：', rec);
        if (verdict && verdict.compileType !== undefined && !verdict.isGame) problems++;
        // 顺带核一遍导入时的那份意图（两个来源可能打架）
        if (projectList && typeof projectList === 'object') {
          const pl = projectList[p];
          const plCt = field(pl, 'compileType');
          if (plCt !== undefined) {
            console.log(`    projectList 里的意图 compileType = ${JSON.stringify(plCt)}`);
            if (plCt !== field(rec, 'compileType')) {
              console.log('      ⚠️ 与工程记录不一致 —— 以工程记录为准，但这是「重导过」的痕迹');
            }
          }
        }
        // 磁盘上的实际情况
        const disk = inspectProjectDir(p);
        if (!disk.exists) {
          console.log('    ⛔ 目录不存在（工程被删了或路径变了）');
          problems++;
        } else {
          console.log(`    磁盘：app.json=${disk.appJson}  game.json=${disk.gameJson}`);
          if (disk.appJson && disk.gameJson) {
            console.log('      ⛔ 两个都在！`isSuspectedProject` 先查 app.json → 会被判成小程序。删掉 app.json。');
            problems++;
          }
          if (!disk.gameJson) {
            console.log('      ⛔ 没有 game.json —— 小游戏工程根必须有它');
            problems++;
          }
          const cfgCt = disk.projectConfig && disk.projectConfig.compileType;
          const cfgAppid = disk.projectConfig && disk.projectConfig.appid;
          console.log(
            `    project.config.json：compileType=${JSON.stringify(cfgCt)}  appid=${JSON.stringify(cfgAppid)}`
          );
          if (cfgCt !== undefined && !(cfgCt in COMPILE_TYPE_TO_PROJECT_TYPE)) {
            console.log(
              `      ⛔ 非法值。合法值只有 ${Object.keys(COMPILE_TYPE_TO_PROJECT_TYPE).join(' / ')}；` +
                '小游戏写 "game"。'
            );
            problems++;
          }
          if (targetPath === p && cfgAppid !== field(rec, 'appid')) {
            console.log(
              `      ⚠️ 与工程记录里的 appid 不一致（记录=${field(rec, 'appid')}）——` +
                '工具以记录为准；改文件后要在 IDE 里重导才生效'
            );
          }
        }
      }
    }

    // ── 2) 窗口层状态（与工程记录可以不一致，这是「改文件没用」的原因）──
    console.log('\n── 窗口层状态（reduxPersist:toolbar / window）──');
    if (toolbar) {
      const ct = toolbar.compileType;
      const cur = ct && typeof ct === 'object' ? ct.current : ct;
      console.log(`  工具栏 compileType.current = ${JSON.stringify(cur)}`);
      if (cur !== undefined && cur !== 'game') {
        console.log(
          '    ⚠️ 工具栏不是「小游戏」。工程记录对但这里不对 ⇒ 部分环节会按小程序走，' +
            '真机调试就可能去读 app.json。修法：清缓存 + 重开/重导工程。'
        );
        problems++;
      }
      if (toolbar.miniapp) console.log(`  miniapp = ${JSON.stringify(toolbar.miniapp)}`);
    }
    if (windowState) {
      const pc = windowState.previewComponent;
      if (pc) {
        console.log('  预览/真机调试：');
        console.log(`    uploadType              = ${JSON.stringify(pc.uploadType)}  （remoteDebug = 真机调试）`);
        console.log(`    origin                  = ${JSON.stringify(pc.origin)}`);
        console.log(`    uploadStatus            = ${JSON.stringify(pc.uploadStatus)}`);
        console.log(`    autoUploadFailureText   = ${JSON.stringify(pc.autoUploadFailureText)}`);
      }
      const rd = windowState.remoteDebugWindow;
      if (rd) {
        console.log(
          `  远程调试窗口：show=${rd.show}  debuggingProjectId=${JSON.stringify(
            rd.debuggingProjectId
          )}  fallbackFailReason=${JSON.stringify(rd.fallbackFailReason)}`
        );
        if (pc && pc.uploadType === 'remoteDebug' && !rd.show) {
          console.log('    ⚠️ 点了真机调试但远程调试窗口没起来 —— 看下面的通知里「上传代码完成」是否出现：');
        }
      }
      const ent = windowState.entrance;
      if (ent) console.log(`  入口窗口 tab = ${JSON.stringify(ent.tab)}  （小游戏应为 "minigame"）`);
      const spo = windowState.selectProjectOptions;
      if (spo) console.log(`  选择工程 tab = ${JSON.stringify(spo.tab)}`);
      const mask = windowState.mask;
      if (mask && mask.show) console.log(`  ⛔ 有一个模态挡着：${JSON.stringify(mask)}`);
      const notice = windowState.notice;
      if (notice && Array.isArray(notice.list)) {
        console.log('  通知中心（能判断上传到底成没成）：');
        for (const n of notice.list.slice(-6)) {
          console.log(
            `    · [${n.type || '?'}] ${n.name}` +
              (n.details ? `  ${JSON.stringify(n.details)}` : '') +
              (n.time ? `  ${fmtTime(n.time)}` : '')
          );
        }
      }
    }
  }

  console.log('\n' + '═'.repeat(96));
  if (problems) {
    console.log(`发现 ${problems} 处可疑项（见上面的 ⛔/⚠️）。`);
    console.log('工程侧只该保证 compileType 合法（小游戏 = "game"）；其余都是工具侧状态，');
    console.log('修法是 docs/wechat-minigame.md §8 里的「清缓存 + 重开/重导工程」。');
  } else {
    console.log('工程侧没发现可疑项：compileType 合法、game.json 在位、没有多余的 app.json、');
    console.log('窗口层也不是小程序。若真机调试仍失败，问题在设备连接或工具自身，');
    console.log('看通知中心与 WeappLog 里的 `game-ios-debug` / `Device disconnected` 行。');
  }
}

main();
