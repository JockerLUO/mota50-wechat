/**
 * 把「小游戏包内的文件」内联成一段可直接注入宿主的 JS 源码表 —— 两个驱动脚本共用。
 *
 * ## 为什么需要这个
 *
 * 真机上小游戏读代码包内文件靠的是**同步**接口：
 *   - `wx.getFileSystemManager().readFileSync('data/x.json', 'utf8')`（数据）
 *   - 基础库自己的 CommonJS `require`（js 模块）
 *
 * 而两个本地宿主都活在浏览器里：
 *   - Worker 里**没有**同步 XHR、也没有 fs；
 *   - 页面里能写同步 XHR，但为了一个装载去写它是没必要的复杂度。
 *
 * 于是让驱动脚本的静态服务器**当场生成两张表**，宿主用
 * `importScripts('/__sources.js')` / `<script src="/__data.js">` 一次同步拿到：
 *
 *   self.__motaSources = { "/game.js": "<源码>", "/boot.js": "<源码>" }
 *   self.__motaData    = { "data/tiles.json": "<源码>", "data/floors/floor-01.json": "<源码>" }
 *
 * 这与真机的语义是**等价**的：代码包在上线时就已经在本地了，
 * 运行期读它不需要任何异步动作。表在启动前就绪，正好对应这一点。
 *
 * ## 两张表都是**枚举产物目录**得到的，所以它们不可能与真实文件脱节
 *
 * 这一点比「表里的内容对不对」更重要：
 *   - 表是「包里到底有什么」的事实描述，而不是一份需要人维护的清单；
 *   - 换 chunk 划分（多一个 js）、增删数据文件时，这里**不需要改任何代码**；
 *   - 反过来，产物里缺一个文件时，宿主会拿到一张**没有那一项**的表，
 *     于是报错是「表里没有 /data/xxx.json」，而不是一个含糊的 404。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 转成可以安全塞进 `<script>` / `importScripts` 的赋值语句。
 *
 * U+2028 / U+2029 在 JSON 里合法、在**旧版** JS 字符串字面量里不合法（会真的断行），
 * 转掉最省心 —— 产物里出现这两个字符的概率不为零（注释、字符串里都可能有）。
 */
function inlineAsJs(varName, table) {
  return `self.${varName} = ${JSON.stringify(table)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')};\n`;
}

/**
 * 包内的 js 模块（CJS 装载器用）。
 *
 * key 是**代码包内的绝对路径**（`/game.js`），因为产物的 require 就是按
 * 从包根开始的路径生成的（`require("./boot.js")` → `/boot.js`）。
 */
function collectJsSources(distDir) {
  const table = {};
  for (const f of fs.readdirSync(distDir).filter((x) => x.endsWith('.js')).sort()) {
    table[`/${f}`] = fs.readFileSync(path.join(distDir, f), 'utf8');
  }
  return table;
}

/**
 * 包内的 data/*.json（`getFileSystemManager` 桩用）。
 *
 * key 是**游戏代码里传给 `readFileSync` 的字符串本身**（`data/floors/floor-01.json`）——
 * 桩因此不需要做任何路径变换。这一点是刻意的：路径规则（「从代码包根写起、
 * 不支持 `./` `../` 前缀」，见微信官方「文件系统 → 访问代码包文件」）应当由
 * **游戏代码**承担，桩只负责「照 key 查表，查不到就报错」。
 * 桩要是顺手做了容错（补前缀、去前缀），真机上会炸的写法在本地就永远测不出来。
 */
function collectDataFiles(distDir) {
  const table = {};
  const dataDir = path.join(distDir, 'data');
  if (!fs.existsSync(dataDir)) return table;

  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.name.endsWith('.json')) table[`data/${r}`] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(dataDir, '');
  return table;
}

module.exports = { inlineAsJs, collectJsSources, collectDataFiles };
