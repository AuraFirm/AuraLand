// Expected: cannot signal other processes; exit 3 if signalling init succeeded (signal 0 only, nothing is sent).
public class Main {
    public static void main(String[] args) throws Exception {
        try {
            Process p = new ProcessBuilder("/bin/kill", "-0", "1").redirectErrorStream(true).start();
            System.exit(p.waitFor() == 0 ? 3 : 0);
        } catch (Exception e) { System.exit(0); }
    }
}
