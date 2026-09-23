/**
 * 产物装载器 —— 按**微信小游戏的模块规则**把代码包里的多个 js 装起来。
 *
 * 两个宿主（无 DOM 的 Worker / 有 DOM 的页面）共用这一份。
 *
 * ## 为什么不直接 `<script src>` / `importScripts('/game.js')`
 *
 * 产物从「单文件 IIFE」变成了 CJS 多文件：`game.js` 开头就是
 * `const boot = require("./boot.js")`。而 `<script>` 与 `importScripts` 都只有
 * **一个全局作用域** —— 直接装载会有两个后果：
 *
 *   1. `require` 不存在（产物里 `boot` 拿不到），第二行就炸；
 *   2. 就算塞一个全局 `require` 进去，模块里的 `var Intl` / `var document`
 *      （PRELUDE）会变成**全局变量** —— 而本测试的前提恰恰是
 *      「宿主本来没有 `document`」。那等于自己把被测条件破坏了。
 *
 * 用一个模块包装函数把每个文件的 `var` 关在自己的作用域里，
 * 既贴合小游戏的真实语义（官方「模块化」文档：*在 JavaScript 文件中声明的
 * 变量和函数只在该文件中有效*），也保住了「宿主无 DOM」这个前提。
 *
 * ## 源码从哪来
 *
 * `self.__motaSources` —— 一个 `{ "/game.js": "<源码>", "/boot.js": "<源码>" }` 的表，
 * 由宿主的 `<script src="/__sources.js">` / `importScripts('/__sources.js')`
 * **同步**注入（那张表是驱动脚本的静态服务器当场生成的，枚举产物目录里的 js）。
 *
 * 为什么要绕这一道：`require` 是**同步**调用，而 Worker 里没有同步 fetch、
 * 页面里也不该为一个装载去写 sync XHR。让服务器生成一份源码表，
 * 是唯一「同步、且不依赖任何宿主能力」的办法。
 *
 * 顺带的好处：这张表就是**包内有哪几个 js 的清单**，
 * 装载一个不存在的文件会当场报出「表里有什么」，而不是一个空的 404。
 *
 * ## 为什么用 `eval` 而不是 `new Function`
 *
 * ⚠️ 因为**在这一步之前，`no-unsafe-eval.js` 已经把 `globalThis.Function` 换掉了**
 *（`new Function(...)` 会抛 EvalError —— 那是模拟微信子上下文的 CSP，
 * 用来验 pixi 有没有真的走 `pixi.js/unsafe-eval`）。
 * 装载器要是用 `new Function`，就会跟被测环境自己打起来。
 *
 * `eval` 不受那条禁令影响（禁令只换 `Function` 这一个绑定），
 * 而下面用的是**直接 eval**：包在一个 `'use strict'` 的 IIFE 里，
 * 于是它是严格 eval —— 求值出的函数表达式不会往外泄漏任何变量，
 * 正是「一个文件一个作用域」想要的效果。
 */
(function () {
  'use strict';

  /** 由 `/__sources.js` 注入的源码表；没有它时给个空对象，让报错落在「文件不在表里」而不是 `undefined` 上。 */
  var sources = (self && self.__motaSources) || {};
  /** 已装载过的模块（小游戏里 require 同一个文件拿到的是同一份 exports） */
  var cache = Object.create(null);

  function dirOf(url) {
    var i = url.lastIndexOf('/');
    return i < 0 ? '' : url.slice(0, i);
  }

  /** 把 `./boot.js` 相对 `from` 解析成根的绝对路径（`/boot.js`） */
  function resolve(spec, from) {
    if (spec.charAt(0) !== '.') return spec;
    var base = dirOf(from).split('/');
    for (const part of spec.split('/')) {
      if (part === '.' || part === '') continue;
      if (part === '..') base.pop();
      else base.push(part);
    }
    return base.join('/');
  }

  function load(url) {
    if (cache[url]) return cache[url].exports;

    var src = sources[url];
    if (typeof src !== 'string') {
      throw new Error(
        '[harness] 代码包里没有 ' + url + '。' +
          '（/__sources.js 只提供了：' + Object.keys(sources).join(', ') + '）'
      );
    }

    var mod = { exports: {} };
    cache[url] = mod;

    const factory = eval(
      '(function (module, exports, require, __filename, __dirname) {\n' + src + '\n})'
    );
    factory(mod, mod.exports, function (spec) {
      return load(resolve(spec, url));
    }, url, dirOf(url));

    return mod.exports;
  }

  self.__motaLoadCjs = load;
  self.__motaCjsLoaded = function () {
    return Object.keys(cache);
  };
})();
