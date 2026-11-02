import struct, tempfile, os
from solution import mean_value
recs = [(1000, 1, 2.0), (1000, 2, 9.0), (2000, 1, 4.0), (3000, 1, 6.0)]
p = os.path.join(tempfile.gettempdir(), "vis_sensors.bin")
with open(p, "wb") as f:
    for r in recs: f.write(struct.pack("<QIf", *r))
assert mean_value(p, 1, 1000, 3000) == 3.0
assert mean_value(p, 2, 0, 5000) == 9.0
assert mean_value(p, 3, 0, 5000) is None
open(p, "wb").close(); assert mean_value(p, 1, 0, 10) is None
print("visible tests passed")
