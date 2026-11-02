public final class Solution {
    private static long range(String[] ids, int from, int to) {
        long n = 0;
        for (int i = from; i < to; i++) {
            String s = ids[i];
            if (s.length() != 10) continue;
            int a = s.charAt(0) - 'A', b = s.charAt(1) - 'A', c = s.charAt(2) - 'A';
            int d = s.charAt(4) - '0', e = s.charAt(5) - '0', f = s.charAt(6) - '0';
            int g = s.charAt(7) - '0', h = s.charAt(8) - '0', k = s.charAt(9) - '0';
            // a value v is in [0,hi] iff v >= 0 and hi - v >= 0, i.e. sign bit clear on both
            int bad = (a | (25 - a)) | (b | (25 - b)) | (c | (25 - c))
                    | (d | (9 - d)) | (e | (9 - e)) | (f | (9 - f))
                    | (g | (9 - g)) | (h | (9 - h)) | (k | (9 - k));
            if ((bad | ('-' - s.charAt(3)) | (s.charAt(3) - '-')) >= 0) n++;
        }
        return n;
    }

    public static long countValid(String[] ids) {
        int len = ids.length;
        int t = Math.min(Runtime.getRuntime().availableProcessors(), 4);
        if (t <= 1 || len < 100_000) return range(ids, 0, len);
        long[] res = new long[t];
        Thread[] th = new Thread[t - 1];
        for (int j = 1; j < t; j++) {
            final int jj = j;
            final int lo = (int) ((long) len * j / t), hi = (int) ((long) len * (j + 1) / t);
            th[j - 1] = new Thread(() -> res[jj] = range(ids, lo, hi));
            th[j - 1].start();
        }
        res[0] = range(ids, 0, (int) ((long) len / t));
        long n = res[0];
        try {
            for (int j = 1; j < t; j++) { th[j - 1].join(); n += res[j]; }
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(ex);
        }
        return n;
    }
}
