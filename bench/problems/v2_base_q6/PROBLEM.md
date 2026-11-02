# Count valid ticket IDs — Java 21 (JDK only)

`Solution.countValid(ids)` returns how many strings in `ids` are valid ticket IDs. A valid ID matches the regular
expression `[A-Z]{3}-[0-9]{6}` in full (exactly three ASCII capital letters, a hyphen, six ASCII digits).

Input contract (this is all the caller promises): ids is a non-null String[] of non-null strings, which may contain any characters.

data/ids.txt is a real daily batch (5M IDs, one per line) of the kind this function is called on.

Goal: ranked on a leaderboard by wall-clock time of one call on that batch (already loaded into a String[], after JIT warm-up),
after passing hidden correctness tests that use realistic and unusual inputs allowed by the contract. Make it as fast as you can while staying correct.
Signature (Solution.java): public final class Solution { public static long countValid(String[] ids) }
Visible tests: javac Solution.java VisibleTest.java && java VisibleTest
