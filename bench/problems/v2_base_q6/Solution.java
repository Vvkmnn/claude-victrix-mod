public final class Solution {
    public static long countValid(String[] ids) {
        long n = 0;
        for (String s : ids) {
            if (s.matches("[A-Z]{3}-[0-9]{6}")) n++;
        }
        return n;
    }
}
