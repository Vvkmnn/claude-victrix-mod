import struct

def mean_value(path, sensor, start_ms, end_ms):
    with open(path, "rb") as f:
        data = f.read()
    total = 0.0
    n = 0
    for ts, sid, val in struct.iter_unpack("<QIf", data):
        if sid == sensor and start_ms <= ts < end_ms:
            total += val
            n += 1
    return total / n if n else None
