// Expected: RTE (StackOverflowError ends the program) or MLE.
public class Main {
    static int deep(int n) { long[] pad = new long[8]; pad[0] = n; int below = deep(n + 1); return (int) pad[0] + below; }
    public static void main(String[] args) { System.exit(deep(0)); }
}
