/**
 * 微信小游戏数据源 —— **运行期**从代码包内读 JSON。
 *
 * ## 为什么能用 `FileSystemManager` 读代码包
 *
 * 微信官方文档「基础能力 / 存储 / 文件系统」里有两句关键的话：
 *
 *   1. 读写权限表 —— **代码包文件：读=有，写=无**。也就是说读代码包内文件
 *      是被明确支持的，不需要任何额外权限。
 *   2. 「访问代码包文件」—— 路径**从项目根目录开始写，不支持相对路径的写法**：
 *      `a/b/c` 合法，`./a/b/c` `../a/b/c` 不合法。
 *
 * 所以这里的路径是 `data/${key}`（key 本身已在 `source.ts` 里约定为
 * 「相对 `data/`、不带任何前缀」）。**不要为了「看起来更像相对路径」给它加 `./`** ——
 * 那会让真机直接读不到，而这个错误在开发者工具里不一定复现。
 *
 * ## 为什么不用 `require('./data/x.json')`
 *
 * 小游戏确实是 CommonJS 模块环境（`module.exports` / `require`），
 * 但官方模块化文档只写了 `require` 加载 **js 模块**。json 能不能 `require`
 * 属于「社区在用、文档没背书」的地带，而且 `require` 的依赖要能被**静态分析**出来 ——
 * 51 个楼层就得逐个写死或生成一份清单文件。
 *
 * `readFileSync` 这条路则两头都对：**文档明确支持**，且路径是运行时拼的、
 * 想加一层楼不用改任何加载代码。
 *
 * ## 这个模块必须是纯叶子
 *
 * 它**不允许 import 本目录之外的任何东西**（只 import `./source` 与 `./types` 的类型），
 * 理由不是洁癖：它会被打进 `game.js` 的最深处，任何对 `env/` 或 `pixi` 的牵连
 * 都可能把这层数据加载排到垫片之前去求值。保持它无副作用、无外部依赖，
 * 求值顺序就不需要任何额外论证。
 */

import type { JsonSource } from './source';

/**
 * 小游戏全局 `wx` 的**最小**声明。
 *
 * 只声明这一个方法，原因见文件头：本模块要保持叶子身份，
 * 不去碰 `src/minigame/env/` 那套完整的 wx 封装（那会引入一条 import 边）。
 *
 * `declare const` 在模块作用域里是**模块级**声明，不会污染全局类型 ——
 * 所以它与 `env/state.ts` 里那份 `wx` 声明不会冲突（各自模块内可见）。
 */
declare const wx: {
  getFileSystemManager(): {
    readFileSync(path: string, encoding: 'utf8'): string;
  };
};

/**
 * 读到的楼层数与索引条数对不上时抛出来的信息里要带上这一句 —— 一眼看出是索引错了还是文件错了。
 */
const FLOOR_MISMATCH_HINT =
  '（楼层索引与楼层文件必须一一对应；小游戏侧是按索引里的 id 拼文件名去读的）';

export const jsonSource: JsonSource = {
  label: '微信小游戏：wx.getFileSystemManager().readFileSync（读代码包内文件，运行期）',

  read<T>(key: string): T {
    let text: string;
    try {
      text = wx.getFileSystemManager().readFileSync(`data/${key}`, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `读不到代码包内的数据文件 data/${key}：${msg}\n` +
          `  → 检查两件事：① 它是否在 src/data/runtime-files.mjs 的清单里；` +
          `② npm run build:minigame 是否把 data/ 拷进了 dist-minigame。` +
          (key.startsWith('floors/') ? FLOOR_MISMATCH_HINT : '')
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`data/${key} 不是合法 JSON：${msg}`);
    }
  }
};

/**
 * ⚠️ 本文件**没有任何模块 import 它** —— 构建时由 `resolve.alias` 把
 * `src/data/index.ts` 里的 `./source` 指向它（网页端则指向 `source-web.ts`）。
 *
 * 所以值得记一句：它仍然会被 `npx tsc --noEmit` 检查（tsconfig 的 `include`
 * 是目录级的），`const jsonSource: JsonSource` 这个注解就是编译期的核对点 ——
 * 两个实现的方法签名一旦漂开，这里立刻报错。
 * 相比之下 **pyflakes 那种「只在被 import 时才检查」的思路在这里不成立**，
 * 这也是当初敢把两个实现并存的原因。
 */
