# icocheck.py — 严格校验 ICO 文件结构（经典 BMP 格式）
import struct, sys, glob

def check(path):
    data = open(path, 'rb').read()
    print('---', path.split('/')[-1].split('\\')[-1], len(data), 'bytes')
    # ICONDIR
    reserved, itype, count = struct.unpack('<HHH', data[:6])
    assert reserved == 0 and itype == 1, 'ICONDIR 错误'
    print(f'  ICONDIR: type={itype} 图像数={count}')
    # ICONDIRENTRY
    w, h, colors, r, planes, bitcnt, size_in_res, offset = struct.unpack('<BBBBHHII', data[6:22])
    print(f'  ENTRY: {w}x{h} planes={planes} bpp={bitcnt} bytes={size_in_res} offset={offset}')
    assert offset == 22, '偏移应为 22'
    img = data[offset:offset + size_in_res]
    assert len(img) == size_in_res, '图像数据截断'
    # BITMAPINFOHEADER
    bih_size, bw, bh, bplanes, bbitcnt, bcomp, bsizeimg = struct.unpack('<IiiHHII', img[:24])
    print(f'  BIH: size={bih_size} {bw}x{bh}(双倍高) bpp={bbitcnt} comp={bcomp} sizeImage={bsizeimg}')
    assert bih_size == 40 and bh == h * 2 and bbitcnt == 32 and bcomp == 0, 'BIH 字段异常'
    stride = bw * 4
    mask_stride = ((bw + 31) // 32) * 4
    assert bsizeimg == stride * h + mask_stride * h, 'sizeImage 与实际不符'
    xor = img[40:40 + stride * h]
    andm = img[40 + stride * h:]
    # 像素回读: 顶行(=绘制坐标 y=0)在倒数第 1 行
    def pix(x, y):
        row = h - 1 - y
        i = row * stride + x * 4
        b, g, r_, a = xor[i], xor[i+1], xor[i+2], xor[i+3]
        return (r_, g, b, a)
    opaque = sum(1 for i in range(3, len(xor), 4) if xor[i] == 255)
    print(f'  不透明像素: {opaque}/{bw*h}')
    print('  中心(25,32):', pix(25, 32), '| 框(10,19):', pix(10, 19), '| 背景(2,2):', pix(2, 2))
    # AND 掩码非全零（有透明区域才正常）
    nz = any(andm)
    print('  AND掩码含透明位:', '是 ✓' if nz else '否(全不透明)')
    print('  结论: ICO 结构有效 ✓')

for p in sys.argv[1:] or sorted(glob.glob(r'D:/BatteryMonitor/app/tools/*.ico')):
    try:
        check(p)
    except Exception as e:
        print(f'  ❌ {p}: {e}')
