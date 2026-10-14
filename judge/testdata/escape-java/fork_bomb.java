// Expected: contained by the process and thread limit. Verdict RTE (no native thread can be created) or TLE or MLE.
public class Main {
    public static void main(String[] args) throws Exception {
        for (;;) {
            Thread t = new Thread(() -> { try { Thread.sleep(1_000_000); } catch (InterruptedException e) { } });
            t.start();
        }
    }
}
