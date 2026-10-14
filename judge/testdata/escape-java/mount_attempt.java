// Expected: mount fails (no capability); exit code 3 means a mount succeeded.
public class Main {
    public static void main(String[] args) throws Exception {
        try {
            Process p = new ProcessBuilder("/bin/mount", "-t", "tmpfs", "none", "/tmp").redirectErrorStream(true).start();
            System.exit(p.waitFor() == 0 ? 3 : 0);
        } catch (Exception e) { System.exit(0); }
    }
}
