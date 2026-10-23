# 任务栏截图工具 (ctypes + GDI, 零依赖, 输出 BMP)
import ctypes, ctypes.wintypes as wt
import sys

gdi32 = ctypes.windll.gdi32
user32 = ctypes.windll.user32

def capture(x, y, w, h, out):
    hdc_screen = user32.GetDC(0)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    hbm = gdi32.CreateCompatibleBitmap(hdc_screen, w, h)
    gdi32.SelectObject(hdc_mem, hbm)
    gdi32.BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, x, y, 0x00CC0020)  # SRCCOPY

    class BMIH(ctypes.Structure):
        _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32),
                    ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
                    ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
                    ("biSizeImage", ctypes.c_uint32), ("xppm", ctypes.c_int32),
                    ("yppm", ctypes.c_int32), ("clrUsed", ctypes.c_uint32),
                    ("clrImp", ctypes.c_uint32)]
    bmi = BMIH()
    bmi.biSize = ctypes.sizeof(BMIH)
    bmi.biWidth = w
    bmi.biHeight = -h  # top-down
    bmi.biPlanes = 1
    bmi.biBitCount = 24
    bmi.biCompression = 0
    row = ((w * 3 + 3) // 4) * 4
    buf = ctypes.create_string_buffer(row * h)
    gdi32.GetDIBits(hdc_mem, hbm, 0, h, buf, ctypes.byref(bmi), 0)

    # BMP 文件: 14B header + 40B info + 像素(BGR, 底行在前)
    pixels = bytearray(buf.raw)
    rows = [pixels[r * row:(r + 1) * row] for r in range(h)]
    bmp_body = b"".join(reversed(rows))
    size = 54 + len(bmp_body)
    header = bytearray(54)
    header[0:2] = b"BM"
    header[2:6] = size.to_bytes(4, "little")
    header[10:14] = (54).to_bytes(4, "little")
    header[14:18] = (40).to_bytes(4, "little")
    header[18:22] = w.to_bytes(4, "little")
    header[22:26] = h.to_bytes(4, "little")
    header[26:28] = (1).to_bytes(2, "little")
    header[28:30] = (24).to_bytes(2, "little")
    with open(out, "wb") as f:
        f.write(bytes(header) + bmp_body)
    gdi32.DeleteObject(hbm)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(0, hdc_screen)
    print("saved", out)

if __name__ == "__main__":
    x, y, w, h = (int(v) for v in sys.argv[1:5])
    capture(x, y, w, h, sys.argv[5])
