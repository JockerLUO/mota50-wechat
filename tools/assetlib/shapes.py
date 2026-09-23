"""
手绘形状原语：椭圆、对称块、光束、触手、翼面、鳞片、铆钉、宝石。

怪物与 BOSS 两套画法共用这一层。放在 `pixel.py` 之上、两者的模块之下，
是为了让 `monsters` 与 `bosses` 之间**没有 import 环**：
两边都用原语，但谁也不依赖谁的具体形状。

坐标一律是各自画布上的网格坐标，原语本身不知道自己在画什么。
"""

from __future__ import annotations

import math
from .palette import MON_WHITE
from .pixel import _put



def _ell(im, cx, cy, rx, ry, color):
    """轴对齐实心椭圆（含边）。坐标可为小数，自动夹在画布内 —— 怪物造型的主力原语。

    裁剪边界取 `im.height` 而不是常量 `MON_H` —— BOSS 画在 64 网格上（`BOS_H`），
    写死 32 会让所有 BOSS 在第 32 行被**无声截断**（椭圆下半截消失）。
    32 网格上两者恒等，所以这条改动对旧素材零影响。
    """
    if ry <= 0 or rx <= 0:
        return
    y0 = max(0, int(math.floor(cy - ry)))
    y1 = min(im.height, int(math.ceil(cy + ry)) + 1)
    for y in range(y0, y1):
        dy = (y + 0.5 - cy) / ry
        if abs(dy) >= 1:
            continue
        hw = int(round(rx * math.sqrt(max(0.0, 1 - dy * dy))))
        if hw < 0:
            continue
        x0 = int(round(cx - hw))
        x1 = int(round(cx + hw))
        if x1 < x0:
            continue
        _put(im, x0, y, x1 - x0 + 1, 1, color)




def _sym(im, x, y, w, h, color):
    """
    左右镜像地填两块。

    翅膀、角、耳朵、手臂、腿这些成对结构**只写一次** ——
    手写成对坐标时最容易两边差 1px（棋盘上就是「翅膀一高一低」），
    而且改形状时必然漏掉一半。

    镜像轴取 `im.width` 而不是常量 `MON_W`，理由同 `_ell`：BOSS 画在 64 网格上，
    写死 32 会让右半边画到画布外（无声消失，左边一半孤零零）。
    """
    _put(im, x, y, w, h, color)
    _put(im, im.width - x - w, y, w, h, color)




def _half(im, cx, cy, rx, ry, color, up=True):
    """椭圆的**上半**或**下半** —— 头盔顶、帽檐、下颌、外套膜的底缘都用它。

    为什么不写成「画整圆再拿别的东西盖掉一半」：`add_outline` 只在**整张画布**
    的最外圈描边，两个内部形状之间是没有线的；用别的东西去盖，会把该留下的
    那半边的边界一起吃掉，读出来是「头盔没有下沿」。
    """
    if up:
        ys = range(max(0, int(cy - ry)), int(cy))
    else:
        ys = range(int(cy), min(im.height, int(math.ceil(cy + ry)) + 1))
    for y in ys:
        dy = (y + 0.5 - cy) / ry
        if abs(dy) >= 1:
            continue
        hw = int(round(rx * math.sqrt(max(0.0, 1 - dy * dy))))
        _put(im, int(round(cx - hw)), y, 2 * hw + 1, 1, color)




def _beam(im, x0, y0, x1, y1, thick, color):
    """两点之间一条**粗细均匀**的斜带 —— 角 / 尾 / 手臂 / 法杖的通用原语。

    逐行 `_put` 写斜线必然「一段粗一段细」（行距与列距不成比例），看着像竹节；
    沿参数直线密集采样、每个采样点落一块 `thick×thick`，宽度才是一致的。
    """
    n = max(1, int(max(abs(x1 - x0), abs(y1 - y0))))
    for k in range(n + 1):
        t = k / n
        _put(im, int(round(x0 + (x1 - x0) * t)), int(round(y0 + (y1 - y0) * t)),
             thick, thick, color)




