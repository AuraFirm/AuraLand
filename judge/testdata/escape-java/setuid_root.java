// Expected: becoming root fails; exit 3 if a privilege-gaining command succeeded.
public class Main {
    public static void main(String[] args) throws Exception {
        for (String[] command : new String[][] {{"/usr/bin/sudo", "-n", "true"}, {"/usr/bin/su", "-c", "true", "root"}}) {
            try {
                Process p = new ProcessBuilder(command).redirectErrorStream(true).start();
                if (p.waitFor() == 0) System.exit(3);
            } catch (Exception e) { }
        }
        System.exit(0);
    }
}
