"""
Pillow 的唯一入口 —— 顺便把「缺 Pillow」这件事变成一句人话。

放在这里而不是每个模块各写一遍 try/except，是为了保证**无论先 import 哪个模块**，
用户看到的都是同一句可操作的提示，而不是一句
`ModuleNotFoundError: No module named 'PIL'`。

⚠️ 走虚拟环境时别忘了把解释器路径传进去，否则 npm 脚本会静默退回系统 python3：
    PYTHON=<venv>/bin/python npm run assets
"""

import sys

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:  # pragma: no cover
    sys.exit(
        "需要 Pillow：\n"
        f"  {sys.executable} -m pip install pillow\n"
        "若用虚拟环境，请把该解释器路径传给 npm：PYTHON=<venv>/bin/python npm run assets"
    )

# 这三个名字是**转发**出去的（各绘制模块 `from .pil import Image, ...`），
# 在本模块里确实「没被用到」。写进 __all__ 既表达了这个意图，
# 也让静态检查知道它们不是漏删的导入。
__all__ = ["Image", "ImageDraw", "ImageFilter"]
