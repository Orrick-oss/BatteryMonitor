# PNG 严格校验器: 逐块验证签名/长度/CRC/zlib
import zlib, struct, os, sys, glob

def check(path):
    with open(path, 'rb') as f:
        data = f.read()
    print('---', os.path.basename(path), len(data), 'bytes')
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        print('  签名错误!')
        return False
    pos = 8
    ok = True
    while pos < len(data):
        if pos + 8 > len(data):
            print('  截断')
            ok = False
            break
        length = struct.unpack('>I', data[pos:pos+4])[0]
        ctype = data[pos+4:pos+8].decode('latin1')
        chunk = data[pos+8:pos+8+length]
        if pos + 12 + length > len(data):
            print('  块越界')
            ok = False
            break
        crc_stored = struct.unpack('>I', data[pos+8+length:pos+12+length])[0]
        crc_calc = zlib.crc32(ctype.encode('latin1') + chunk) & 0xffffffff
        status = 'OK' if crc_calc == crc_stored else 'CRC损坏!'
        print(f'  块 {ctype} len={length} crc={status}')
        if crc_calc != crc_stored:
            ok = False
        if ctype == 'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', chunk[:10])
            print(f'    尺寸 {w}x{h} 位深{bd} 颜色类型{ct}')
            if w == 0 or h == 0:
                print('    尺寸非法!')
                ok = False
        if ctype == 'IDAT':
            try:
                raw = zlib.decompress(chunk)
                print(f'    zlib 解压 OK, {len(raw)} 字节原始数据')
            except Exception as e:
                print('    zlib 解压失败:', e)
                ok = False
        pos += 12 + length
        if ctype == 'IEND':
            break
    print('  结论:', 'PNG 完全有效' if ok else 'PNG 已损坏 ❌')
    return ok

paths = sys.argv[1:] or glob.glob(r'D:/BatteryMonitor/app/tools/sample-*.png')
results = [check(p) for p in paths]
print('总计:', sum(results), '/', len(results), '有效')
