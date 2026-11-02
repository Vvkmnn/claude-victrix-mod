public final class Solution {
    // Valid iff length 10, chars 0-2 in 'A'..'Z', char 3 '-', chars 4-9 in '0'..'9'.
    // Unsigned-subtract trick: (c - lo) as unsigned < range, exact for all 16-bit chars.
    private static boolean valid(String s) {
        return s.length() == 10 && ok(s);
    }

    private static boolean ok(String s) {
        int a = s.charAt(0) - 'A', b = s.charAt(1) - 'A', c = s.charAt(2) - 'A';
        if ((a | b | c) < 0 || a > 25 || b > 25 || c > 25) return false;
        if (s.charAt(3) != '-') return false;
        int d = 0, bad = 0;
        for (int i = 4; i < 10; i++) {
            d = s.charAt(i) - '0';
            bad |= d | (9 - d);   // negative iff d<0 or d>9
        }
        return bad >= 0;
    }

    private static long count(String[] ids, int from, int to) {
        long n = 0;
        for (int i = from; i < to; i++) if (valid(ids[i])) n++;
        return n;
    }

    public static long countValid(String[] ids) {
        return count(ids, 0, ids.length);
    }
}
