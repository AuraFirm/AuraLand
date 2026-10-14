// Expected: unshare of new namespaces fails or is already confined; exit 3 means it created one.
public class Main {
    public static void main(String[] args) throws Exception {
        try {
            Process p = new ProcessBuilder("/usr/bin/unshare", "--user", "--mount", "/bin/true").redirectErrorStream(true).start();
            System.exit(p.waitFor() == 0 ? 3 : 0);
        } catch (Exception e) { System.exit(0); }
    }
}
