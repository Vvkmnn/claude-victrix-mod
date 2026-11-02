public class VisibleTest {
    public static void main(String[] a) {
        String[] t = {"ABC-123456", "abc-123456", "AB-1234567", "ABC-12345", "ABC-1234567", "ABC_123456", ""};
        if (Solution.countValid(t) != 1) throw new AssertionError("case 1");
        System.out.println("visible tests passed");
    }
}
