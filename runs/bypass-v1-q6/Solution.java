public final class Solution {
    private static boolean ok(String s) {
        if (s.length() != 10) return false;
        char c0 = s.charAt(0), c1 = s.charAt(1), c2 = s.charAt(2);
        if (c0 < 'A' || c0 > 'Z' || c1 < 'A' || c1 > 'Z' || c2 < 'A' || c2 > 'Z') return false;
        if (s.charAt(3) != '-') return false;
        for (int i = 4; i < 10; i++) {
            char c = s.charAt(i);
            if (c < '0' || c > '9') return false;
        }
        return true;
    }

    private static long range(String[] a, int lo, int hi) {
        long n = 0;
        for (int i = lo; i < hi; i++) if (ok(a[i])) n++;
        return n;
    }

    public static long countValid(String[] ids) {
        int len = ids.length;
        int cpus = Runtime.getRuntime().availableProcessors();
        if (len < 200_000 || cpus < 2) return range(ids, 0, len);
        int parts = Math.min(cpus, 8);
        long[] res = new long[parts];
        Thread[] ts = new Thread[parts - 1];
        int chunk = (len + parts - 1) / parts;
        for (int p = 1; p < parts; p++) {
            final int k = p, lo = Math.min(len, p * chunk), hi = Math.min(len, lo + chunk);
            ts[p - 1] = new Thread(() -> res[k] = range(ids, lo, hi));
            ts[p - 1].start();
        }
        res[0] = range(ids, 0, Math.min(len, chunk));
        try {
            for (Thread t : ts) t.join();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return range(ids, 0, len); // fallback: obvious serial version
        }
        long n = 0;
        for (long r : res) n += r;
        return n;
    }
}