def _bez(p0, p1, bow, t):
    """二次贝塞尔取点。`p0`/`p1` 是端点，`bow` 是控制点相对弦中点的横向偏移。

    存在的理由：腕上的吸盘必须落在**腕自己那条曲线上**。六条腕的弯度各不相同，
    给吸盘手写坐标必然有几颗飘在腕外（1:1 落屏后是「腕旁边有几个紫点」）。
    把它抽出来之后，`_tentacle` 与吸盘共用同一条曲线。
    """
    x0, y0 = p0
    x1, y1 = p1
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    dx, dy = x1 - x0, y1 - y0
    ln = math.hypot(dx, dy) or 1.0
    cx, cy = mx - dy / ln * bow, my + dx / ln * bow
    return ((1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t ** 2 * x1,
            (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t ** 2 * y1)




def _tentacle(im, x0, y0, x1, y1, bow, thick0, c_main, c_tip):
    """一条腕（二次贝塞尔）：粗细由 `thick0` 收到 1，末端 1/4 换 `c_tip` 色。

    `bow` 是控制点相对弦中点的**横向**偏移（正数往右弯）。用参数曲线而不是
    「逐行给一个 x」：六条腕手写坐标必然长短不一、弯度各异，而「六条对称的腕」
    恰恰是乌贼最好认的地方。
    """
    n = max(2, int(math.hypot(x1 - x0, y1 - y0)))
    for k in range(n + 1):
        t = k / n
        x, y = _bez((x0, y0), (x1, y1), bow, t)
        th = max(1, int(round(1 + (thick0 - 1) * (1 - t) ** 0.85)))
        _put(im, int(round(x)) - th // 2, int(round(y)) - th // 2, th, th,
             c_main if t < 0.72 else c_tip)




def _wing_fan(n, top0, bot0, top1, bot1, teeth, tooth):
    """膜翼剖面：n 组 `(顶行, 底行, 是否指骨)`，索引 0 = 肩、n-1 = 翼尖。

    前缘 top0→top1 线性上收、后缘 bot0→bot1 线性上收，再按 `teeth`
    做出「指骨下探 `tooth` 行 / 齿间上凹 `tooth` 行」的锯齿。

    ⚠️ `tooth ≥ 3`。`add_outline` 是 1px 八邻域膨胀，落差 1~2 行的锯齿会被
    描边**直接填平**（等于没画）。这是蝙蝠那两张手写剖面表定下的同一条约束。
    """
    prof = []
    for i in range(n):
        t = i / (n - 1) if n > 1 else 0.0
        top = int(round(top0 + (top1 - top0) * t))
        bot = int(round(bot0 + (bot1 - bot0) * t))
        if i in teeth:
            bot += tooth
        elif (i - 1) in teeth or (i + 1) in teeth:
            bot -= tooth
        prof.append((top, bot, i in teeth))
    return prof




def _wing_draw(im, x_shoulder, cols, c_rib, c_mem, edge=2, mirror=True):
    """按 `_wing_fan` 的剖面画一片翼。`c_rib` 走前缘与指骨、`c_mem` 走膜。

    `mirror=True` 时同时画关于画布中轴的镜像 —— 成对结构只写一次。
    """
    for i, (top, bot, rib) in enumerate(cols):
        x = x_shoulder - i
        for y in range(top, bot + 1):
            col = c_rib if (rib or y < top + edge) else c_mem
            if mirror:
                _sym(im, x, y, 1, 1, col)
            else:
                _put(im, x, y, 1, 1, col)




def _beam_sym(im, x0, y0, x1, y1, thick, color):
    """`_beam` 的**镜像版**：只写左半（或右半），另一半由 `_sym` 出来。

    为什么需要它：`_beam` 内部是 `_put(x, y, …)` 左对齐的，手工算「另一侧该从
    哪个 x 起笔」要写 `im.width - x - thick` —— 这正是 `_sym` 的注释里说的
    「手写成对坐标时最容易两边差 1px」。BOSS 的角 / 手臂 / 腿全是成对的斜带，
    所以补这个原语，而不是每处手算。
    """
    n = max(1, int(max(abs(x1 - x0), abs(y1 - y0))))
    for k in range(n + 1):
        t = k / n
        x = int(round(x0 + (x1 - x0) * t))
        y = int(round(y0 + (y1 - y0) * t))
        _sym(im, x - thick // 2, y - thick // 2, thick, thick, color)




def _scales(im, x0, y0, cols, rows, step, color, mirror=False):
    """错行铺的鳞片/铆钉阵：每行 `cols` 枚、共 `rows` 行，行间横向错开半格。

    这是本轮「增加细节」的主力原语。细节密度的最大杀手是**一整块纯色**
    （一整块纯色 = 每块 1 色）；铺一层错行鳞片就把同一块变成 2~3 色。
    错行（而不是方格阵）是因为方格阵在 1:1 落屏后会读成「网格纸」。
    """
    for r in range(rows):
        off = step // 2 if r % 2 else 0
        for c in range(cols):
            x, y = x0 + c * step + off, y0 + r * step
            if mirror:
                _sym(im, x, y, 2, 1, color)
            else:
                _put(im, x, y, 2, 1, color)




def _rivets(im, x0, y, n, step, color, mirror=False):
    """一排 1px 铆钉/宝石 —— 金饰边缘、甲片接缝用。"""
    for k in range(n):
        x = x0 + k * step
        if mirror:
            _sym(im, x, y, 1, 1, color)
        else:
            _put(im, x, y, 1, 1, color)




def _gem(im, cx, cy, r, color, hi=MON_WHITE):
    """菱形宝石 + 一点高光 —— 胸甲/剑格/额冠上的单点装饰。

    用菱形而不是圆：1:1 落屏后 3~5px 的圆读成一个脏点，菱形的四个尖角还留着，
    在 64 网格上是**唯一能在 4×4 块里同时给出「亮色 + 底色 + 高光」三色的形状**。
    """
    for k in range(-r, r + 1):
        w = r - abs(k)
        _put(im, cx - w, cy + k, 2 * w + 1, 1, color)
    _put(im, cx - 1, cy - r + 1, 2, 1, hi)
