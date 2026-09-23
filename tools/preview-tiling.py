"""铺贴预览：把「只用底图」与「按哈希取变体」并排画出来，肉眼判重复感是否被打散。

这个脚本是**判据的一部分**，不是装饰：重复感是纯视觉问题，任何断言都替代不了
「铺满一屏再看一眼」。哈希函数与 src/render/board/index.ts 里的实现必须逐位一致，
否则预览好看而游戏里不是那样。
"""
from PIL import Image, ImageDraw
import json, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
M = 0xFFFFFFFF


def _imul(a, b):
    return ((a & M) * (b & M)) & M


def _shr(a, n):
    return (a & M) >> n


def variant_index(x, y, floor, count):
    """与 board.ts 的 variantIndex 逐位一致（Math.imul + >>> 语义）。"""
    if count <= 1:
        return 0
    h = (0x9E3779B9 ^ _imul(x + 1, 0x85EBCA6B) ^ _imul(y + 1, 0xC2B2AE35)
         ^ _imul(floor + 1, 0x27D4EB2F)) & M
    h = _imul(h ^ _shr(h, 15), 0x2545F491)
    h = (h ^ _shr(h, 13)) & M
    return h % count


def main():
    manifest = json.load(open(os.path.join(ROOT, 'assets/MANIFEST.json')))
    sheet = Image.open(os.path.join(ROOT, 'assets/atlas/terrain.png')).convert('RGBA')
    counts = manifest['meta'].get('terrainVariants', {})

    def tile(key):
        e = manifest['terrain'][key]
        return sheet.crop((e['x'], e['y'], e['x'] + e['w'], e['y'] + e['h']))

    def variant_keys(family, count):
        return [family] + [f'{family}:{i}' for i in range(1, count)]

    # ── 造一屏：11×11 的空地，外加一堵 3 行高的墙 ──────────────────
    def render(use_variants, floor=1):
        n = 11
        S = 16
        out = Image.new('RGBA', (n * S, n * S), (0, 0, 0, 0))
        fkeys = variant_keys('0', counts.get('0', 1))
        wkeys = variant_keys('1', counts.get('1', 1))
        tkeys = variant_keys('1:top', counts.get('1:top', 1))
        for y in range(n):
            for x in range(n):
                if 2 <= y <= 4 and 1 <= x <= 9:
                    if y == 2:
                        keys = tkeys
                    else:
                        keys = wkeys
                else:
                    keys = fkeys
                idx = variant_index(x, y, floor, len(keys)) if use_variants else 0
                out.paste(tile(keys[idx]), (x * S, y * S))
        return out

    Z = 3
    a = render(False)
    b = render(True)
    gap = 12
    W = a.width * Z * 2 + gap
    H = a.height * Z
    canvas = Image.new('RGBA', (W, H), (255, 255, 255, 255))
    canvas.paste(a.resize((a.width * Z, a.height * Z), Image.NEAREST), (0, 0))
    canvas.paste(b.resize((b.width * Z, b.height * Z), Image.NEAREST), (a.width * Z + gap, 0))
    d = ImageDraw.Draw(canvas)
    d.text((6, 4), 'BEFORE: single tile', fill=(20, 20, 20, 255))
    d.text((a.width * Z + gap + 6, 4), 'AFTER: hashed variants', fill=(20, 20, 20, 255))
    out_path = '/tmp/tiling-preview.png'
    canvas.save(out_path)
    print('saved', out_path, canvas.size)
    print('variant counts:', counts)
    # 变体分布是否均匀 —— 全挤在少数几个上等于没做
    from collections import Counter
    for fam, cnt in (('0', counts.get('0', 1)), ('1', counts.get('1', 1))):
        c = Counter(variant_index(x, y, 1, cnt) for y in range(11) for x in range(11))
        print(f'  family {fam}: {dict(sorted(c.items()))}')


if __name__ == '__main__':
    main()
